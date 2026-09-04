//! drain — the parse hop of the object-store path. Reads .w3g objects from MinIO/S3
//! `landing/raw/`, parses each via w3grs, and writes the parsed JSON to
//! `landing/parsed/dt=<date>/<replay_id>.json` — the prefix ClickHouse ingests
//! (S3Queue in db/w3g/stream.sql, or one-shot s3() in db/w3g/backfill.sql).
//!
//! Replaces the former worker.ts. Same contract: `raw/` is the work queue (no
//! cursor, no state table); a parsed object is content-addressed by the
//! deterministic replay id, and the raw object is MOVED to `raw-archive/` LAST so
//! a crash mid-process just re-parses on restart (the replay_id gate downstream
//! makes re-delivery a no-op). A `status/<filehash>.json` breadcrumb bridges the
//! upload's filehash → replay_id for the dashboard's upload UI to poll.
//!
//! Two run modes — same drain, different trigger (see the worker-architecture
//! decision): default loops every WORKER_POLL_MS (the streaming worker, run as a
//! SINGLE instance — no replica race); `--once` drains the inbox once and exits
//! (the batch reparse step: mirror_raw.sh → drain --once → backfill.sql).
//!
//! Within a pass, objects are processed concurrently (DRAIN_CONCURRENCY) — the
//! per-object cost is S3 round-trips, not CPU, so concurrency is the speedup.
use std::time::Duration;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;
use futures::stream::{self, StreamExt};

const RAW: &str = "raw/";
const STATUS: &str = "status/";
const ARCHIVE: &str = "raw-archive/";
const FAILED: &str = "raw-failed/";

