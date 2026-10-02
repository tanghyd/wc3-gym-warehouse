---
type: Domain Concept
title: The pipeline
description: "Bucket key, drain, ingest tables, dbt marts, API, page: what each stage owns and when it runs."
tags: [pipeline]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: readme
    resource: ../../../README.md
    title: How it fits together
  - id: ingest
    resource: ../../../just/local.just
    title: The ingest recipe
---

# The stages

1. **The bucket.** Raw `.w3g` files under `<environment>/replays/`, where the environment segment is set by `W3WAREHOUSE_S3_PREFIX`. The league app writes them there under `<environment>/replays/<series id>/game<n>.w3g`; other folders under `replays/` hold other collections. A second bucket, read the same way, is the `W3WAREHOUSE_SOURCE2_*` set. The bucket is [the record](../decisions/bucket-is-the-record.md).
2. **The drain.** One pass per run: list, compare with `ingest.files`, parse what is new or changed, insert the document into `ingest.docs`. See [the drain](drain.md).
3. **dbt.** `just dbt build` reads `ingest.docs`, builds `raw_replays`, the staging view and the marts, and runs every test. The marts rebuild in full on each run with an atomic swap. See [landing and staging](../data/landing-and-staging.md).
4. **The API.** Reads the semantic catalog from dbt's manifest and queries the marts. See [the API](../api/overview.md).
5. **The page.** The inspector's server reads the API; the browser reads the page. See [the inspector](inspector.md).

# When it runs

`just ingest` is one drain pass, then `dbt build` when `ingest.docs` holds a document newer than the last build, or when the last build failed. On the box a cron line runs it every ten minutes under a lock, and a pass over thirty minutes is killed so a hung request cannot hold the lock. Each pass writes one row per source to `ingest.runs`, which Grafana reads for the age of the last pass.

The API picks up a new manifest on its next request. Nothing else is scheduled.
