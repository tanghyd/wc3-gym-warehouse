//! Empirical action-layout probe (throwaway analysis tool).
//!
//! Walks every replay's decompressed game-data, parses command-block action
//! slices with a *parameterized* length model, and reports how cleanly each
//! block consumes to its declared boundary. The candidate dropped actions
//! (0x02, 0x50, 0x60, 0x62, 0x69, 0x6a, 0x7a, 0x7b) have their payload lengths
//! swept so the length that maximizes corpus-wide clean parsing is the
//! empirical truth.
//!
//! Block framing is copied verbatim from game_data.rs so the walk can't desync.

use std::collections::BTreeMap;
use std::path::Path;

use w3grs::buffer::StatefulBufferParser;
use w3grs::{MetadataParser, RawParser};

#[derive(Clone, Copy)]
struct Opaque {
    l_02: usize,
    l_50: usize,
    l_60_prefix: usize, // then zero-term string
    l_62: usize,
    l_69: usize,
    l_6a: usize,
    l_7a: usize,
    l_7b: usize,
}

impl Default for Opaque {
    fn default() -> Self {
        // current w3grs guesses
        Opaque {
            l_02: 0,
            l_50: 5,
            l_60_prefix: 8,
            l_62: 12,
            l_69: 16,
            l_6a: 16,
            l_7a: 20,
            l_7b: 16,
        }
    }
}

enum Outcome {
    Consumed,
    Unknown,
    Eof,
}

fn zstr(slice: &[u8], off: &mut usize) -> bool {
    let start = *off;
    let mut i = start;
    while i < slice.len() && slice[i] != 0 {
        i += 1;
    }
    if i >= slice.len() {
        return false; // no terminator -> EOF
    }
    *off = i + 1;
    true
}

fn take(slice: &[u8], off: &mut usize, n: usize) -> bool {
    if *off + n > slice.len() {
        return false;
    }
    *off += n;
    true
}

fn u32le(slice: &[u8], off: &mut usize) -> Option<u32> {
    if *off + 4 > slice.len() {
        return None;
    }
    let v = u32::from_le_bytes([
        slice[*off],
        slice[*off + 1],
        slice[*off + 2],
        slice[*off + 3],
    ]);
    *off += 4;
    Some(v)
}

fn cache_desc(slice: &[u8], off: &mut usize) -> bool {
    zstr(slice, off) && zstr(slice, off) && zstr(slice, off)
}

fn cache_unit(slice: &[u8], off: &mut usize) -> bool {
    if !take(slice, off, 4) {
        return false;
    }
    let Some(items) = u32le(slice, off) else {
        return false;
    };
    for _ in 0..items {
        if !take(slice, off, 12) {
            return false;
        }
    }
    // hero data
    if !take(slice, off, 48) {
        return false;
    }
    let Some(abils) = u32le(slice, off) else {
        return false;
    };
    for _ in 0..abils {
        if !take(slice, off, 8) {
            return false;
        }
    }
    if !take(slice, off, 12) {
        return false;
    }
    let Some(dmg) = u32le(slice, off) else {
        return false;
    };
    let Some(dmg_bytes) = (dmg as usize).checked_mul(4) else {
        return false;
    };
    if !take(slice, off, dmg_bytes) {
        return false;
    }
    take(slice, off, 6)
}

fn normalize(id: u8, post202: bool) -> u8 {
    if post202 && id > 0x77 {
        id.saturating_add(1)
    } else {
        id
    }
}

