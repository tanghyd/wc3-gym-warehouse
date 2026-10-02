//! drain: the parse hop. Every run is one pass (`drain --once`), started by
//! `just local::ingest` or a host cron.
//!
//! For each source bucket it LISTs the replay prefix (1,000 keys a page), compares
//! every `.w3g` with its row in ClickHouse's `ingest.files`, GETs and parses each new
//! or changed object, and INSERTs the parsed document into `ingest.docs` and the
//! outcome into `ingest.files`, BATCH rows at a time, over HTTP as the `ingest` user.
//! dbt reads `ingest.docs`.
//!
//! An object is current when its row has the same size, the same PARSE_VERSION and
//! the same ETag (LastModified when the listing gives no ETag). So a re-upload or a
//! parser bump re-parses on the next run. A file that fails to parse gets a row with
//! the error and waits for such a change. A failed LIST, GET or INSERT writes no row,
//! so the next run retries the key.
//!
//! The drain never writes to a source bucket: its key may be read-only. A raw object
//! is never moved or deleted, because download URLs point at it.
//!
//! Sources: the W3WAREHOUSE_S3_* set, listed at `<W3WAREHOUSE_S3_PREFIX>/replays/`,
//! then the W3WAREHOUSE_SOURCE2_* set when W3WAREHOUSE_SOURCE2_BUCKET is set, listed
//! at `<W3WAREHOUSE_SOURCE2_PREFIX>/`. A source's name in ClickHouse is its bucket.
//!
//! The document is w3grs's JSON plus the raw object key as `source_key`, the
//! listing's LastModified as `source_last_modified` (a replay header holds no date,
//! so this is when the replay was added) and `parse_version`.
//!
//! Within a pass, objects are fetched and parsed DRAIN_CONCURRENCY at a time.
use std::collections::HashMap;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::Client;
use aws_smithy_types::date_time::Format;
use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use w3warehouse_parse::PARSE_VERSION;

/// Rows per INSERT: 500 documents of about 8 KB each.
const BATCH: usize = 500;

/// One bucket the drain reads.
#[derive(Debug, PartialEq)]
struct Source {
    /// The bucket, also the `source` column in ClickHouse.
    bucket: String,
    /// Scheme, host and port, such as "http://minio:9000".
    endpoint: String,
    access_key: String,
    secret_key: String,
    /// The key prefix the drain lists, such as "preview/replays/". Empty lists the bucket.
    prefix: String,
}

/// The sources from the environment: the W3WAREHOUSE_S3_* set, then the
/// W3WAREHOUSE_SOURCE2_* set when W3WAREHOUSE_SOURCE2_BUCKET is set.
fn sources(env: impl Fn(&str) -> Option<String>) -> Vec<Source> {
    let read = |set: &str, prefix: String| {
        let var = |name: &str, default: &str| env(&format!("{set}_{name}")).unwrap_or(default.to_string());
        let scheme = if var("SECURE", "false") == "true" { "https" } else { "http" };
        Source {
            bucket: var("BUCKET", "warehouse"),
            endpoint: format!("{scheme}://{}", var("ENDPOINT", "minio:9000")),
            access_key: var("ACCESS_KEY", "minioadmin"),
            secret_key: var("SECRET_KEY", "minioadmin"),
            prefix,
        }
    };
    let env_prefix = |set: &str| normalise_prefix(&env(&format!("{set}_PREFIX")).unwrap_or_default());
    let mut out = vec![read("W3WAREHOUSE_S3", format!("{}replays/", env_prefix("W3WAREHOUSE_S3")))];
    if env("W3WAREHOUSE_SOURCE2_BUCKET").is_some_and(|b| !b.is_empty()) {
        out.push(read("W3WAREHOUSE_SOURCE2", env_prefix("W3WAREHOUSE_SOURCE2")));
    }
    out
}

