use std::{
    env,
    hint::black_box,
    process,
    time::{Duration, Instant},
};

use serde::Serialize;
use w3grs::{ParserOutput, W3GReplay};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let replay_path = args.next().ok_or_else(|| {
        "usage: w3grs-compare-one <replay.w3g|replay.nwg> [iterations] [warmup]".to_string()
    })?;
    let iterations = parse_count(args.next(), 3, "iterations", false)?;
    let warmup = parse_count(args.next(), 1, "warmup", true)?;
    let bytes = std::fs::read(&replay_path)
        .map_err(|error| format!("failed to read {replay_path}: {error}"))?;
    let mut parser = W3GReplay::new();

    for _ in 0..warmup {
        let output = parser
            .parse_bytes(black_box(&bytes))
            .map_err(|error| format!("warmup parse failed: {error}"))?;
        black_box(output.players.len());
    }

    let mut samples = Vec::with_capacity(iterations);
    let mut last_output = None;
    for _ in 0..iterations {
        let started = Instant::now();
        let output = parser
            .parse_bytes(black_box(&bytes))
            .map_err(|error| format!("timed parse failed: {error}"))?;
        samples.push(started.elapsed());
        black_box(&output);
        last_output = Some(output);
    }

    let output = last_output.ok_or_else(|| "iterations must be greater than zero".to_string())?;
    let response = CompareOneOutput {
        parser: "w3grs",
        iterations,
        warmup,
        stats: Stats::from_samples(&samples),
        output,
    };
    println!(
        "{}",
        serde_json::to_string(&response)
            .map_err(|error| format!("failed to serialize benchmark output: {error}"))?
    );
    Ok(())
}

fn parse_count(
    value: Option<String>,
    default: usize,
    name: &str,
    allow_zero: bool,
) -> Result<usize, String> {
    match value {
        Some(value) => value
            .parse::<usize>()
            .map_err(|error| format!("invalid {name} value {value:?}: {error}"))
            .and_then(|value| {
                if value == 0 && !allow_zero {
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
struct CompareOneOutput {
    parser: &'static str,
    iterations: usize,
    warmup: usize,
    stats: Stats,
    output: ParserOutput,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    total_ms: f64,
    mean_ms: f64,
    min_ms: f64,
    max_ms: f64,
}

impl Stats {
    fn from_samples(samples: &[Duration]) -> Self {
        let mut total = Duration::ZERO;
        let mut min = Duration::MAX;
        let mut max = Duration::ZERO;
        for sample in samples {
            total += *sample;
            min = min.min(*sample);
            max = max.max(*sample);
        }
        let total_ms = total.as_secs_f64() * 1000.0;
        Self {
            total_ms,
            mean_ms: total_ms / samples.len() as f64,
            min_ms: min.as_secs_f64() * 1000.0,
            max_ms: max.as_secs_f64() * 1000.0,
        }
    }
}