/// Consume one action's payload (id byte already read). `off` points just past id.
fn consume(id: u8, slice: &[u8], off: &mut usize, o: &Opaque) -> Outcome {
    macro_rules! fixed {
        ($n:expr) => {
            if take(slice, off, $n) {
                Outcome::Consumed
            } else {
                Outcome::Eof
            }
        };
    }
    match id {
        0x01 => fixed!(1),
        0x02 => fixed!(o.l_02),
        0x03 => fixed!(1),
        0x04 | 0x05 => Outcome::Consumed,
        0x06 => {
            if zstr(slice, off) && zstr(slice, off) && take(slice, off, 1) {
                Outcome::Consumed
            } else {
                Outcome::Eof
            }
        }
        0x07 => fixed!(4),
        0x10 => fixed!(14),
        0x11 => fixed!(22),
        0x12 => fixed!(30),
        0x13 => fixed!(38),
        0x14 => fixed!(43),
        0x15 => fixed!(51),
        0x16 | 0x17 => {
            // u8 + u16 number_units + units*8
            if *off + 3 > slice.len() {
                return Outcome::Eof;
            }
            let num = u16::from_le_bytes([slice[*off + 1], slice[*off + 2]]) as usize;
            *off += 3;
            if take(slice, off, num * 8) {
                Outcome::Consumed
            } else {
                Outcome::Eof
            }
        }
        0x18 => fixed!(2),
        0x19 => fixed!(12),
        0x1a => Outcome::Consumed,
        0x1b => fixed!(9),
        0x1c => fixed!(9),
        0x1d => fixed!(8),
        0x1e | 0x1f => fixed!(5),
        0x20 => Outcome::Consumed,
        0x21 => fixed!(8),
        0x22..=0x26 => Outcome::Consumed,
        0x27 | 0x28 => fixed!(5),
        0x29..=0x2c => Outcome::Consumed,
        0x2d => fixed!(5),
        0x2e => fixed!(4),
        0x2f => Outcome::Consumed,
        0x50 => fixed!(o.l_50),
        0x51 => fixed!(9),
        0x60 => {
            if take(slice, off, o.l_60_prefix) && zstr(slice, off) {
                Outcome::Consumed
            } else {
                Outcome::Eof
            }
        }
        0x61 => Outcome::Consumed,
        0x62 => fixed!(o.l_62),
        0x63 => fixed!(8),
        0x64 | 0x65 => fixed!(8),
        0x66 | 0x67 => Outcome::Consumed,
        0x68 => fixed!(12),
        0x69 => fixed!(o.l_69),
        0x6a => fixed!(o.l_6a),
        0x6b | 0x6c => {
            if cache_desc(slice, off) && take(slice, off, 4) {
                Outcome::Consumed
            } else {
                Outcome::Eof
            }
        }
        0x6d => {
            if cache_desc(slice, off) && take(slice, off, 1) {
                Outcome::Consumed
            } else {
                Outcome::Eof
            }
        }
        0x6e => {
            if cache_desc(slice, off) && cache_unit(slice, off) {
                Outcome::Consumed
            } else {
                Outcome::Eof
            }
        }
        0x70..=0x73 => {
            if cache_desc(slice, off) {
                Outcome::Consumed
            } else {
                Outcome::Eof
            }
        }
        0x75 => fixed!(1),
        0x76 => fixed!(10),
        0x77 => {
            // u32 cmd, u32 data, u32 len, len bytes
            if !take(slice, off, 8) {
                return Outcome::Eof;
            }
            let Some(len) = u32le(slice, off) else {
                return Outcome::Eof;
            };
            if take(slice, off, len as usize) {
                Outcome::Consumed
            } else {
                Outcome::Eof
            }
        }
        0x78 => {
            if zstr(slice, off) && zstr(slice, off) && take(slice, off, 4) {
                Outcome::Consumed
            } else {
                Outcome::Eof
            }
        }
        0x79 => {
            if take(slice, off, 16) && zstr(slice, off) {
                Outcome::Consumed
            } else {
                Outcome::Eof
            }
        }
        0x7a => fixed!(o.l_7a),
        0x7b => fixed!(o.l_7b),
        0xa0 => fixed!(14),
        0xa1 => fixed!(9),
        _ => Outcome::Unknown,
    }
}

#[derive(Default)]
struct Stats {
    blocks: u64,
    clean: u64,
    unknown: u64,
    truncated: u64,
    // residue when an opaque id is the LAST action of a clean block: id -> (len -> count)
    last_residue: BTreeMap<u8, BTreeMap<usize, u64>>,
}

fn analyze_block(slice: &[u8], post202: bool, o: &Opaque, st: &mut Stats) {
    st.blocks += 1;
    let mut off = 0usize;
    let mut last_id = 0u8;
    let mut last_payload_start = 0usize;
    while off < slice.len() {
        let raw = slice[off];
        let id = normalize(raw, post202);
        off += 1;
        let payload_start = off;
        match consume(id, slice, &mut off, o) {
            Outcome::Consumed => {
                last_id = id;
                last_payload_start = payload_start;
            }
            Outcome::Unknown => {
                st.unknown += 1;
                return;
            }
            Outcome::Eof => {
                st.truncated += 1;
                return;
            }
        }
    }
    // off == slice.len() exactly here (consume never overshoots)
    st.clean += 1;
    if matches!(
        last_id,
        0x02 | 0x50 | 0x60 | 0x62 | 0x69 | 0x6a | 0x7a | 0x7b
    ) {
        let residue = slice.len() - last_payload_start;
        *st.last_residue
            .entry(last_id)
            .or_default()
            .entry(residue)
            .or_default() += 1;
    }
}

