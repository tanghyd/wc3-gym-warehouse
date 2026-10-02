---
type: Integration
title: The drain
description: "Lists a bucket prefix, detects change by ETag, size and parse version, parses each changed replay into one document, and never writes to the bucket."
resource: ../../../pipeline/parse-rs/src/bin/drain.rs
tags: [pipeline]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: drain
    resource: ../../../pipeline/parse-rs/src/bin/drain.rs
    title: The drain
  - id: env
    resource: ../../../.env.example
    title: The variables
---

# What one pass does

For each source bucket the drain lists the replay prefix a thousand keys at a time, reads the source's rows from `ingest.files`, and keeps the keys that need a parse: no row, another size, an older [parse version](parse-version.md), or another ETag (the last-modified time when the listing gives no ETag). A key that is not a `.w3g`, or is `LastReplay.w3g` (the game client rewrites it after every game), is counted and skipped.

Each kept object is fetched and parsed on a blocking thread, several at a time (`DRAIN_CONCURRENCY`, clamped to 1 to 64). The document is the parser's JSON plus `source_key`, `source_last_modified` and `parse_version`. Rows go to ClickHouse in batches of five hundred: documents first into `ingest.docs`, then outcomes into `ingest.files`, so a failed second insert re-parses those keys next pass and the repeated documents collapse on the key.

# Failures

- A parse that fails, an object over thirty-two megabytes, or a parser panic writes a row with an `error` and no document. The key waits for a re-upload or a parser bump.
- A failed list, fetch or insert writes no row, so the next pass retries the key. The source's `ingest.runs` row carries the error.
- Every request has a timeout, so a pass ends.

# The bucket

The drain only lists and reads. Give it a token with object read only. The raw object is never moved or deleted by anything in this repository.

# Configuration

The `W3WAREHOUSE_S3_*` variables name the endpoint, bucket, key pair and prefix of the first source; `W3WAREHOUSE_SOURCE2_*` the second, which exists when its bucket is set and is listed at its prefix as given. An empty value counts as unset. `.env.example` describes each.
