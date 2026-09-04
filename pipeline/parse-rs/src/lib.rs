//! Shared replay-parse core for the w3warehouse backend tools.
//!
//! One w3grs parse implementation, two I/O frontends: `parse` (local .w3g →
//! local JSON, for the host-native dev loop) and `drain` (MinIO/S3 raw → parsed,
//! the object-store worker + batch reparse). Both call [`parse_replay`]; only the
//! naming and storage differ.
use w3grs::{ParserOutput, W3GReplay};

/// Parser output version. `drain` writes parsed docs under `parsed/v<N>/…` so a
/// parser schema/extraction change gets a fresh prefix — re-derivation is then
/// incremental (re-drain raw-archive/ under the new prefix) instead of stale
/// v<N-1> JSON silently serving. Bump on ANY change to what parse_replay emits,
/// together with the v<N> hand-copies in compose.yaml (STREAM_URL), the justfile
/// `reparse` recipe, and scripts/test_stream.sh —
/// services/api/tests/test_landing_predicates.py pins all of them to this const.
pub const PARSE_VERSION: u32 = 2;

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
