---
type: Pitfall
title: FINAL before a merge
description: "A ReplacingMergeTree holds every version of a row until a merge; a reader that forgets FINAL sees duplicates."
tags: [data]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: landing
    resource: ../../../dbt/models/landing/raw_replays.sql
    title: The FINAL read
---

# What happened

The ingest tables are ReplacingMergeTrees keyed by `(source, key)`. A re-parsed object adds a row; the merge that drops the old one runs later in the background. A read without `FINAL` saw both documents of one object and counted it twice.

# The rule

Read `ingest.docs` and `ingest.files` with `FINAL`, as `raw_replays` and the drain do. Never `OPTIMIZE` a table to force the merge. A mart is a plain table rebuilt in full, so it needs no `FINAL`.
