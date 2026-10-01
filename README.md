# wc3-gym-warehouse

Replay analytics for the GNL site. Replays sit in a Cloudflare R2 bucket. A Rust drain parses them, dbt loads and models them in ClickHouse, and a small API answers questions about them.

The design and build order are in [PLAN.md](PLAN.md). `docs/design/` predates the dbt prototype: its schema and routes describe the hand-written SQL this branch replaces.

Same rules as the other Warcraft-Gym repos: branch, PR to `main`, squash merge.

## Run it

Everything runs in Docker. `.env.example` holds a working local setup, with MinIO standing in for R2:

```
cp .env.example .env
just up          # clickhouse, minio with the 3 parser goldens, the drain, the api, the page, the inspector
just drain-once  # parse the goldens now instead of within the drain's minute
just dbt build   # seed the mappings, load the parsed docs, build and test every model
just ch          # a clickhouse-client shell
```

The replay inspector is at http://localhost:3000 and the API at http://localhost:8000 (docs at http://localhost:8000/docs).

| Recipe | Does |
|---|---|
| `just dbt <args>` | any dbt command in the dbt container, such as `build`, `test` or `docs generate` |
| `just local::mappings` | rewrites `dbt/seeds/mappings_melee.csv` from the parser's tables, after a w3grs bump |
| `just local::api-test` | the API tests in its container: compiler goldens, then the live cases |
| `just local::api-cases-update` | rewrites the answers in `api/tests/cases/` from the live stack |
| `just local::reset` | drops every volume |

## How it fits together

```
R2 or MinIO                        ClickHouse (dbt builds w3g.*)                  API            page
replays/<series>/game<n>.w3g ─drain─▶ parsed/v2/dt=<date>/<id>.json ─dbt─▶ raw_replays ─▶ marts ─▶ /query  ─▶ web :3000
                                                                                              /search
```

1. The GNL backend writes a reported replay to `<env>/replays/<series id>/game<n>.w3g`; `<env>` is the Vercel environment (`app/services/r2.py`), set as `W3WAREHOUSE_S3_PREFIX`. Locally, `minio-setup` puts the 3 goldens there as series 9001-9003.
2. The drain (`pipeline/parse-rs`, w3grs) parses each new or changed file and writes the parsed document under `parsed/v2/`. It never moves or deletes a raw file.
3. `just dbt build`:
   - `raw_replays` is an incremental model. It reads every parsed document through ClickHouse's `s3()` and appends the ones it does not have yet. The URL and the keys come from the `parsed_docs` named collection (`infrastructure/docker/clickhouse/named-collections.xml`), filled from the server's environment, so no secret lands in SQL.
   - The staging views flatten orders and hero skills.
   - The marts are tables that rebuild with an atomic swap.
4. The API reads the semantic catalog from dbt's `target/manifest.json` and queries ClickHouse as the read-only `api` user.

### dbt models (`dbt/`)

| Model | Grain |
|---|---|
| `raw_replays` | one parsed document per replay |
| `replays`, `replay_players` | replay header with readable map name; player per replay |
| `replay_events` | every order and hero skill per player in time order; build-order steps match here |
| `player_games` | one row per player per 1v1: opponent, map, result, first hero, `opener_1`..`opener_6` |
| `mappings` | object codes and names: the melee seed plus the custom-map seed |
| `player_heroes`, `player_group_hotkeys`, `chat`, `resource_transfers` | as named |

The opener tree is a `GROUP BY` over `player_games.opener_N`, so the refreshable rollup and its 10-minute staleness are gone.

## The query API (`api/`)

The catalog lives on the dbt models. `meta.semantic` in `dbt/models/marts/marts.yml` lists a model's dimensions (columns a caller may group or filter on) and measures (named aggregates). Adding a measure is a YAML edit and a `just dbt build`; the API picks up the new manifest on its next request.

| Route | Answers |
|---|---|
| `GET /catalog` | every semantic model, its dimensions with types, its measures |
| `POST /query` | measures grouped by dimensions, under filters and an optional build order |
| `POST /search` | the replays holding a player who matches, plus other players in the same game |

```
POST /query
{ "dimensions": ["opponent_race"], "measures": ["games", "win_rate"],
  "filters": { "race": ["N"], "minutes": { "gte": 10 } },
  "steps": [ { "type": "building", "code": "eaom" },
             { "type": "building", "code": "edob", "within_prev_s": 30 } ] }
```

A filter is a list of values or a `{gte, lte}` range. A step names an event type and object code. A step may bound the gap since the previous step (`within_prev_s`) and its own game time (`from_min`, `to_min`). Steps compile to `sequenceMatch` over `replay_events`. Every request value travels as a ClickHouse query parameter; names must come from the catalog.

`api/tests/cases/*.json` are request and response pairs against the 3 goldens. They are plain JSON so a later Rust port of the API can run the same cases.

## The replay inspector (`web/`)

A Next.js app in the wc3-gym-frontend look, light and dark, at http://localhost:3000. `/` lists the replays under race, opponent race, map and player filters (`POST /search`). `/replays/<id>` shows one game: the players, their heroes and skills, APM per minute, both build orders and the chat (`GET /replays/{id}`, plus one `POST /query` on `mappings` for the names). Server components read the API at `API_URL` (`http://api:8000` in compose), so the browser never calls it. The object and race icons live in `web/public/`.

| Recipe | Does |
|---|---|
| `just local::web-lock` | rewrites `web/pnpm-lock.yaml` after a `web/package.json` change, in a node container |
| `just local::web-lint` | eslint, in the lint stage of the web image |

## Not here yet

- The swimlane chart of the build orders (`docs/design/frontend.md` 12.3). The inspector shows the list view.
- Creep routes. A replay holds commands, and a creep death alone cannot say whether the player cleared the camp or an enemy stole it. That waits for stat-events maps.
- Stat-events. A future parser output adds a section to the parsed document, and dbt gets a staging model for it.
- The `is_repeat` order flag and `replays.source_key` (design S3, S5).
- Hosting. The `prod` profile's tunnel still points at ClickHouse; it should point at the page and API.
