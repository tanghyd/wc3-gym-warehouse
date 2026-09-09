# w3grs

`w3grs` is a Rust port of [`w3gjs`](https://github.com/PBug90/w3gjs), intended to be a clean library for parsing Warcraft III replay files in other Rust projects.

The upstream TypeScript source is tracked as a Git submodule in `upstream/w3gjs` for parity tests, benchmarks, and future maintenance. The published crate contains the Rust library and a small fixture subset, not the full upstream replay corpus.

## Installation

`w3grs` requires Rust 1.85 or newer.

```sh
cargo add w3grs
```

Optional low-level extensions that intentionally diverge from `w3gjs` can be
enabled with Cargo features. For example, `extended-actions` exposes additional
action variants in the detailed low-level action stream while keeping default
parsing output aligned with `w3gjs`:

```sh
cargo add w3grs --features extended-actions
```

## Development Checkout

Clone with submodules when you want to run the repository's `w3gjs` parity and speed comparison scripts:

```sh
git clone --recurse-submodules git@github.com:wakamex/w3grs.git
```

For an existing checkout:

```sh
git submodule update --init --recursive
```

## Usage

```rust
use w3grs::W3GReplay;

fn main() -> w3grs::Result<()> {
    let mut parser = W3GReplay::new();
    let replay = parser.parse_file("replay.w3g")?;

    println!("{} on {}", replay.matchup, replay.map.file);
    println!("players: {}", replay.players.len());

    Ok(())
}
```

Lower-level parser layers are also public:

- `RawParser` for replay headers and compressed data blocks
- `MetadataParser` for lobby/map/player setup data
- `GameDataParser` and `ActionParser` for timeslots, chat, leave events, and player actions
- `ReplayParser` for the combined low-level parse output

Consumers that need both the high-level summary and the raw action stream can parse once and use the timed action helper:

```rust
use w3grs::{W3GReplay, action::format_fourcc_or_hex};

fn main() -> w3grs::Result<()> {
    let mut parser = W3GReplay::new();
    let parsed = parser.parse_file_detailed("replay.w3g")?;

    println!("{} on {}", parsed.summary.matchup, parsed.summary.map.file);
    for timed in parsed.low_level.timed_actions() {
        println!(
            "time_ms={} player={} action=0x{:02x}",
            timed.time_ms,
            timed.player_id,
            timed.action.id()
        );
    }

    let order = format_fourcc_or_hex(*b"trah");
    println!("formatted order id: {order}");

    Ok(())
}
```

With the `extended-actions` feature enabled, the low-level/timed action stream
also emits additional actions that `w3gjs` drops:

- `Action::CommandCardSource` for normalized action id `0x7b`. This post-2.0.2
  command-card/source action carries `source_unit_tag`, `ability_id`,
  `order_id`, `raw_opcode`, and `normalized_opcode` so downstream simulators can
  attribute command-card orders to the producing unit.
- `Action::ChangeAllyOptions` for normalized action id `0x50`.
- `Action::MapTriggerChatCommand` for normalized action id `0x60`.
- `Action::ScenarioTrigger` for normalized action id `0x62`.
- `Action::ContinueGameBlockB` and `Action::ContinueGameBlockA` for normalized
  action ids `0x69` and `0x6a`.
- `Action::OpaqueDroppedAction` for normalized ids `0x02` and `0x7a`. This
  preserves `raw_opcode`, `normalized_opcode`, and exact payload bytes for
  downstream inspection while their semantics are still unknown.

The feature is disabled by default because these actions intentionally diverge
from `w3gjs` output.

## Upstream Parity

From a development checkout, check every replay fixture in `upstream/w3gjs/test/replays` for output parity against `w3gjs`:

```sh
node scripts/compare-all.mjs --prepare --iterations 3 --warmup 1
```

The parity sweep reports:

- exact canonical JSON byte parity, including `parseTime`
- normalized canonical JSON parity with `parseTime` removed

`parseTime` is expected to break exact parity because it measures each parser's runtime. Normalized parity is the useful output-equivalence signal.

Useful options:

```sh
node scripts/compare-all.mjs --json
node scripts/compare-all.mjs --fail-on-mismatch --write-mismatches tmp/parity
```

Recent local parity result on the upstream submodule replay fixtures with 1 timed parse and no warmup:

```text
Replays: 50
Exact byte parity: 0/50 (mismatches include expected parseTime differences)
Normalized parity without parseTime: 50/50
```

### Intentional Divergences

`w3grs` is stricter than `w3gjs` about required replay metadata structure. For example, the metadata parser returns an error when the lobby setup marker is not the expected `0x19` byte, while `w3gjs` logs the unknown chunk and keeps parsing. This is intentional: the marker is an internal W3G consistency check, not a user-facing replay metric, and treating an invalid marker as an error helps catch corrupt or out-of-sync replay metadata early. Nearby length fields such as `remainingBytes` are likewise internal format fields.

`w3grs` also treats incomplete raw replay blocks and malformed top-level game-data block headers as parse errors instead of returning partial data. Inside timeslots, it keeps `w3gjs`'s best-effort behavior for clipped action payloads.

For unknown-player gameplay records, `w3grs` is more tolerant than `w3gjs`: command blocks and chat messages for players that are not present in the lobby metadata are ignored rather than logged or allowed to throw. This keeps library parsing quiet and fallible through `Result` instead of process output or panics.

The low-level Rust API also returns parsed `game_data_blocks` directly instead of exposing them only through Node-style events. This keeps the same underlying replay data but presents it in a Rust-friendly result structure.

## Benchmark

From a development checkout with the submodule initialized, compare local `w3gjs` and `w3grs` parsing speed on the same replay:

```sh
node scripts/benchmark.mjs --prepare upstream/w3gjs/test/replays/132/reforged1.w3g
```

Useful options:

```sh
node scripts/benchmark.mjs replay.w3g --iterations 100 --warmup 10
node scripts/benchmark.mjs replay.w3g --json
node scripts/benchmark.mjs replay.w3g --phases
```

The benchmark reads the replay once per parser process, warms both parsers, then reports timed in-process parses. `--prepare` runs the local `w3gjs` install/build and builds the Rust benchmark binary in release mode.
Use `--phases` to include a Rust parser phase breakdown for raw block parsing, decompression, metadata, setup, game data scanning, postprocessing, and final output construction. Phase output also includes game-data counters for scanned blocks, command blocks, actions, summary actions, and skipped data.

For Rust-only phase timing, run the benchmark binary directly:

```sh
cargo run --release --bin w3grs-bench -- replay.w3g 100 10 --phases
```

Example smoke result on this repo's `reforged1.w3g` fixture with 2 timed iterations and 1 warmup:

```text
Replay: upstream/w3gjs/test/replays/132/reforged1.w3g
Iterations: 2 timed, 1 warmup

Parser   total ms   mean ms   min ms    max ms    players
w3gjs       61.097    30.548    26.996    34.101        2
w3grs        0.800     0.400     0.382     0.418        2

w3grs mean speedup vs w3gjs: 76.34x
```

Benchmark results vary by machine, replay, iteration count, and current CPU load. Use larger iteration counts for less noisy comparisons:

```sh
node scripts/benchmark.mjs upstream/w3gjs/test/replays/132/reforged1.w3g --iterations 100 --warmup 10
```

### All-Replay Speed Sweep

The parity script also times both parsers across the whole upstream replay corpus:

```sh
node scripts/compare-all.mjs --prepare --iterations 10 --warmup 2
```

The speed sweep reports:

- `w3gjs` and `w3grs` mean parse time per replay
- aggregate mean/min/max speedup

Recent local speed result on the upstream submodule replay fixtures with 1 timed parse and no warmup:

```text
Speedup mean/min/max: 45.31x / 11.80x / 105.16x
```
