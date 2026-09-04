//! Parse one or more .w3g replays via w3grs and write JSON results.
//! usage: parse [--force] <out-dir> <in.w3g>...
//!
//! Drop-in replacement for the former w3gjs `parse.ts`: the same `{stem}.json`
//! output (stem = basename minus a trailing `.w3g`), the same
//! `status\tinput\toutput` TSV line per file on stdout, and the same always-exit-0
//! behaviour so one corrupt replay can't abort a batch. w3grs emits the same
//! canonical JSON as w3gjs (verified 500/500 byte-identical, parseTime aside), so
//! the ClickHouse loader (`db/w3g/load.sql`, `views.sql`) consumes it unchanged.
//!
//! Incremental by default: an input whose destination JSON already exists and is
//! at least as new as the .w3g is skipped (`skip` status line), so an append run
//! costs O(new), not O(corpus). `--force` reparses regardless — the pipeline
//! passes it under REBUILD=1, which is the documented path for picking up parser
//! upgrades (docs/plan-ingestion-architecture.md, "parser evolution is not
//! incremental").
//!
//! The w3grs parse itself lives in the crate lib ([`w3warehouse_parse::parse_replay`]),
//! shared with the `drain` bin. Parallelism is the caller's job (pipeline.sh fans
//! these across cores with `xargs -P`); this binary stays single-process.
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process;

use w3warehouse_parse::parse_replay;

fn main() {
    let mut args: Vec<String> = std::env::args().collect();
    let force = args.get(1).is_some_and(|a| a == "--force");
    if force {
        args.remove(1);
    }
    if args.len() < 3 {
        eprintln!("usage: parse [--force] <out-dir> <in.w3g>...");
        process::exit(2);
    }
    let out_dir = &args[1];
    let inputs = &args[2..];

    if let Err(e) = fs::create_dir_all(out_dir) {
        eprintln!("failed to create {out_dir}: {e}");
        process::exit(2);
    }

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let (mut ok, mut skipped, mut fail) = (0u64, 0u64, 0u64);

    for input in inputs {
        let dst = format!("{out_dir}/{}.json", stem_of(input));
        if !force && up_to_date(input, &dst) {
            let _ = writeln!(out, "skip\t{input}\t{dst}");
            skipped += 1;
            continue;
        }
        match parse_one(input, &dst) {
            Ok(()) => {
                let _ = writeln!(out, "ok\t{input}\t{dst}");
                ok += 1;
            }
            // Single-line message so the status line stays < PIPE_BUF and the
            // caller's `grep '^fail'` survives xargs -P interleaving.
            Err(msg) => {
                let _ = writeln!(out, "fail\t{input}\t{}", msg.replace('\n', " "));
                fail += 1;
            }
        }
    }
    let _ = out.flush();
    eprintln!(
        "parsed {ok}/{} replays ({skipped} up-to-date, {fail} failed)",
        inputs.len()
    );
}

fn parse_one(input: &str, dst: &str) -> Result<(), String> {
    let bytes = fs::read(input).map_err(|e| format!("read {input}: {e}"))?;
    let parsed = parse_replay(&bytes)?;
    fs::write(dst, parsed.json).map_err(|e| format!("write {dst}: {e}"))
}

/// Destination JSON exists and is at least as new as the source .w3g. A dst
/// whose mtimes can't be read still counts as current — `--force` (REBUILD=1)
/// is the escape hatch, never a re-parse loop on an exotic filesystem.
fn up_to_date(src: &str, dst: &str) -> bool {
    let Ok(dst_meta) = fs::metadata(dst) else {
        return false;
    };
    match (fs::metadata(src).and_then(|m| m.modified()), dst_meta.modified()) {
        (Ok(src_mtime), Ok(dst_mtime)) => dst_mtime >= src_mtime,
        _ => true,
    }
}

/// basename minus a trailing `.w3g` (case-insensitive), matching parse.ts's
/// `basename(input).replace(/\.w3g$/i, "")`. Only `.w3g` is stripped — the
/// pipeline finds `-iname '*.w3g'`, so that's the only suffix seen.
fn stem_of(input: &str) -> String {
    let base = Path::new(input)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| input.to_string());
    match base.len() {
        n if n >= 4 && base[n - 4..].eq_ignore_ascii_case(".w3g") => base[..n - 4].to_string(),
        _ => base,
    }
}

#[cfg(test)]
mod tests {
    use super::{stem_of, up_to_date};
    use std::fs;
    use std::time::{Duration, SystemTime};

    #[test]
    fn up_to_date_gates_on_existence_and_mtime() {
        let dir = std::env::temp_dir().join(format!("parse-rs-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("r.w3g");
        let dst = dir.join("r.json");
        let (src_s, dst_s) = (src.to_str().unwrap(), dst.to_str().unwrap());

        fs::write(&src, b"w3g").unwrap();
        // no dst yet → parse
        assert!(!up_to_date(src_s, dst_s));

        // dst written after src → skip
        fs::write(&dst, b"{}").unwrap();
        assert!(up_to_date(src_s, dst_s));

        // dst older than src (re-staged replay) → parse again
        let past = SystemTime::now() - Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(&dst)
            .unwrap()
            .set_modified(past)
            .unwrap();
        assert!(!up_to_date(src_s, dst_s));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stem_strips_only_trailing_w3g_case_insensitively() {
        assert_eq!(stem_of("/a/b/12345.w3g"), "12345");
        assert_eq!(stem_of("/a/b/12345.W3G"), "12345");
        assert_eq!(stem_of("ColorFul_Life Springtime 13.w3g"), "ColorFul_Life Springtime 13");
        // not a .w3g suffix → left intact (mirrors the JS regex anchored at $)
        assert_eq!(stem_of("/a/replay.w3g.bak"), "replay.w3g.bak");
        assert_eq!(stem_of("noext"), "noext");
    }
}
