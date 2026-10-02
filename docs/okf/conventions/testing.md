---
type: Convention
title: Testing
description: "What each suite proves, which suites need a built warehouse, and the rule that every data rule has a test."
tags: [testing]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: api-tests
    resource: ../../../api/tests/test_app.py
    title: The offline app tests
  - id: dbt-tests
    resource: ../../../dbt/tests/tests.yml
    title: The singular tests
---

# The suites

| Suite | Runs with | Proves |
|---|---|---|
| `just test`, `just local::drain-test` | nothing (the host, or the drain image) | the parser matches the goldens in `pipeline/parse-rs/tests/goldens` field by field, and the drain's skip, config and document rules |
| `just local::api-test tests/test_compile.py` | nothing | the compiler's SQL for fixed requests, with every value a parameter |
| `just local::api-test tests/test_app.py` | nothing (ClickHouse is a fake transport) | the error map by ClickHouse code, the request id, the input caps, the query budget, readiness |
| `just local::api-test tests/test_okf.py` | nothing | this bundle conforms and is safe to publish |
| `just local::api-test tests/test_cases.py` | a built warehouse of the goldens | request and response pairs in `api/tests/cases`, plain JSON a port can reuse |
| `just local::api-test tests/test_oracles.py` | a built warehouse | hand-labelled games a search must match, labelled by SQL on the order tables, not through the compiler |
| `just dbt test` | a built warehouse | generic tests on every key, singular tests for the invariants, unit tests for the branching rules |
| `just local::e2e` | the stack and the full replay load | the inspector against the API as the oracle, at desktop and phone widths |

# The rules

- A data rule has a test that fails when the rule breaks: one win and one loss per game, every 1on1 map with start locations, every document with the keys the marts read. A test that cannot fail on the column it sits on is replaced.
- A ClickHouse column that cannot hold NULL is tested with `not_empty`, which fails on the type's default value, not with `not_null`.
- A golden changes only through `just local::goldens`; the git diff is the review of the parser change.
- The case files change only through `just local::api-cases-update`; the git diff is the review.
- A test that needs data says so in its docstring, so a reader knows why it is not in CI.
