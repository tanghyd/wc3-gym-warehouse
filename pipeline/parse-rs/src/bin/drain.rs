//! drain — the parse hop. Reads `.w3g` objects from the bucket's `replays/`
//! prefix, parses each via w3grs, and writes the parsed JSON to
//! `parsed/v<PARSE_VERSION>/dt=<date>/<replay_id>.json`, the prefix ClickHouse
//! reads with s3() (db/w3g/backfill.sql).
//!
//! The GNL backend writes every key under its Vercel environment, so a real key
//! is `preview/replays/12/game1.w3g` (wc3-gym-backend app/services/r2.py). Set
//! W3WAREHOUSE_S3_PREFIX to that leading segment and all three prefixes move
//! together, which keeps one environment's parsed output out of another's.
//!
//! A raw object is never moved or deleted: the site's download URLs point at it.
//! Work already done is recorded by a breadcrumb at
//! `status/<series id>/game<n>.json` holding the raw object's ETag and the
//! PARSE_VERSION that wrote it, so a pass processes a key only when it has no
//! breadcrumb, the ETag has changed or the breadcrumb has another version.
//!
//! The drain writes the raw object key into the parsed document as `source_key`.
//! A GNL key also carries the series and game number, written as a `gnl` object.
//!
//! Two run modes: default loops every WORKER_POLL_MS as a SINGLE instance (two
//! instances race on the same keys); `--once` drains the bucket once and exits.
//!
//! Within a pass, objects are processed concurrently (DRAIN_CONCURRENCY) — the
//! per-object cost is S3 round-trips, not CPU, so concurrency is the speedup.
use std::collections::HashMap;
use std::time::Duration;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;
use futures::stream::{self, StreamExt};
use w3warehouse_parse::PARSE_VERSION;

const RAW: &str = "replays/";
const STATUS: &str = "status/";

struct Cfg {
    bucket: String,
    poll: Duration,
    concurrency: usize,
    /// Leading segment on every key, such as "preview/". Empty for a flat bucket.
    prefix: String,
}

impl Cfg {
    fn raw(&self) -> String {
        format!("{}{RAW}", self.prefix)
    }
    fn status(&self) -> String {
        format!("{}{STATUS}", self.prefix)
    }
}

/// Normalise W3WAREHOUSE_S3_PREFIX: empty stays empty, anything else ends in "/".
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
    let once = std::env::args().any(|a| a == "--once");

    // Endpoint is "host:port"; the scheme comes from W3WAREHOUSE_S3_SECURE.
    let endpoint = env_or("W3WAREHOUSE_S3_ENDPOINT", "minio:9000");
    let secure = env_or("W3WAREHOUSE_S3_SECURE", "false") == "true";
    let scheme = if secure { "https" } else { "http" };
    let access = env_or("W3WAREHOUSE_S3_ACCESS_KEY", "minioadmin");
    let secret = env_or("W3WAREHOUSE_S3_SECRET_KEY", "minioadmin");
    let cfg = Cfg {
        bucket: env_or("W3WAREHOUSE_S3_BUCKET", "warehouse"),
        poll: Duration::from_millis(env_or("WORKER_POLL_MS", "3000").parse().unwrap_or(3000)),
        concurrency: env_or("DRAIN_CONCURRENCY", "16").parse().unwrap_or(16),
        prefix: normalise_prefix(&env_or("W3WAREHOUSE_S3_PREFIX", "")),
    };

    let creds = Credentials::new(access, secret, None, None, "w3warehouse-env");
    let conf = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new("us-east-1")) // dummy; MinIO ignores it
        .endpoint_url(format!("{scheme}://{endpoint}"))
        .force_path_style(true) // MinIO needs path-style addressing
        .credentials_provider(creds)
        .build();
    let client = Client::from_conf(conf);

    if once {
        let n = drain_once(&client, &cfg).await;
        log(&format!("drained {n} object(s), exiting (--once)"));
        return;
    }
    log(&format!(
        "watching {}/{} every {}ms (concurrency={})",
        cfg.bucket,
        cfg.raw(),
        cfg.poll.as_millis(),
        cfg.concurrency
    ));
    loop {
        let _ = drain_once(&client, &cfg).await;
        tokio::time::sleep(cfg.poll).await;
    }
}