struct Cfg {
    bucket: String,
    poll: Duration,
    concurrency: usize,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

#[tokio::main]
async fn main() {
    let once = std::env::args().any(|a| a == "--once");

    // Endpoint is "host:port" (the minio-py convention the api/worker share).
    let endpoint = env_or("W3WAREHOUSE_S3_ENDPOINT", "minio:9000");
    let secure = env_or("W3WAREHOUSE_S3_SECURE", "false") == "true";
    let scheme = if secure { "https" } else { "http" };
    let access = env_or("W3WAREHOUSE_S3_ACCESS_KEY", "minioadmin");
    let secret = env_or("W3WAREHOUSE_S3_SECRET_KEY", "minioadmin");
    let cfg = Cfg {
        bucket: env_or("W3WAREHOUSE_S3_BUCKET", "landing"),
        poll: Duration::from_millis(env_or("WORKER_POLL_MS", "3000").parse().unwrap_or(3000)),
        concurrency: env_or("DRAIN_CONCURRENCY", "16").parse().unwrap_or(16),
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

    ensure_bucket(&client, &cfg.bucket).await;

    if once {
        let n = drain_once(&client, &cfg).await;
        log(&format!("drained {n} object(s), exiting (--once)"));
        return;
    }
    log(&format!(
        "watching {}/{RAW} every {}ms (concurrency={})",
        cfg.bucket,
        cfg.poll.as_millis(),
        cfg.concurrency
    ));
    loop {
        let _ = drain_once(&client, &cfg).await;
        tokio::time::sleep(cfg.poll).await;
    }
}

/// Process every `raw/*.w3g` once, concurrently. Returns how many were handled
/// (parsed or failed); transient S3 errors leave the object in place to retry.
async fn drain_once(client: &Client, cfg: &Cfg) -> usize {
    let keys = match list_raw(client, &cfg.bucket).await {
        Ok(k) => k,
        Err(e) => {
            log(&format!("list error, will retry: {e}"));
            return 0;
        }
    };
    let outcomes = stream::iter(keys)
        .map(|key| async move {
            match process_one(client, &cfg.bucket, &key).await {
                Ok(()) => true,
                Err(e) => {
                    // Transient (network/S3): leave raw in place, retry next pass.
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

async fn process_one(client: &Client, bucket: &str, raw_key: &str) -> Result<(), String> {
    // raw/{filehash}.w3g → filehash (the upload handle the UI polls).
    let name = raw_key.strip_prefix(RAW).unwrap_or(raw_key);
    let file_hash = name
        .strip_suffix(".w3g")
        .or_else(|| name.strip_suffix(".W3G"))
        .unwrap_or(name)
        .to_string();

    let bytes = get_object(client, bucket, raw_key).await?;

    let parsed = match w3warehouse_parse::parse_replay(&bytes) {
        Ok(p) => p,
        Err(error) => {
            // Won't ever parse — record for the UI and evict from the inbox.
            let status = serde_json::json!({"state":"failed","file_hash":file_hash,"error":error});
            put_json(client, bucket, &format!("{STATUS}{file_hash}.json"), &status).await?;
            move_object(client, bucket, raw_key, &format!("{FAILED}{file_hash}.w3g")).await?;
            log(&format!("parse FAILED {file_hash}: {error}"));
            return Ok(());
        }
    };
    if parsed.replay_id.is_empty() {
        return Err("parsed doc has no id".to_string());
    }

    // Land the parsed doc on the S3Queue prefix, content-addressed by replay id
    // under the parser-version prefix (see PARSE_VERSION in lib.rs) so a parser
    // change re-derives incrementally instead of serving stale JSON.
    let date = chrono::Utc::now().format("%Y-%m-%d");
    put_bytes(
        client,
        bucket,
        &format!(
            "parsed/v{}/dt={date}/{}.json",
            w3warehouse_parse::PARSE_VERSION,
            parsed.replay_id
        ),
        parsed.json.into_bytes(),
    )
    .await?;

    // Breadcrumb: filehash → replay_id (+ type) bridge for the upload UI.
    let status = serde_json::json!({
        "state":"parsed","file_hash":file_hash,
        "replay_id":parsed.replay_id,"type":parsed.replay_type,
    });
    put_json(client, bucket, &format!("{STATUS}{file_hash}.json"), &status).await?;

    // Evict from the inbox LAST, so a crash before this re-parses safely.
    move_object(client, bucket, raw_key, &format!("{ARCHIVE}{file_hash}.w3g")).await?;
    log(&format!(
        "parsed {file_hash} → {} (type={})",
        parsed.replay_id,
        if parsed.replay_type.is_empty() { "?" } else { &parsed.replay_type }
    ));
    Ok(())
}

async fn list_raw(client: &Client, bucket: &str) -> Result<Vec<String>, String> {
    let mut keys = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut req = client.list_objects_v2().bucket(bucket).prefix(RAW);
        if let Some(t) = &token {
            req = req.continuation_token(t);
        }
        let resp = req.send().await.map_err(|e| e.to_string())?;
        for obj in resp.contents() {
            if let Some(k) = obj.key() {
                if k.to_lowercase().ends_with(".w3g") {
                    keys.push(k.to_string());
                }
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

/// Move = server-side copy + delete. copy_source is "<bucket>/<key>"; raw keys are
/// simple ascii (filehash.w3g), so no URL-encoding is needed.
async fn move_object(client: &Client, bucket: &str, src: &str, dst: &str) -> Result<(), String> {
    client
        .copy_object()
        .bucket(bucket)
        .key(dst)
        .copy_source(format!("{bucket}/{src}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    client
        .delete_object()
        .bucket(bucket)
        .key(src)
        .send()
        .await
        .map_err(|e| e.to_string())
        .map(|_| ())
}

async fn ensure_bucket(client: &Client, bucket: &str) {
    // minio-setup usually creates it, but on a cold `up` the drain may win the
    // race — create defensively, retrying so it doesn't die racing MinIO startup.
    loop {
        if client.head_bucket().bucket(bucket).send().await.is_ok() {
            return;
        }
        match client.create_bucket().bucket(bucket).send().await {
            Ok(_) => {
                log(&format!("created bucket {bucket}"));
                return;
            }
            Err(e) => {
                log(&format!("waiting for minio: {e}"));
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

fn log(msg: &str) {
    println!("[drain] {msg}");
}
