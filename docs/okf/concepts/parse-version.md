---
type: Domain Concept
title: Parse version
description: "A constant stamped on every document and file row; a bump re-parses every replay on the next pass, and it is never lowered."
resource: ../../../pipeline/parse-rs/src/lib.rs
tags: [pipeline, data]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: lib
    resource: ../../../pipeline/parse-rs/src/lib.rs
    title: The constant
---

`PARSE_VERSION` in `pipeline/parse-rs/src/lib.rs` is stamped into every document and every `ingest.files` row. The drain re-parses a key whose row carries an older version, so a bump re-parses every replay over the following passes. A row from a newer version is left alone, so an older image that is rolled back does not re-parse everything on every pass.

Bump it on any change to what the drain writes, including a parser dependency bump. Never lower it: `raw_replays` keeps the document at the highest version per replay, so an older version would never be read.
