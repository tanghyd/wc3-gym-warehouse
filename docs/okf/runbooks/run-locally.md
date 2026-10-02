---
type: Runbook
title: Run locally
description: "Start the stack on one machine with MinIO as the bucket, load replays, build the marts, open the pages."
resource: ../../../just/local.just
tags: [deploy, tooling]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
stale_after: "2027-04-02"
sources:
  - id: local
    resource: ../../../just/local.just
    title: The recipes
  - id: readme
    resource: ../../../README.md
    title: Run it
---

# Steps

1. `cp .env.example .env`. The example runs the local stack: MinIO stands in for the bucket and holds the three parser goldens.
2. `just up`: builds and starts ClickHouse, MinIO, the API, the inspector, Grafana and the docs server, then applies the ingest tables to the ClickHouse volume.
3. `just ingest`: one drain pass over the bucket, then `dbt build` when it inserted documents. `just dbt build` runs dbt alone.
4. Open http://localhost:3000 (the inspector), http://localhost:8000/docs (the API), http://localhost:3001 (Grafana) and, after `just local::docs`, http://localhost:8080 (dbt's docs).

# More replays

`just local::upload-replays <folder> <since date> [dest]` copies every `.w3g` under a folder into the bucket under `replays/<dest>/`, then `just ingest` parses them. `just local::mc` is the MinIO client against the bucket.

# Tests

`just test` (the parser), `just local::api-test` (all API tests; the cases and oracles need the goldens built), `just dbt test`, `just local::web-lint`, `just local::e2e`. See [testing](../conventions/testing.md).

# Reset

`just local::reset` drops every volume, including the marts and Grafana's state. `just local::down` stops the project and keeps them.
