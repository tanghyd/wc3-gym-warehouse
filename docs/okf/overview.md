---
type: Repository
title: wc3-gym-warehouse
description: "Warcraft III replays in a bucket, parsed by a Rust drain into ClickHouse, modelled by dbt, served by a query API and a replay inspector, watched by Grafana, all in one compose project."
resource: ../../README.md
tags: [pipeline, data, api, web, deploy]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: readme
    resource: ../../README.md
    title: The README
---

# What it is

A warehouse of Warcraft III replays. Replays sit in an S3 bucket (Cloudflare R2, or MinIO on a laptop). One compose project runs everything else: a Rust drain that lists the bucket and parses each new replay into ClickHouse, dbt that turns the parsed documents into marts, a Python query API over the marts, a Next.js replay inspector that reads the API, and Grafana over ClickHouse.

The marts answer questions about build orders: every game that opened a given way, the record of a race against another, the openers tree, a replay's timeline. The [pipeline](concepts/pipeline.md) names each stage and what it owns.

# Where things are

| Path | Holds |
|---|---|
| `pipeline/parse-rs` | the parser library and the `drain`, `parse` and `export-mappings` binaries |
| `infrastructure/docker` | the four Dockerfiles, the ClickHouse users, tuning and ingest tables, the Grafana provisioning |
| `dbt` | the project: landing, staging and marts, seeds, tests, docs |
| `api` | the FastAPI query API, its compiler, its presets and tests |
| `web` | the inspector and its Playwright tests |
| `just`, `justfile` | every command a person runs: `local` for the stack on this machine, `deploy` for the box |
| `docs` | this bundle, the box runbook, the roadmap, and the design of an earlier version |

# How to read this bundle

[Start here by question](questions.md) lists what a new reader asks and the concept that answers it. The [data](data/index.md) directory describes every table; [concepts](concepts/index.md) the rules the data follows; [api](api/index.md) the routes; [runbooks](runbooks/index.md) how to run it; [decisions](decisions/index.md) why it is shaped this way; [pitfalls](pitfalls/index.md) what went wrong once.
