//! Shared replay-parse core for the w3warehouse backend tools.
//!
//! One w3grs parse implementation, two I/O frontends: `parse` (local .w3g →
//! local JSON, for the host-native dev loop) and `drain` (MinIO/S3 raw → parsed,
//! the object-store worker + batch reparse). Both call [`parse_replay`]; only the
//! naming and storage differ.
use w3grs::{ParserOutput, W3GReplay};

/// Parser output version. Bump it on any change to what the drain writes. `drain`
/// writes parsed docs under `parsed/v<N>/…`, stamps N into each as `parse_version`
/// (the version raw_replays keeps the newest of) and on each status breadcrumb,
/// so after a bump the next pass re-parses every raw replay into the new prefix.
/// The one hand copy is W3WAREHOUSE_PARSED_URL in .env and .env.example, the
/// prefix ClickHouse loads; change it with the bump.
pub const PARSE_VERSION: u32 = 5;

/// A parsed replay: the canonical JSON doc the ClickHouse loader consumes, plus
/// the `id` / `type` lifted from the typed output so callers don't re-extract
/// them from the JSON string.
pub struct Parsed {
    pub json: String,
    pub replay_id: String,
    pub replay_type: String,
}

/// Parse one .w3g byte buffer. A fresh `W3GReplay` per call mirrors w3gjs's
/// `new W3GReplay()` per file — no cross-replay state bleed. Errors are stringified
/// so callers can log/record them without a parser-specific error type.
pub fn parse_replay(bytes: &[u8]) -> Result<Parsed, String> {
    let output: ParserOutput = W3GReplay::new().parse_bytes(bytes).map_err(|e| e.to_string())?;
    let replay_id = output.id.clone();
    let replay_type = output.game_type.clone();
    let json = serde_json::to_string(&output).map_err(|e| e.to_string())?;
    Ok(Parsed {
        json,
        replay_id,
        replay_type,
    })
}