/// Every `.w3g` under `<prefix>replays/` is a replay to parse.
fn is_replay(raw_prefix: &str, key: &str) -> bool {
    key.starts_with(raw_prefix) && key.ends_with(".w3g")
}

/// `<prefix>replays/<series id>/game<n>.w3g` → (series id, game number), the
/// key the GNL backend writes. Any other replay (such as `replays/local/...`)
/// answers None and gets no `gnl` field.
fn parse_key(raw_prefix: &str, key: &str) -> Option<(u32, u8)> {
    let rest = key.strip_prefix(raw_prefix)?;
    let (series, game) = rest.split_once('/')?;
    let n = game.strip_prefix("game")?.strip_suffix(".w3g")?;
    if n.len() != 1 || !series.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((series.parse().ok()?, n.parse().ok()?))
}

/// The breadcrumb for a raw key: `replays/12/game2.w3g` → `status/12/game2.json`.
fn status_key(cfg: &Cfg, raw_key: &str) -> String {
    let rest = raw_key.strip_prefix(&cfg.raw()).unwrap_or(raw_key);
    format!("{}{}.json", cfg.status(), rest.strip_suffix(".w3g").unwrap_or(rest))
}

/// A breadcrumb body: what happened to a raw key, at which ETag and parser version.
fn breadcrumb(state: &str, raw_key: &str, etag: &str) -> serde_json::Value {
    serde_json::json!({
        "state": state, "key": raw_key, "etag": etag, "parse_version": PARSE_VERSION,
    })
}

/// True when a breadcrumb covers this ETag under this parser version.
fn up_to_date(crumb: &serde_json::Value, etag: &str) -> bool {
    crumb["etag"].as_str() == Some(etag)
        && crumb["parse_version"].as_u64() == Some(PARSE_VERSION.into())
}

/// Process every new or changed `replays/` object once, concurrently. Returns
/// how many were handled; transient S3 errors leave the key to retry next pass.
async fn drain_once(client: &Client, cfg: &Cfg) -> usize {
    let done = match read_breadcrumbs(client, cfg).await {
        Ok(m) => m,
        Err(e) => {
            log(&format!("status list error, will retry: {e}"));
            return 0;
        }
    };
    let raw = match list_prefix(client, &cfg.bucket, &cfg.raw()).await {
        Ok(k) => k,
        Err(e) => {
            log(&format!("list error, will retry: {e}"));
            return 0;
        }
    };
    let raw_prefix = cfg.raw();
    let todo: Vec<(String, String)> = raw
        .into_iter()
        .filter(|(key, etag)| {
            if !is_replay(&raw_prefix, key) {
                log(&format!("skipping {key}: not a .w3g under {raw_prefix}"));
                return false;
            }
            !done.get(key).is_some_and(|crumb| up_to_date(crumb, etag))
        })
        .collect();

    let outcomes = stream::iter(todo)
        .map(|(key, etag)| async move {
            match process_one(client, cfg, &key, &etag).await {
                Ok(()) => true,
                Err(e) => {
                    // Transient (network/S3): no breadcrumb written, retry next pass.
                    log(&format!("error on {key}, will retry: {e}"));
                    false
                }
            }
        })
        .buffer_unordered(cfg.concurrency)
        .collect::<Vec<_>>()
        .await;
    outcomes.into_iter().filter(|ok| *ok).count()
}

/// The doc the drain writes: w3grs's JSON plus `source_key`, and `gnl` for a GNL
/// key, so ClickHouse reads them out of the same s3() load as every other field.
fn landed_doc(
    json: &str,
    raw_key: &str,
    gnl: Option<(u32, u8)>,
) -> Result<serde_json::Value, String> {
    let mut doc: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let fields = doc.as_object_mut().ok_or("parsed doc is not a JSON object")?;
    fields.insert("source_key".to_string(), raw_key.into());
    if let Some((series_id, game_no)) = gnl {
        fields.insert(
            "gnl".to_string(),
            serde_json::json!({"series_id": series_id, "game_no": game_no}),
        );
    }
    Ok(doc)
}

