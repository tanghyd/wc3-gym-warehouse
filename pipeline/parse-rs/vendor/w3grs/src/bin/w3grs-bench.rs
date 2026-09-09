use std::{
    env,
    hint::black_box,
    process,
    time::{Duration, Instant},
};

use serde::Serialize;
use w3grs::{W3GReplay, replay::ParsePhaseTimings};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = BenchArgs::parse()?;
    let started = Instant::now();
    let bytes = std::fs::read(&args.replay_path)
        .map_err(|error| format!("failed to read {}: {error}", args.replay_path))?;
    let read_file_ms = elapsed_ms(started);
    let mut parser = W3GReplay::new();

    for _ in 0..args.warmup {
        if args.phases {
            let parsed = parser
                .parse_bytes_with_phases(black_box(&bytes))
                .map_err(|error| format!("warmup parse failed: {error}"))?;
            black_box(parsed.output.players.len());
            black_box(parsed.phases.total_ms);
        } else {
            let output = parser
                .parse_bytes(black_box(&bytes))
                .map_err(|error| format!("warmup parse failed: {error}"))?;
            black_box(output.players.len());
        }
    }

    let mut samples = Vec::with_capacity(args.iterations);
    let mut phase_samples = Vec::with_capacity(args.iterations);
    let mut last_players = 0usize;
    for _ in 0..args.iterations {
        let started = Instant::now();
        if args.phases {
            let parsed = parser
                .parse_bytes_with_phases(black_box(&bytes))
                .map_err(|error| format!("timed parse failed: {error}"))?;
            let elapsed = started.elapsed();
            last_players = parsed.output.players.len();
            black_box(&parsed.output);
            phase_samples.push(parsed.phases);
            samples.push(elapsed);
        } else {
            let output = parser
                .parse_bytes(black_box(&bytes))
                .map_err(|error| format!("timed parse failed: {error}"))?;
            let elapsed = started.elapsed();
            last_players = output.players.len();
            black_box(&output);
            samples.push(elapsed);
        }
    }

    let stats = Stats::from_samples(&samples);
    let output = BenchOutput {
        parser: "w3grs",
        iterations: args.iterations,
        warmup: args.warmup,
        read_file_ms,
        total_ms: stats.total_ms,
        mean_ms: stats.mean_ms,
        min_ms: stats.min_ms,
        max_ms: stats.max_ms,
        last_players,
        phases: args
            .phases
            .then(|| PhaseStats::from_phase_samples(&phase_samples)),
    };
    println!(
        "{}",
        serde_json::to_string(&output)
            .map_err(|error| format!("failed to serialize benchmark output: {error}"))?
    );
    Ok(())
}

struct BenchArgs {
    replay_path: String,
    iterations: usize,
    warmup: usize,
    phases: bool,
}

impl BenchArgs {
    fn parse() -> Result<Self, String> {
        let mut positional = Vec::new();
        let mut phases = false;

        for arg in env::args().skip(1) {
            match arg.as_str() {
                "--phases" => phases = true,
                "-h" | "--help" => {
                    println!("{}", usage());
                    process::exit(0);
                }
                _ if arg.starts_with('-') => return Err(format!("unknown argument: {arg}")),
                _ => positional.push(arg),
            }
        }

        let replay_path = positional
            .first()
            .cloned()
            .ok_or_else(|| usage().to_string())?;
        if positional.len() > 3 {
            return Err(format!("too many positional arguments\n{}", usage()));
        }

        Ok(Self {
            replay_path,
            iterations: parse_count(positional.get(1).cloned(), 25, "iterations")?,
            warmup: parse_count(positional.get(2).cloned(), 5, "warmup")?,
            phases,
        })
    }
}

