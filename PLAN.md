# wc3-gym-warehouse: plan

The warehouse runs on this machine as one compose project; a box waits on stock. The README describes what runs, `docs/okf/` is the knowledge bundle, `docs/deploy.md` the box runbook, `docs/roadmap.md` what is proposed and not built. This file is the backlog and the decision log.

## State 2026-10-02

- The dbt rebuild (`feature/dbt-prototype`, pull request 12 on the fork): run-once ingest into ClickHouse, dbt marts, the Python query API, the Next.js inspector, Grafana, a deploy kit for one box.
- The quality sweep on top of it (`feature/quality-sweep`): query caps on the ClickHouse profiles; drain timeouts, a size cap, a blocking parse, pass records in `ingest.runs`; the API with a pooled client, errors by ClickHouse code, request ids and a log line, input caps, `/ready`; dbt tests that can fail and five rule tests; healthchecks, image pins, a box env guard, a Drain row in Grafana; `AGENTS.md`, the bundle, this plan, the roadmap, a wider CI file.
- Gates on the sweep without a running stack: parser tests 15, API offline tests 51, bundle test, `dbt parse`, compose config. The data gates (`dbt build` and test, the API cases and oracles, the 148 e2e tests) run against the stack after a rebuild.

## Backlog

In the order the roadmap gives them, each with what decides it:

1. Run the data gates on the sweep and fix what they show.
2. The deferred quality work in `docs/roadmap.md` section 4, each when its measurement says so.
3. The league bucket as a source (roadmap section 2): the read-only tokens, the key regex in dbt, deletes as tombstones.
4. The box: order, bootstrap, env, up, cron; then the merge of pull request 12.
5. The second instance for stat-events (roadmap section 1), after the map script's flush is fixed and the parser keeps the sync actions (section 3).

## Decisions

- 2026-09-04: ClickHouse on one small box, replays in the bucket, the bucket is the record, no database backup.
- 2026-10-01: dbt over hand-written SQL and the materialized-view chain; a Python API now, a Rust port later through the JSON cases; only the inspector, the API and Grafana as services; creep routes wait for stat-events; no link into the league's data; one copy per replay id, readers dedupe.
- 2026-10-02: the drain inserts into ClickHouse and keeps no parsed copy in the bucket; the box is a Hetzner CX33 when in stock, local until then, no public domain yet; tower rush by a fixed distance with inferred starts; one row per game and the mirror rule in every count.
- 2026-10-02 (the sweep): stat-events go in a second ingest table and their own dbt models behind a selector, never in the replay document; a second instance is a second compose project of the same repository; the data gates stay out of CI until a CI job can build the warehouse from the goldens.
