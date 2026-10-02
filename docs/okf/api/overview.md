---
type: API Area
title: The query API
description: "Eight routes over the marts, a catalog read from dbt's manifest, every value a parameter, and a budget that keeps one bad request from the server."
resource: ../../../api/app.py
tags: [api]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: app
    resource: ../../../api/app.py
    title: The routes and the runner
  - id: profile
    resource: ../../../infrastructure/docker/clickhouse/users.xml
    title: The api profile
---

# Routes

| Route | Answers |
|---|---|
| `GET /health` | the process answers; the compose healthcheck reads it |
| `GET /ready` | ClickHouse answers and the catalog loads |
| `GET /catalog` | every semantic model: dimensions with types, measures, and the labels, types, parts and notes a page shows |
| `POST /query` | measures grouped by dimensions, under filters and an optional build order |
| `POST /objects` | a step picker's groups for a kind and a side's races, each object with the games in which a player of the side ordered it |
| `POST /search` | one page of the games that fit both sides, with their figures and the same over the scope |
| `GET /replays/{id}` | one replay: header, players, timeline events, chat |
| `GET /strategies`, `POST /strategies/stats` | the presets, and games, wins and losses per preset in a scope |

# The catalog

The catalog is the `meta.semantic` block on the dbt models, read from `target/manifest.json` and reloaded when a build rewrites it. Column types come from ClickHouse. A model with `replay_id` and `player_id` takes build-order steps. Adding a measure is a YAML edit and a `dbt build`.

# What stops a bad request

- Every request value travels as a ClickHouse query parameter. Every name is checked against the catalog.
- Request models carry bounds: values up to 100 characters, lists up to 20 names, filters up to 20 keys, steps and groups counted. A range on a text dimension, or text on a number, is a 400 before any query.
- At most six queries run at once; a seventh waits one second, then answers 503 with `Retry-After`. The `api` user's profile caps time, memory, threads, rows read and rows answered on the server side, and buffers the whole answer so a failure is never a 200 with partial rows.
- A ClickHouse failure answers a fixed message with the status its error code picks: 400 for a cap or a value that does not fit, 503 for an overloaded server, 504 for a timeout, 502 otherwise. The server's text goes to the log.

# Observability

Every answer carries `X-Request-Id` (a caller may send its own). One JSON log line per request records the path, status, time, queries run and rows read. Each query goes to ClickHouse with a `query_id` built from the request id and a `User-Agent` naming the endpoint, so `system.query_log` shows which endpoint ran what. Errors carry `detail` and `request_id`.