async fn process_one(client: &Client, cfg: &Cfg, raw_key: &str, etag: &str) -> Result<(), String> {
    let bucket = &cfg.bucket;
    let gnl = parse_key(&cfg.raw(), raw_key);
    let status_key = status_key(cfg, raw_key);
    let bytes = get_object(client, bucket, raw_key).await?;

    let parsed = match w3warehouse_parse::parse_replay(&bytes) {
        Ok(p) => p,
        Err(error) => {
            // Won't parse with this parser: skip the key until its ETag or PARSE_VERSION changes.
            let mut status = breadcrumb("failed", raw_key, etag);
            status["error"] = error.as_str().into();
            put_json(client, bucket, &status_key, &status).await?;
            log(&format!("parse FAILED {raw_key}: {error}"));
            return Ok(());
        }
    };
    if parsed.replay_id.is_empty() {
        return Err("parsed doc has no id".to_string());
    }

    let doc = landed_doc(&parsed.json, raw_key, gnl)?;

    // Land the parsed doc content-addressed by replay id under the parser-version
    // prefix (PARSE_VERSION in lib.rs) so a parser change re-derives incrementally.
    let date = chrono::Utc::now().format("%Y-%m-%d");
    put_bytes(
        client,
        bucket,
        &format!(
            "{}parsed/v{}/dt={date}/{}.json",
            cfg.prefix,
            PARSE_VERSION,
            parsed.replay_id
        ),
        serde_json::to_vec(&doc).map_err(|e| e.to_string())?,
    )
    .await?;

    let mut status = breadcrumb("parsed", raw_key, etag);
    status["replay_id"] = parsed.replay_id.as_str().into();
    status["type"] = parsed.replay_type.as_str().into();
    put_json(client, bucket, &status_key, &status).await?;
    log(&format!(
        "parsed {raw_key} → {} ({} type={})",
        parsed.replay_id,
        gnl.map_or("not GNL".to_string(), |(s, g)| format!("series={s} game={g}")),
        if parsed.replay_type.is_empty() { "?" } else { &parsed.replay_type }
    ));
    Ok(())
}

/// Raw key → its breadcrumb, read from every `status/` object. A listing carries
/// the breadcrumb's own ETag, not the replay's, so each body is fetched; the
/// fetches run at the pass concurrency.
async fn read_breadcrumbs(
    client: &Client,
    cfg: &Cfg,
) -> Result<HashMap<String, serde_json::Value>, String> {
    let keys = list_prefix(client, &cfg.bucket, &cfg.status()).await?;
    let bodies = stream::iter(keys)
        .map(|(key, _)| async move { get_object(client, &cfg.bucket, &key).await })
        .buffer_unordered(cfg.concurrency)
        .collect::<Vec<_>>()
        .await;
    let mut map = HashMap::new();
    for body in bodies {
        let doc: serde_json::Value = serde_json::from_slice(&body?).map_err(|e| e.to_string())?;
        if let Some(k) = doc["key"].as_str().map(str::to_string) {
            map.insert(k, doc);
        }
    }
    Ok(map)
}

