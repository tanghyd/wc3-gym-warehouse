---
type: Pitfall
title: ingest.sql runs on an empty volume only
description: "The ClickHouse image runs the init SQL once, on an empty volume; a new table in it does not appear on a running server by itself."
tags: [pipeline, deploy]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: recipe
    resource: ../../../just/local.just
    title: The schema recipe
---

# What happened

A table was added to `infrastructure/docker/clickhouse/ingest.sql`. On a machine with an existing ClickHouse volume the image skipped the file, the table was missing, and the drain's insert failed.

# The rule

Every statement in the file is `IF NOT EXISTS`, and `just up` applies the file after the server answers (`just local::schema`), on this machine and on the box. A column change still needs its own `ALTER TABLE ... IF NOT EXISTS` line in the same file.