/// Normalise a key prefix: empty stays empty, anything else ends in "/".
fn normalise_prefix(raw: &str) -> String {
    let t = raw.trim().trim_matches('/');
    if t.is_empty() {
        String::new()
    } else {
        format!("{t}/")
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

#[tokio::main]
async fn main() {
    if std::env::args().skip(1).any(|a| a != "--once") {
        eprintln!("usage: drain [--once]   (every run is one pass)");
        std::process::exit(2);
    }
    let ch = ClickHouse {
        http: reqwest::Client::new(),
        url: env_or("CLICKHOUSE_URL", "http://clickhouse:8123"),
        password: env_or("CLICKHOUSE_INGEST_PASSWORD", ""),
    };
    let concurrency = env_or("DRAIN_CONCURRENCY", "16").parse().unwrap_or(16);
    let mut tally = Tally::default();
    let mut failed = false;
    for src in sources(|k| std::env::var(k).ok()) {
        if let Err(e) = drain_source(&ch, &src, concurrency, &mut tally).await {
            log(&format!("{}: {e}; the next run retries", src.bucket));
            failed = true;
        }
    }
    // `just local::ingest` reads this line: dbt builds when a document was inserted.
    log(&format!(
        "inserted {} doc(s), {} failed parse(s), {} to retry",
        tally.docs, tally.failed, tally.retry
    ));
    if failed {
        std::process::exit(1);
    }
}

#[derive(Default)]
struct Tally {
    docs: usize,
    failed: usize,
    retry: usize,
}

/// One source: read its ingest.files rows, LIST, parse what changed, INSERT in batches.
async fn drain_source(ch: &ClickHouse, src: &Source, concurrency: usize, tally: &mut Tally) -> Result<(), String> {
    let seen = ch.seen(&src.bucket).await?;
    let client = &s3_client(src);
    let listed = list_prefix(client, &src.bucket, &src.prefix).await?;
    let n = listed.len();
    let todo: Vec<Listed> = listed
        .into_iter()
        .filter(|o| {
            if !o.key.ends_with(".w3g") {
                log(&format!("skipping {}: not a .w3g", o.key));
                return false;
            }
            needs_parse(o, seen.get(&o.key))
        })
        .collect();
    log(&format!(
        "{}/{}: {n} listed, {} in ingest.files, {} to parse",
        src.bucket,
        src.prefix,
        seen.len(),
        todo.len()
    ));

    let mut batches = stream::iter(todo)
        .map(|o| async move {
            let outcome = process_one(client, src, &o).await;
            (o.key, outcome)
        })
        .buffer_unordered(concurrency)
        .chunks(BATCH);
    while let Some(batch) = batches.next().await {
        let (mut files, mut docs) = (Vec::new(), Vec::new());
        for (key, outcome) in batch {
            match outcome {
                Ok((file, doc)) => {
                    tally.failed += usize::from(!file.error.is_empty());
                    files.push(file);
                    docs.extend(doc);
                }
                Err(e) => {
                    log(&format!("error on {key}, the next run retries: {e}"));
                    tally.retry += 1;
                }
            }
        }
        // Docs first: a failed files INSERT re-parses those keys next run, and the
        // repeated docs collapse on (source, key).
        ch.insert("ingest.docs", &docs).await?;
        ch.insert("ingest.files", &files).await?;
        tally.docs += docs.len();
    }
    Ok(())
}

/// One object of a bucket listing.
struct Listed {
    key: String,
    /// The ETag, quotes stripped.
    etag: String,
    /// When the bucket last wrote the object, RFC 3339 in UTC, or "" when the listing gives none.
    modified: String,
    /// The same time in Unix milliseconds, 0 when the listing gives none.
    modified_ms: i64,
    size: u64,
}

/// An object's row in ingest.files, as the drain compares it.
#[derive(Deserialize)]
struct Seen {
    key: String,
    etag: String,
    modified_ms: i64,
    size: u64,
    parse_version: u32,
}

/// True when a listed object has no current row: no row, another size or PARSE_VERSION,
/// or another ETag (LastModified when the listing gives no ETag). A failed parse has a
/// row, so it waits for such a change like any other key.
fn needs_parse(o: &Listed, seen: Option<&Seen>) -> bool {
    seen.is_none_or(|s| {
        s.parse_version != PARSE_VERSION
            || s.size != o.size
            || if o.etag.is_empty() { s.modified_ms != o.modified_ms } else { s.etag != o.etag }
    })
}

/// Key -> row from ingest.files JSONEachRow. A line that does not decode is logged and
/// skipped, so its key counts as new and is parsed again.
fn parse_seen(body: &str) -> HashMap<String, Seen> {
    let mut map = HashMap::new();
    for line in body.lines().filter(|l| !l.trim().is_empty()) {
        match serde_json::from_str::<Seen>(line) {
            Ok(s) => {
                map.insert(s.key.clone(), s);
            }
            Err(e) => log(&format!("skipping a bad ingest.files row ({e}): {:.200}", line)),
        }
    }
    map
}

/// An ingest.files row: what the drain did with one object.
#[derive(Serialize)]
struct FileRow {
    source: String,
    key: String,
    etag: String,
    source_last_modified: String,
    size: u64,
    parse_version: u32,
    /// Empty when the parse failed.
    replay_id: String,
    /// Why the parse gave no document, empty when it gave one.
    error: String,
}

/// An ingest.docs row: one parsed document.
#[derive(Serialize)]
struct DocRow {
    source: String,
    key: String,
    etag: String,
    source_last_modified: String,
    parse_version: u32,
    doc: String,
}

/// GET and parse one object: its ingest.files row, and its ingest.docs row when the
/// parse gave a document. Err is a failed GET.
async fn process_one(client: &Client, src: &Source, o: &Listed) -> Result<(FileRow, Option<DocRow>), String> {
    let bytes = get_object(client, &src.bucket, &o.key).await?;
    // DateTime64 cannot read "", so a listing with no time stores the epoch.
    let modified = if o.modified.is_empty() { "1970-01-01T00:00:00Z" } else { &o.modified };
    let mut file = FileRow {
        source: src.bucket.clone(),
        key: o.key.clone(),
        etag: o.etag.clone(),
        source_last_modified: modified.to_string(),
        size: o.size,
        parse_version: PARSE_VERSION,
        replay_id: String::new(),
        error: String::new(),
    };
    match parsed_doc(&bytes, o) {
        Ok((replay_id, doc)) => {
            log(&format!("parsed {} → {replay_id}", o.key));
            file.replay_id = replay_id;
            let doc = DocRow {
                source: file.source.clone(),
                key: file.key.clone(),
                etag: file.etag.clone(),
                source_last_modified: file.source_last_modified.clone(),
                parse_version: PARSE_VERSION,
                doc,
            };
            Ok((file, Some(doc)))
        }
        Err(error) => {
            log(&format!("parse FAILED {}: {error}", o.key));
            file.error = error;
            Ok((file, None))
        }
    }
}

/// Parse a raw file into its replay id and document text; Err says why there is none.
fn parsed_doc(bytes: &[u8], o: &Listed) -> Result<(String, String), String> {
    let parsed = w3warehouse_parse::parse_replay(bytes)?;
    if parsed.replay_id.is_empty() {
        return Err("parsed doc has no id".to_string());
    }
    let doc = landed_doc(&parsed.json, o)?;
    Ok((parsed.replay_id, doc.to_string()))
}

/// The document the drain inserts: w3grs's JSON plus `source_key`, `source_last_modified`
/// and `parse_version`, so dbt reads them like every other field.
fn landed_doc(json: &str, raw: &Listed) -> Result<serde_json::Value, String> {
    let mut doc: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let fields = doc.as_object_mut().ok_or("parsed doc is not a JSON object")?;
    fields.insert("source_key".to_string(), raw.key.as_str().into());
    fields.insert("source_last_modified".to_string(), raw.modified.as_str().into());
    fields.insert("parse_version".to_string(), PARSE_VERSION.into());
    Ok(doc)
}

/// ClickHouse over HTTP as the `ingest` user, which may only SELECT and INSERT on ingest.*.
struct ClickHouse {
    http: reqwest::Client,
    url: String,
    password: String,
}

impl ClickHouse {
    async fn post(&self, params: &[(&str, &str)], body: Vec<u8>) -> Result<String, String> {
        let url = reqwest::Url::parse_with_params(&self.url, params).map_err(|e| e.to_string())?;
        let resp = self
            .http
            .post(url)
            .header("X-ClickHouse-User", "ingest")
            .header("X-ClickHouse-Key", &self.password)
            .body(body)
            .send()
            .await
            .map_err(|e| format!("ClickHouse: {e}"))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| format!("ClickHouse: {e}"))?;
        if status.is_success() {
            Ok(text)
        } else {
            Err(format!("ClickHouse {status}: {}", text.trim()))
        }
    }

    /// The source's ingest.files rows, merged, keyed by object key.
    async fn seen(&self, source: &str) -> Result<HashMap<String, Seen>, String> {
        let query = "SELECT key, etag, toUnixTimestamp64Milli(source_last_modified) AS modified_ms, size, \
                     parse_version FROM ingest.files FINAL WHERE source = {source:String} FORMAT JSONEachRow";
        let params = [("param_source", source), ("output_format_json_quote_64bit_integers", "0")];
        Ok(parse_seen(&self.post(&params, query.as_bytes().to_vec()).await?))
    }

    /// One INSERT of every row, as JSONEachRow. No rows, no request.
    async fn insert<T: Serialize>(&self, table: &str, rows: &[T]) -> Result<(), String> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut body = Vec::new();
        for row in rows {
            serde_json::to_writer(&mut body, row).map_err(|e| e.to_string())?;
            body.push(b'\n');
        }
        let query = format!("INSERT INTO {table} FORMAT JSONEachRow");
        // best_effort reads the listing's RFC 3339 times into DateTime64.
        let params = [("query", query.as_str()), ("date_time_input_format", "best_effort")];
        self.post(&params, body).await.map(|_| ())
    }
}

