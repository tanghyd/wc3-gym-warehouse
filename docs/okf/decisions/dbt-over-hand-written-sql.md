---
type: Decision
title: dbt over hand-written SQL
description: "The marts are dbt models rebuilt in full on each run, not a chain of materialized views; incremental models wait until a build takes minutes."
tags: [data]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: project
    resource: ../../../dbt/dbt_project.yml
    title: The project config
---

# Decision

Made 2026-10-01. The ClickHouse schema and the transforms are a dbt project: a landing table, a staging view and marts rebuilt in full with an atomic swap on every `dbt build`, with the tests, the column docs and the semantic catalog beside the SQL. The earlier chain of insert-time materialized views is replaced.

# Why

One source of truth for the schema, the docs and the tests, in one language a reviewer reads. A full rebuild removes the "load a replay once or double count it" trap of insert-time views, and a build takes seconds at the current size. The catalog the API serves is the model's own metadata, so a new measure is a YAML edit.

# What it means for new code

A new mart is a model with an `order_by`, a YAML block with every column, and a test for its rule. A model becomes incremental only when a build takes minutes; until then every run rebuilds everything.