/// Every key under a prefix with its ETag, quotes stripped.
async fn list_prefix(
    client: &Client,
    bucket: &str,
    prefix: &str,
) -> Result<Vec<(String, String)>, String> {
    let mut keys = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut req = client.list_objects_v2().bucket(bucket).prefix(prefix);
        if let Some(t) = &token {
            req = req.continuation_token(t);
        }
        let resp = req.send().await.map_err(|e| e.to_string())?;
        for obj in resp.contents() {
            if let Some(k) = obj.key() {
                let etag = obj.e_tag().unwrap_or_default().trim_matches('"').to_string();
                keys.push((k.to_string(), etag));
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
        .map_err(|e| e.to_string())?;
    let data = resp.body.collect().await.map_err(|e| e.to_string())?;
    Ok(data.into_bytes().to_vec())
}

async fn put_bytes(client: &Client, bucket: &str, key: &str, body: Vec<u8>) -> Result<(), String> {
    client
        .put_object()
        .bucket(bucket)
        .key(key)
        .body(ByteStream::from(body))
        .content_type("application/json")
        .send()
        .await
        .map_err(|e| e.to_string())
        .map(|_| ())
}

async fn put_json(
    client: &Client,
    bucket: &str,
    key: &str,
    value: &serde_json::Value,
) -> Result<(), String> {
    put_bytes(client, bucket, key, value.to_string().into_bytes()).await
}

fn log(msg: &str) {
    println!("[drain] {msg}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(prefix: &str) -> Cfg {
        Cfg {
            bucket: "b".into(),
            poll: Duration::from_millis(1),
            concurrency: 1,
            prefix: normalise_prefix(prefix),
        }
    }

    #[test]
    fn keys_parse_and_map_to_breadcrumbs() {
        let c = cfg("");
        assert_eq!(parse_key(&c.raw(), "replays/12/game2.w3g"), Some((12, 2)));
        assert_eq!(parse_key(&c.raw(), "replays/x/notes.txt"), None);
        assert_eq!(parse_key(&c.raw(), "replays/12/game2.txt"), None);
        assert_eq!(parse_key(&c.raw(), "replays/12/notgame2.w3g"), None);
        assert_eq!(status_key(&c, "replays/12/game2.w3g"), "status/12/game2.json");
    }

    #[test]
    fn any_w3g_under_replays_is_drained_and_only_gnl_keys_carry_a_series() {
        let c = cfg("preview");
        let local = "preview/replays/local/Autosaved/Multiplayer/w3c-20260922152242.w3g";
        assert!(is_replay(&c.raw(), local));
        assert_eq!(parse_key(&c.raw(), local), None);
        assert_eq!(status_key(&c, local), "preview/status/local/Autosaved/Multiplayer/w3c-20260922152242.json");
        assert!(is_replay(&c.raw(), "preview/replays/435/game1.w3g"));
        assert!(!is_replay(&c.raw(), "preview/replays/local/notes.txt"));
        assert!(!is_replay(&c.raw(), "production/replays/435/game1.w3g"));
    }

    #[test]
    fn the_environment_prefix_moves_every_path() {
        let c = cfg("preview");
        assert_eq!(c.raw(), "preview/replays/");
        assert_eq!(c.status(), "preview/status/");
        assert_eq!(parse_key(&c.raw(), "preview/replays/435/game1.w3g"), Some((435, 1)));
        // Another environment's keys are not this drain's work.
        assert_eq!(parse_key(&c.raw(), "production/replays/435/game1.w3g"), None);
        assert_eq!(
            status_key(&c, "preview/replays/435/game1.w3g"),
            "preview/status/435/game1.json"
        );
    }

    #[test]
    fn a_key_is_done_only_at_the_same_etag_and_parser_version() {
        let key = "preview/replays/435/game1.w3g";
        assert!(up_to_date(&breadcrumb("parsed", key, "e1"), "e1"));
        assert!(up_to_date(&breadcrumb("failed", key, "e1"), "e1"));
        assert!(!up_to_date(&breadcrumb("parsed", key, "e1"), "e2"));
        // A breadcrumb from before parse_version, or from another version, re-parses.
        let old = serde_json::json!({"state": "parsed", "key": key, "etag": "e1"});
        assert!(!up_to_date(&old, "e1"));
        let mut other = breadcrumb("parsed", key, "e1");
        other["parse_version"] = (PARSE_VERSION - 1).into();
        assert!(!up_to_date(&other, "e1"));
    }

    #[test]
    fn the_landed_doc_carries_the_raw_key_and_gnl_only_for_a_gnl_key() {
        let key = "preview/replays/435/game1.w3g";
        let gnl = landed_doc(r#"{"id":"r1"}"#, key, Some((435, 1))).unwrap();
        assert_eq!(gnl["id"], "r1");
        assert_eq!(gnl["source_key"], key);
        assert_eq!(gnl["gnl"], serde_json::json!({"series_id": 435, "game_no": 1}));
        let local = landed_doc(r#"{"id":"r2"}"#, "preview/replays/local/w3c-1.w3g", None).unwrap();
        assert_eq!(local["source_key"], "preview/replays/local/w3c-1.w3g");
        assert!(local.get("gnl").is_none());
        assert!(landed_doc("[]", "k", None).is_err());
    }

    #[test]
    fn a_prefix_normalises_to_one_trailing_slash() {
        assert_eq!(normalise_prefix(""), "");
        assert_eq!(normalise_prefix("  "), "");
        assert_eq!(normalise_prefix("preview"), "preview/");
        assert_eq!(normalise_prefix("/preview/"), "preview/");
    }
}
