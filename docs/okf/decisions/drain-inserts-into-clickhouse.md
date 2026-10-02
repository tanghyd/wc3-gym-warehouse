---
type: Decision
title: The drain inserts into ClickHouse
description: "The drain writes parsed documents straight into ClickHouse over HTTP and keeps no parsed copy in the bucket."
tags: [pipeline]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: drain
    resource: ../../../pipeline/parse-rs/src/bin/drain.rs
    title: The drain
---

# Decision

Made 2026-10-02. The drain inserts each parsed document into `ingest.docs` as it parses, and records each file's outcome in `ingest.files`. No parsed document and no status file is written to the bucket.

# Why

A parsed copy in the bucket was a second store to keep in step, and its status files were polled per key. With the outcome in ClickHouse, the drain decides what to parse with one query, the bucket needs only a read token, and a parser bump re-parses from the raw files, which the bucket keeps anyway.

# What it means for new code

A second document shape (events a map script emits, for instance) is a second ingest table the drain writes in the same pass, versioned the same way, not a section of the replay document; the marts that read it are their own models.