fn s3_client(src: &Source) -> Client {
    let creds = Credentials::new(&src.access_key, &src.secret_key, None, None, "w3warehouse-env");
    let conf = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new("us-east-1")) // dummy; MinIO and R2 ignore it
        .endpoint_url(&src.endpoint)
        .force_path_style(true) // MinIO needs path-style addressing
        .credentials_provider(creds)
        .build();
    Client::from_conf(conf)
}

/// Every object under a prefix, 1,000 keys a page.
async fn list_prefix(client: &Client, bucket: &str, prefix: &str) -> Result<Vec<Listed>, String> {
    let mut keys = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut req = client.list_objects_v2().bucket(bucket).prefix(prefix).max_keys(1000);
        if let Some(t) = &token {
            req = req.continuation_token(t);
        }
        let resp = req.send().await.map_err(|e| format!("LIST {bucket}/{prefix}: {e}"))?;
        for obj in resp.contents() {
            if let Some(k) = obj.key() {
                let modified = obj.last_modified();
                keys.push(Listed {
                    key: k.to_string(),
                    etag: obj.e_tag().unwrap_or_default().trim_matches('"').to_string(),
                    modified: modified.and_then(|t| t.fmt(Format::DateTime).ok()).unwrap_or_default(),
                    modified_ms: modified.and_then(|t| t.to_millis().ok()).unwrap_or(0),
                    size: obj.size().unwrap_or(0).max(0) as u64,
                });
            }
        }
        if resp.is_truncated() == Some(true) {
            token = resp.next_continuation_token().map(str::to_string);
        } else {
            break;
        }
    }
    Ok(keys)
}