fn parse_count(value: Option<String>, default: usize, name: &str) -> Result<usize, String> {
    match value {
        Some(value) => value
            .parse::<usize>()
            .map_err(|error| format!("invalid {name} value {value:?}: {error}"))
            .and_then(|value| {
                if value == 0 {
                    Err(format!("{name} must be greater than zero"))
                } else {
                    Ok(value)
                }
            }),
        None => Ok(default),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchOutput {
    parser: &'static str,
    iterations: usize,
    warmup: usize,
    read_file_ms: f64,
    total_ms: f64,
    mean_ms: f64,
    min_ms: f64,
    max_ms: f64,
    last_players: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    phases: Option<PhaseStats>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseStats {
    raw: Stats,
    decompress: Stats,
    metadata: Stats,
    setup: Stats,
    game_data: Stats,
    game_data_counters: GameDataCounters,
    postprocess: Stats,
    finalize: Stats,
    total: Stats,
}

impl PhaseStats {
    fn from_phase_samples(samples: &[ParsePhaseTimings]) -> Self {
        Self {
            raw: Stats::from_ms_samples(samples.iter().map(|sample| sample.raw_ms)),
            decompress: Stats::from_ms_samples(samples.iter().map(|sample| sample.decompress_ms)),
            metadata: Stats::from_ms_samples(samples.iter().map(|sample| sample.metadata_ms)),
            setup: Stats::from_ms_samples(samples.iter().map(|sample| sample.setup_ms)),
            game_data: Stats::from_ms_samples(samples.iter().map(|sample| sample.game_data_ms)),
            game_data_counters: GameDataCounters::from_sample(
                samples.last().copied().unwrap_or_default(),
            ),
            postprocess: Stats::from_ms_samples(samples.iter().map(|sample| sample.postprocess_ms)),
            finalize: Stats::from_ms_samples(samples.iter().map(|sample| sample.finalize_ms)),
            total: Stats::from_ms_samples(samples.iter().map(|sample| sample.total_ms)),
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameDataCounters {
    blocks: u64,
    ignored_blocks: u64,
    timeslots: u64,
    command_blocks: u64,
    skipped_command_blocks: u64,
    action_bytes: u64,
    skipped_action_bytes: u64,
    actions: u64,
    summary_actions: u64,
    ignored_actions: u64,
    chat_messages: u64,
    leave_game_blocks: u64,
}

impl GameDataCounters {
    fn from_sample(sample: ParsePhaseTimings) -> Self {
        Self {
            blocks: sample.game_data_blocks,
            ignored_blocks: sample.game_data_ignored_blocks,
            timeslots: sample.game_data_timeslots,
            command_blocks: sample.game_data_command_blocks,
            skipped_command_blocks: sample.game_data_skipped_command_blocks,
            action_bytes: sample.game_data_action_bytes,
            skipped_action_bytes: sample.game_data_skipped_action_bytes,
            actions: sample.game_data_actions,
            summary_actions: sample.game_data_summary_actions,
            ignored_actions: sample.game_data_ignored_actions,
            chat_messages: sample.game_data_chat_messages,
            leave_game_blocks: sample.game_data_leave_game_blocks,
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    total_ms: f64,
    mean_ms: f64,
    min_ms: f64,
    max_ms: f64,
}

impl Stats {
    fn from_samples(samples: &[Duration]) -> Self {
        Self::from_ms_samples(samples.iter().map(|sample| sample.as_secs_f64() * 1000.0))
    }

    fn from_ms_samples(samples: impl IntoIterator<Item = f64>) -> Self {
        let mut total_ms = 0.0;
        let mut min_ms = f64::INFINITY;
        let mut max_ms = 0.0_f64;
        let mut count = 0usize;
        for sample in samples {
            total_ms += sample;
            min_ms = min_ms.min(sample);
            max_ms = max_ms.max(sample);
            count += 1;
        }

        Self {
            total_ms,
            mean_ms: total_ms / count as f64,
            min_ms,
            max_ms,
        }
    }
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

fn usage() -> &'static str {
    "usage: w3grs-bench <replay.w3g|replay.nwg> [iterations] [warmup] [--phases]"
}
