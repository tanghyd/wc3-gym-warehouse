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
//! `status/<series id>/game<n>.json` holding the raw object's ETag, so a pass
//! processes a key only when it has no breadcrumb or the ETag has changed.
//!
//! The object key carries the GNL series and game number, and the drain writes
//! them into the parsed document as a `gnl` object.
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

/// `<prefix>replays/<series id>/game<n>.w3g` → (series id, game number). Any
/// other shape answers None and the drain skips the key.
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
            if parse_key(&raw_prefix, key).is_none() {
                log(&format!("skipping {key}: not {raw_prefix}<series id>/game<n>.w3g"));
                return false;
            }
            done.get(key) != Some(etag)
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

async fn process_one(client: &Client, cfg: &Cfg, raw_key: &str, etag: &str) -> Result<(), String> {
    let bucket = &cfg.bucket;
    let (series_id, game_no) =
        parse_key(&cfg.raw(), raw_key).ok_or("key does not name a series and game")?;
    let status_key = status_key(cfg, raw_key);
    let bytes = get_object(client, bucket, raw_key).await?;

    let parsed = match w3warehouse_parse::parse_replay(&bytes) {
        Ok(p) => p,
        Err(error) => {
            // Won't ever parse — record it so the next pass skips the key.
            let status =
                serde_json::json!({"state":"failed","key":raw_key,"etag":etag,"error":error});
            put_json(client, bucket, &status_key, &status).await?;
            log(&format!("parse FAILED {raw_key}: {error}"));
            return Ok(());
        }
    };
    if parsed.replay_id.is_empty() {
        return Err("parsed doc has no id".to_string());
    }

    // The GNL series and game number ride in the document so ClickHouse reads
    // them out of the same s3() load as every other field.
    let mut doc: serde_json::Value =
        serde_json::from_str(&parsed.json).map_err(|e| e.to_string())?;
    doc.as_object_mut()
        .ok_or("parsed doc is not a JSON object")?
        .insert(
            "gnl".to_string(),
            serde_json::json!({"series_id": series_id, "game_no": game_no}),
        );

    // Land the parsed doc content-addressed by replay id under the parser-version
    // prefix (PARSE_VERSION in lib.rs) so a parser change re-derives incrementally.
    let date = chrono::Utc::now().format("%Y-%m-%d");
    put_bytes(
        client,
        bucket,
        &format!(
            "{}parsed/v{}/dt={date}/{}.json",
            cfg.prefix,
            w3warehouse_parse::PARSE_VERSION,
            parsed.replay_id
        ),
        serde_json::to_vec(&doc).map_err(|e| e.to_string())?,
    )
    .await?;

    let status = serde_json::json!({
        "state":"parsed","key":raw_key,"etag":etag,
        "replay_id":parsed.replay_id,"type":parsed.replay_type,
    });
    put_json(client, bucket, &status_key, &status).await?;
    log(&format!(
        "parsed {raw_key} → {} (series={series_id} game={game_no} type={})",
        parsed.replay_id,
        if parsed.replay_type.is_empty() { "?" } else { &parsed.replay_type }
    ));
    Ok(())
}

/// Raw key → the ETag recorded for it, read from every `status/` breadcrumb.
/// A listing carries the breadcrumb's own ETag, not the replay's, so each body
/// is fetched; the fetches run at the pass concurrency.
async fn read_breadcrumbs(client: &Client, cfg: &Cfg) -> Result<HashMap<String, String>, String> {
    let keys = list_prefix(client, &cfg.bucket, &cfg.status()).await?;
    let bodies = stream::iter(keys)
        .map(|(key, _)| async move { get_object(client, &cfg.bucket, &key).await })
        .buffer_unordered(cfg.concurrency)
        .collect::<Vec<_>>()
        .await;
    let mut map = HashMap::new();
    for body in bodies {
        let doc: serde_json::Value = serde_json::from_slice(&body?).map_err(|e| e.to_string())?;
        if let (Some(k), Some(e)) = (doc["key"].as_str(), doc["etag"].as_str()) {
            map.insert(k.to_string(), e.to_string());
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
    fn a_prefix_normalises_to_one_trailing_slash() {
        assert_eq!(normalise_prefix(""), "");
        assert_eq!(normalise_prefix("  "), "");
        assert_eq!(normalise_prefix("preview"), "preview/");
        assert_eq!(normalise_prefix("/preview/"), "preview/");
    }
}