fn walk_game_data(game_data: &[u8], post202: bool, o: &Opaque, st: &mut Stats) {
    let mut p = StatefulBufferParser::new(game_data);
    while !p.is_done() {
        let Ok(id) = p.read_u8() else { break };
        match id {
            // leave: hex4 + u8 + hex4 + skip4 = 13
            0x17 if p.skip(13).is_err() => break,
            0x17 => {}
            0x1a..=0x1c if p.skip(4).is_err() => break,
            0x1a..=0x1c => {}
            0x1f | 0x1e => {
                let Ok(byte_count) = p.read_u16_le() else {
                    break;
                };
                let byte_count = byte_count as usize;
                let Ok(_time) = p.read_u16_le() else { break };
                if byte_count < 2 {
                    break;
                }
                let end = p.offset() + (byte_count - 2);
                while p.offset() < end {
                    let Ok(_pid) = p.read_u8() else { break };
                    let Ok(alen) = p.read_u16_le() else { break };
                    let alen = alen as usize;
                    let start = p.offset();
                    let stop = (start + alen).min(p.buffer().len());
                    let slice = &p.buffer()[start..stop];
                    analyze_block(slice, post202, o, st);
                    p.set_offset(start + alen);
                }
            }
            0x20 => {
                // chat: pid u8, u16 byte_count, u8 flags, [u32 if flags==0x20], zstr
                let Ok(_pid) = p.read_u8() else { break };
                let Ok(_bc) = p.read_u16_le() else { break };
                let Ok(flags) = p.read_u8() else { break };
                if flags == 0x20 && p.skip(4).is_err() {
                    break;
                }
                if p.read_zero_term_string().is_err() {
                    break;
                }
            }
            0x22 => {
                let Ok(len) = p.read_u8() else { break };
                if p.skip(len as isize).is_err() {
                    break;
                }
            }
            0x23 if p.skip(10).is_err() => break,
            0x23 => {}
            0x2f if p.skip(8).is_err() => break,
            0x2f => {}
            _ => {} // unknown block id: consumed 1 byte, continue (matches lib)
        }
    }
}

fn collect_replays(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                collect_replays(&p, out);
            } else if let Some(ext) = p.extension().and_then(|x| x.to_str()) {
                if ext == "w3g" || ext == "nwg" {
                    out.push(p);
                }
            }
        }
    }
}

fn run_corpus(replays: &[std::path::PathBuf], o: &Opaque) -> Stats {
    let mut st = Stats::default();
    for path in replays {
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        let Ok(raw) = RawParser::new().parse(&bytes) else {
            continue;
        };
        let Ok(md) = MetadataParser::new().parse(&raw.blocks) else {
            continue;
        };
        walk_game_data(&md.game_data, md.is_post_202_replay_format, o, &mut st);
    }
    st
}

fn main() {
    let dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "fixtures/replays".to_string());
    let mut replays = Vec::new();
    collect_replays(Path::new(&dir), &mut replays);
    replays.sort();
    eprintln!("found {} replays under {dir}", replays.len());

    // 1) baseline with current guesses
    let base = run_corpus(&replays, &Opaque::default());
    println!("=== BASELINE (current w3grs guesses) ===");
    println!(
        "blocks={} clean={} ({:.4}%) unknown_id={} truncated={}",
        base.blocks,
        base.clean,
        100.0 * base.clean as f64 / base.blocks as f64,
        base.unknown,
        base.truncated
    );
    println!("--- residue-when-last (opaque id is final action of a clean block) ---");
    for (id, hist) in &base.last_residue {
        let total: u64 = hist.values().sum();
        let modes: Vec<String> = hist.iter().map(|(l, c)| format!("len{l}:{c}")).collect();
        println!("  0x{id:02x}: n={total}  {}", modes.join("  "));
    }

    // 2) per-opaque length sweep: vary one id's length, hold others at guess,
    //    report clean count vs length. Peak = empirical true length.
    println!("\n=== LENGTH SWEEP (clean-block count vs candidate length) ===");
    let sweep_ids: &[(u8, u8)] = &[
        (0x02, 0),
        (0x50, 5),
        (0x62, 12),
        (0x69, 16),
        (0x6a, 16),
        (0x7a, 20),
        (0x7b, 16),
    ];
    for &(id, guess) in sweep_ids {
        print!("  0x{id:02x} (guess {guess}): ");
        let mut best = (0u64, 0usize);
        let mut line = Vec::new();
        for l in 0..=40usize {
            let mut o = Opaque::default();
            match id {
                0x02 => o.l_02 = l,
                0x50 => o.l_50 = l,
                0x62 => o.l_62 = l,
                0x69 => o.l_69 = l,
                0x6a => o.l_6a = l,
                0x7a => o.l_7a = l,
                0x7b => o.l_7b = l,
                _ => {}
            }
            let st = run_corpus(&replays, &o);
            if st.clean > best.0 {
                best = (st.clean, l);
            }
            // only print lengths near the peak to keep output small
            line.push((l, st.clean));
        }
        // print top 5 lengths by clean count
        line.sort_by_key(|(_, c)| std::cmp::Reverse(*c));
        let top: Vec<String> = line
            .iter()
            .take(5)
            .map(|(l, c)| format!("len{l}:{c}"))
            .collect();
        println!(
            "best=len{} (clean {})   top5: {}",
            best.1,
            best.0,
            top.join("  ")
        );
    }
}
