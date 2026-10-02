---
type: Convention
title: Code style
description: "Short modules, comments that describe the current state, every value a parameter, and one place for each rule across Rust, Python, SQL and TypeScript."
tags: [tooling]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: api
    resource: ../../../api/compile.py
    title: The compiler
  - id: dbt
    resource: ../../../dbt/dbt_project.yml
    title: The dbt project
---

# Across the repository

- A comment describes what the code does now, in one line where it can. No history, no names, no "TODO" without an issue.
- A rule lives in one place. The winner rule is SQL in `replays`; the race value rule is one macro; the search grammar is the API's request models. A page reads the rule's output, never re-implements it.
- Simple technical English in docs and comments: short sentences, plain words.

# Rust (`pipeline/parse-rs`)

- `clippy --all-targets` passes with no warning. Errors are `Result<_, String>` with the cause in the text; an S3 error prints its full context.
- The drain never writes to a bucket. It has no `unwrap` outside tests.

# Python (`api`)

- Every request value reaches ClickHouse as a query parameter, never spliced into SQL. Every name is checked against the catalog before it is used.
- Request models carry their bounds (lengths, counts, ranges), so a bad request is a 422 or a 400 before any query runs.
- The compiler does no I/O, so its goldens run with no server.
- Dependencies are declared with lower bounds and locked in `uv.lock`; the Python version is pinned in `.python-version`.

# SQL (`dbt`)

- Every model and seed column has a YAML description. Descriptions persist to ClickHouse as comments; no semicolons in them.
- A model names its `order_by` from the filters its readers use, with low-cardinality columns first.
- A rule the marts rely on has a test: a unit test for its branches, a singular test for the invariant it must keep.

# TypeScript (`web`)

- Strict mode, no `any`, no `eslint-disable`. The browser never calls the API; every read is a server function in `web/src/lib/api.ts` with a timeout.
- The URL holds the view's state, so every view is a link.
- One helper per idea; a function used twice moves to `web/src/lib`.