async fn get_object(client: &Client, bucket: &str, key: &str) -> Result<Vec<u8>, String> {
    let resp = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| format!("GET: {e}"))?;
    let data = resp.body.collect().await.map_err(|e| format!("GET: {e}"))?;
    Ok(data.into_bytes().to_vec())
}

fn log(msg: &str) {
    println!("[drain] {msg}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listed(key: &str, etag: &str, size: u64) -> Listed {
        Listed {
            key: key.into(),
            etag: etag.into(),
            modified: "2026-10-01T08:30:00Z".into(),
            modified_ms: 1_791_189_000_000,
            size,
        }
    }

    fn seen(key: &str, etag: &str, size: u64, parse_version: u32) -> Seen {
        Seen {
            key: key.into(),
            etag: etag.into(),
            modified_ms: 1_791_189_000_000,
            size,
            parse_version,
        }
    }

    #[test]
    fn a_key_with_no_row_is_new() {
        assert!(needs_parse(&listed("preview/replays/a.w3g", "e1", 10), None));
    }

    #[test]
    fn a_key_at_the_same_etag_size_and_parser_version_is_unchanged() {
        let o = listed("preview/replays/a.w3g", "e1", 10);
        assert!(!needs_parse(&o, Some(&seen(&o.key, "e1", 10, PARSE_VERSION))));
    }

    #[test]
    fn another_etag_size_or_parser_version_is_changed() {
        let o = listed("preview/replays/a.w3g", "e2", 10);
        assert!(needs_parse(&o, Some(&seen(&o.key, "e1", 10, PARSE_VERSION))));
        let o = listed("preview/replays/a.w3g", "e1", 11);
        assert!(needs_parse(&o, Some(&seen(&o.key, "e1", 10, PARSE_VERSION))));
        let o = listed("preview/replays/a.w3g", "e1", 10);
        assert!(needs_parse(&o, Some(&seen(&o.key, "e1", 10, PARSE_VERSION - 1))));
    }

    #[test]
    fn with_no_etag_the_last_modified_time_decides() {
        let o = listed("preview/replays/a.w3g", "", 10);
        assert!(!needs_parse(&o, Some(&seen(&o.key, "", 10, PARSE_VERSION))));
        let mut moved = seen(&o.key, "", 10, PARSE_VERSION);
        moved.modified_ms += 1000;
        assert!(needs_parse(&o, Some(&moved)));
    }

    #[test]
    fn a_failed_parse_waits_until_its_etag_changes() {
        // A row with an error is a row: the same object is skipped, a re-upload is parsed.
        let rows = parse_seen(&format!(
            r#"{{"key":"preview/replays/bad.w3g","etag":"e1","modified_ms":1791189000000,"size":10,"parse_version":{PARSE_VERSION}}}"#
        ));
        let same = listed("preview/replays/bad.w3g", "e1", 10);
        assert!(!needs_parse(&same, rows.get(&same.key)));
        let reuploaded = listed("preview/replays/bad.w3g", "e2", 10);
        assert!(needs_parse(&reuploaded, rows.get(&reuploaded.key)));
    }

    #[test]
    fn a_bad_ingest_files_row_is_skipped_and_its_key_parses_again() {
        let rows = parse_seen(&format!(
            "{{\"key\":\"k1\",\"etag\":\"e1\",\"modified_ms\":0,\"size\":1,\"parse_version\":{PARSE_VERSION}}}\n\
             not json\n\
             {{\"key\":\"k2\",\"etag\":\"e1\"}}\n"
        ));
        assert_eq!(rows.len(), 1);
        assert!(rows.contains_key("k1"));
        assert!(needs_parse(&listed("k2", "e1", 1), rows.get("k2")));
    }

    #[test]
    fn the_first_source_lists_replays_under_the_environment_prefix() {
        let env: HashMap<&str, &str> = HashMap::from([
            ("W3WAREHOUSE_S3_ENDPOINT", "minio:9000"),
            ("W3WAREHOUSE_S3_BUCKET", "warehouse"),
            ("W3WAREHOUSE_S3_PREFIX", "preview"),
            ("W3WAREHOUSE_S3_ACCESS_KEY", "k"),
            ("W3WAREHOUSE_S3_SECRET_KEY", "s"),
        ]);
        let got = sources(|k| env.get(k).map(|v| v.to_string()));
        assert_eq!(
            got,
            vec![Source {
                bucket: "warehouse".into(),
                endpoint: "http://minio:9000".into(),
                access_key: "k".into(),
                secret_key: "s".into(),
                prefix: "preview/replays/".into(),
            }]
        );
    }

    #[test]
    fn a_second_source_comes_only_with_its_bucket() {
        let mut env: HashMap<&str, &str> = HashMap::from([
            ("W3WAREHOUSE_S3_BUCKET", "warehouse"),
            ("W3WAREHOUSE_SOURCE2_ENDPOINT", "w3c.example:443"),
            ("W3WAREHOUSE_SOURCE2_SECURE", "true"),
            ("W3WAREHOUSE_SOURCE2_PREFIX", "/replays/"),
        ]);
        assert_eq!(sources(|k| env.get(k).map(|v| v.to_string())).len(), 1);
        env.insert("W3WAREHOUSE_SOURCE2_BUCKET", "w3c");
        let got = sources(|k| env.get(k).map(|v| v.to_string()));
        assert_eq!(got.len(), 2);
        assert_eq!(got[1].bucket, "w3c");
        assert_eq!(got[1].endpoint, "https://w3c.example:443");
        assert_eq!(got[1].prefix, "replays/");
    }

    #[test]
    fn the_landed_doc_carries_the_raw_key_its_time_and_the_parser_version() {
        let raw = listed("preview/replays/local/w3c-1.w3g", "e1", 10);
        let doc = landed_doc(r#"{"id":"r1"}"#, &raw).unwrap();
        assert_eq!(doc["id"], "r1");
        assert_eq!(doc["source_key"], raw.key);
        assert_eq!(doc["source_last_modified"], "2026-10-01T08:30:00Z");
        assert_eq!(doc["parse_version"], PARSE_VERSION);
        assert!(landed_doc("[]", &raw).is_err());
    }

    #[test]
    fn a_prefix_normalises_to_one_trailing_slash() {
        assert_eq!(normalise_prefix(""), "");
        assert_eq!(normalise_prefix("  "), "");
        assert_eq!(normalise_prefix("preview"), "preview/");
        assert_eq!(normalise_prefix("/preview/"), "preview/");
    }
}
