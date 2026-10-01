# wc3-gym-warehouse

A warehouse of Warcraft III replays. Replays sit in a Cloudflare R2 bucket. A Rust drain parses them, dbt loads and models them in ClickHouse, and a small API answers questions about them.

The design and build order are in [PLAN.md](PLAN.md). `docs/design/` predates the dbt prototype: its schema and routes describe the hand-written SQL this branch replaces.

Same rules as the other Warcraft-Gym repos: branch, PR to `main`, squash merge.

## Run it

Everything runs in Docker. `.env.example` holds a working local setup, with MinIO standing in for R2:

```
cp .env.example .env
just up          # clickhouse, minio with the 3 parser goldens, the drain, the api, the inspector, grafana
just drain-once  # parse the goldens now instead of within the drain's minute
just dbt build   # seed the mappings, load the parsed docs, build and test every model
just ch          # a clickhouse-client shell
```

The replay inspector is at http://localhost:3000, the API at http://localhost:8000 (docs at http://localhost:8000/docs), Grafana at http://localhost:3001 and dbt's docs at http://localhost:8080 (after `just local::docs`).

| Recipe | Does |
|---|---|
| `just dbt <args>` | any dbt command in the dbt container, such as `build`, `test` or `docs generate` |
| `just local::docs` | writes dbt's docs site (models, columns, tests, lineage) into the target volume that http://localhost:8080 serves |
| `just local::upload-replays <folder> <date> [dest]` | copies every `.w3g` under a folder changed since a date into the bucket's `replays/<dest>/` (default `local`), except `LastReplay.w3g` (a copy of the latest game), such as `just local::upload-replays /home/daniel/warcraft/w3warehouse/data/w3g/replay_service 2000-01-01 w3warehouse-ladder`; then `just drain-once` and `just dbt build` |
| `just local::mc <args>` | the MinIO client against the local bucket, aliased `local`, such as `just local::mc ls -r local/warehouse/preview/replays/goldens` |
| `just local::drain-test` | the drain's unit tests and parser goldens, in its image |
| `just local::mappings` | rewrites `dbt/seeds/mappings_melee.csv` from the parser's tables, after a w3grs bump |
| `just local::api-test` | the API tests in its container: compiler goldens, then the live cases |
| `just local::api-cases-update` | rewrites the answers in `api/tests/cases/` from the live stack |
| `just local::reset` | drops every volume |

## How it fits together

```
R2 or MinIO                        ClickHouse (dbt builds w3g.*)                  API            page
replays/<folder>/<file>.w3g  ─drain─▶ parsed/v5/dt=<date>/<id>.json ─dbt─▶ raw_replays ─▶ marts ─▶ /query  ─▶ web :3000
                                                                                              /search
```

1. Raw replays sit under `<env>/replays/`, where `<env>` (production, preview or development) is set as `W3WAREHOUSE_S3_PREFIX`. Every `.w3g` under `replays/` is drained the same way. Locally, `minio-setup` puts the 3 goldens under `replays/goldens/` with their own file names, and `just local::upload-replays` adds a folder, such as `replays/w3warehouse-ladder/`.
2. The drain (`pipeline/parse-rs`, w3grs) parses each new or changed file and writes the parsed document under `parsed/v5/`, with the raw object key as `source_key` and the time the bucket last wrote that file as `source_last_modified`. It never moves or deletes a raw file.
3. `just dbt build`:
   - `raw_replays` is an incremental model. It reads the dbt source `bucket.parsed_docs`, an S3 table over the `parsed_docs` named collection (`infrastructure/docker/clickhouse/named-collections.xml`) that dbt's `on-run-start` hook creates, and appends each document whose replay it does not hold at the same or a newer parse version. It reads both from the file path (`parsed/v<N>/…/<replay_id>.json`), so it skips a loaded document before ClickHouse fetches it. The URL and the keys come from the server's environment, so no secret lands in SQL. See [Loading the same replay twice](#loading-the-same-replay-twice).
   - The staging views flatten orders and hero skills.
   - The marts are tables that rebuild with an atomic swap.
4. The API reads the semantic catalog from dbt's `target/manifest.json` and queries ClickHouse as the read-only `api` user.

### dbt models (`dbt/`)

| Model | Grain |
|---|---|
| `raw_replays` | one parsed document per replay |
| `replays`, `replay_players` | replay header with readable map name, patch, result and `added_at`, and `duplicate_of` for a second file of one game; player per replay with the played race and `random` |
| `replay_events` | every order and hero skill per player in time order, with the played race; build-order steps match here |
| `player_games` | one row per player per 1v1 game, a game saved twice counted once: played races and `random` flags of both players, map, patch, `added_at`, result, heroes in pick order with their levels and the first three as `first_hero`..`third_hero`, the length in 5-minute bins (`minutes_5`), `opener_1`..`opener_6` |
| `player_order_events` | every order a player gave; a building placement keeps its map `x` and `y` |
| `mappings` | object codes and names: the melee seed plus the custom-map seed |
| `patches` (seed) | the game patch of each build number, kept by hand: 6117 is 2.0, 7000 is 3.0 |
| `object_sources` (seed), `objects` | the building, altar, camp or shop each melee object comes from, kept by hand and checked against the orders; `objects` adds each skill under its hero and each building under its race, for the step pickers |
| `player_heroes`, `player_group_hotkeys`, `chat`, `resource_transfers` | as named |

The opener tree is a `GROUP BY` over `player_games.opener_N`, so the refreshable rollup and its 10-minute staleness are gone.

Races: `race` is the played race. A player who picked a race played it (measured: every such player whose race the parser detected played that race). A player who picked Random played the race the parser detected, else the race letter of his first building or unit order code: the parser reads a race only from a train or research order, so a random player who only placed buildings has none. A random player with neither order keeps `RANDOM`: 9 of 3,492 player-games, all in games he left without an order. `random` is 1 when the player picked Random, so Night Elf with `random` 1 is a Random player who rolled Night Elf. `matchup` is built from the played races.

A replay header holds no date. `added_at` is the time the bucket last wrote the raw file, so it orders replays by when they were added, not when they were played.

The winner comes from the parser's `leaves` (observers skipped). A player leave marked victory (result `09000000`) names the winning team, because the winner can leave the victory screen before the loser's leave is logged. Otherwise the team opposite the first player to quit won: the first player leave, or the saver (`saverPlayerId`) when no player leave is recorded, because a FLO player-saved w3c- file drops the saver's own leave. `winning_team_id` is -1 unless the game has exactly two teams. One game can arrive as two files: they share `game_key` (random seed and sorted names), `duplicate_of` points the others at one copy (a recorded winner first, then the lowest id), and only `player_games` leaves duplicates out. The per-replay tables keep every file, because the replay page opens any file by id and build-order steps always join `player_games`.

### Loading the same replay twice

`replay_id` is a hash of game facts, not of the file bytes: the parser's SHA-256 of the random seed, the players' names in player-id order and the game name. Two files with the same facts are the same replay, and a re-parse keeps the id. Two files of one game whose facts differ get two ids and share a `game_key`, and `player_games` counts the game once.

`raw_replays` is a ReplacingMergeTree on `replay_id` with `parse_version` as its version, the ClickHouse pattern for replacing rows by version without `ALTER TABLE ... DELETE`:

- A second insert of a document adds a row that the next merge collapses. A document at a newer parse version replaces the older one the same way.
- Until that merge both rows are on disk, so every reader asks for the merged answer: each mart ends in `SETTINGS final = 1` and Grafana reads `raw_replays FINAL`. The uniqueness test is on `replays.replay_id`, which checks what the readers see.
- A dbt run loads a document only when its replay is not loaded at the same or a newer parse version, so a re-run adds no row. It reads the version from the path (`parsed/v<N>/`) and the id from the file name, so it skips a loaded file before ClickHouse fetches it.
- `OPTIMIZE TABLE w3g.raw_replays FINAL` merges at once. It is never needed for a correct answer.

### dbt docs and tests

- Every model, seed and column has a description in YAML. Shared terms (replay_id, race, matchup, order kinds) are doc blocks in `dbt/models/docs.md`. `+persist_docs` in `dbt_project.yml` writes them into ClickHouse as table and column comments, so `system.tables.comment` and `system.columns.comment` carry them. A description must not contain a semicolon: dbt 2.0.6 splits the comment DDL on it.
- Tests: `unique` and `not_null` on each table's key, with composite keys as an expression such as `replay_id || ':' || toString(player_id)`. `relationships` from `replay_players`, `player_games` and `replay_events` to `replays`. `accepted_values` on race, result, order kind and event type. Singular tests in `dbt/tests/`: two `player_games` rows per 1v1 game and none for a duplicate, no event after the game's end (a warning), no gap in the openers, one copy per `game_key`, and a patch for every build (a warning). Unit tests in `dbt/models/marts/unit_tests.yml` for the opener derivation, the `race_code` macro, and the result, duplicate and patch rules of `replays`. dbt 2.0.6 compares only their String columns.
- The source `bucket.parsed_docs` has freshness on the S3 `_time` virtual column: `just dbt source freshness`.
- Exposures in `dbt/models/exposures.yml` name the three readers: the replay inspector, the query API and Grafana.
- dbt's docs site has no column-level lineage: dbt v2 builds it from static analysis, which is off for ClickHouse. It also lists the dbt and ClickHouse adapter macros, which dbt 2.0.6 cannot hide.
- A parser change bumps `PARSE_VERSION` in `pipeline/parse-rs/src/lib.rs`. The drain stamps the version on each `status/` breadcrumb and into each document as `parse_version`, so its next pass re-parses every raw replay into the new `parsed/v<N>/` prefix; no breadcrumb needs clearing. A re-parsed document replaces the older one in `raw_replays`: set `W3WAREHOUSE_PARSED_URL` in `.env` to the new prefix, `just up` (ClickHouse reads it at start), `just drain-once`, then `just dbt build`.

## The query API (`api/`)

The catalog lives on the dbt models. `meta.semantic` in `dbt/models/marts/marts.yml` lists a model's dimensions (columns a caller may group or filter on) and measures (named aggregates), and the labels a page shows. A measure can carry a label, a type (`count` adds up across rows, `distinct` does not, `record`, `average`) and the summed `parts` it is made of, so a page that folds rows into "Other" still prints a record or an average exactly. A record has no SQL of its own: a page reads its parts, `wins` and `losses`. Adding a measure is a YAML edit and a `just dbt build`; the API picks up the new manifest on its next request.

| Route | Answers |
|---|---|
| `GET /catalog` | every semantic model: its dimensions with types, its measures, and the labels, types, parts and notes of what a page shows |
| `POST /query` | measures grouped by dimensions, under filters and an optional build order |
| `POST /objects` | a step picker's groups for a kind (building, unit, hired, upgrade, hero, skill, item) and a side's race values, each object with the player-games in scope that ordered it |
| `POST /search` | one page of the Player side's player-games, with the Player's figures (`summary`) and the same over the scope (`scope`) |

```
POST /search
{ "filters": { "map": ["Echo Isles 2.2"], "duration_ms": { "gte": 120000 } },
  "player":   { "race": ["NE"], "name": null, "outcome": "win", "opened_with": [],
                "groups": [ { "steps": [ { "kind": "hero", "codes": ["Edem"], "nth": 1 },
                                         { "kind": "unit", "codes": ["earc"], "count": 5, "to_s": 360 } ] } ] },
  "opponent": { "race": ["OC"], "groups": [ { "steps": [ { "kind": "hero", "codes": ["Obla"], "nth": 1 } ] } ] },
  "sort": "-added", "limit": 25, "offset": 0 }
```

- A side takes race values (`NE` is a picked Night Elf, `RN` a Random player who rolled Night Elf, `R` a Random player with no played race), a battle tag, the openers of an Openers row, and 1 to 4 groups of up to 8 steps. A group holds when all its steps hold; the side matches when any group holds. Only the Player has an outcome, because the Opponent's is its reverse.
- A step is at least `count` orders of any of `codes` (kind `building`, `unit`, `upgrade`, `item`, `hero` or `skill`; a skill count is the skill level), each inside `from_s` to `to_s`. A `then` step comes after the step above, within `within_s` when set; each run of `then` steps is one `sequenceMatch` with a counted step's condition repeated (at most 32 orders). An `and` step is its own condition, and `negate` makes it "did not happen". `nth` on a hero step reads `player_games.heroes`.
- The scope is the replay filters, both sides' races and names; `summary` adds the outcome, the openers and the steps. Both count player-games: a mirror game where both players fit the Player side counts once for each, a win and a loss, so it pulls the record toward 50%. `summary.both_players` says how many games count twice, and the page prints it.
- `sort` is `added` (when the bucket got the replay), `duration` or `map`, with `-` for descending. The answer holds the two statements it ran in `sql`.

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

A Next.js app in the wc3-gym-frontend look, light and dark, at http://localhost:3000. `/` searches strategies (`POST /search`): the Player and the Opponent each take a race from the race menu (with a Random submenu and an "Include Random" switch), a battle tag and steps, picked from cascading pickers (`POST /objects`) and grouped into alternatives; the Player also takes an outcome, and Swap trades the sides. Map, patch and length scope the games. The Games card lists one player-game a row, 25 a page, under three figures: games, the Player's record and the average length, each against its scope. `/openers` is the opener tree of one race, a level per building, most played or best win rate first; a row counts games won or lost, one per player, and links to its games on `/` as an "Opened with" condition (`POST /query` on `player_games.opener_N`). `/explore` counts anything by anything: the measures to show, up to two dimensions for the chart (rows and a column) and filters, read from `POST /query` on each change. The chart follows the measure types: tiles with no dimension, bars of a count by one dimension (columns for the 5-minute bins), a heat map of a count by two, and no chart for a record or an average alone or for three dimensions; the table under it lists every row. It starts at games of 2 minutes or more. The URL holds every filter, step and open row, so a link rebuilds the page. `/replays/<id>` shows one game: the players, their heroes and skills, APM per minute, both build orders and the chat (`GET /replays/{id}`, plus one `POST /query` on `mappings` for the names). Opened from a search with steps, a game carries the search (`q`, the Replays query) and its Player (`side`), and the page marks the orders each step matched with the step's number, on the chart and in the lists. It reads the steps on the page's own orders as `POST /search` does, so a tier hall or research clicked twice within a second, which the page drops, can count once fewer than in the search. Server components read the API at `API_URL` (`http://api:8000` in compose), so the browser never calls it. The object and race icons live in `web/public/`.

| Recipe | Does |
|---|---|
| `just local::web-lock` | rewrites `web/pnpm-lock.yaml` after a `web/package.json` change, in a node container |
| `just local::web-lint` | eslint, in the lint stage of the web image |

## Observability (Grafana)

Grafana is at http://localhost:3001, anonymous admin by default (the `GF_AUTH_*` variables in `compose.yaml` turn that off). It reads ClickHouse as the read-only `grafana` user (`infrastructure/docker/clickhouse/users.xml`). The datasource and three dashboards are provisioned from `infrastructure/docker/grafana/`:

| Dashboard | Shows | Source |
|---|---|---|
| ClickHouse server | queries per second, running queries, memory, CPU, merges and active parts, inserted rows | `system.metric_log`, `system.asynchronous_metric_log` |
| Query API | the `api` user's queries per minute, errors, p50/p95/p99 duration, rows and bytes read, the slowest normalized queries | `system.query_log` |
| Warehouse data | replays loaded over time, rows, size and last rebuild per `w3g` table, dbt queries and errors per node | `w3g.raw_replays`, `system.parts`, `system.tables`, `system.query_log` |

`just local::e2e --grep grafana` runs every panel query through Grafana and screenshots each dashboard to `web/e2e/shots/grafana-<name>.png`.

## Not here yet

- The swimlane chart of the build orders (`docs/design/frontend.md` 12.3). The inspector shows the list view.
- Creep routes. A replay holds commands, and a creep death alone cannot say whether the player cleared the camp or an enemy stole it. That waits for stat-events maps.
- Stat-events. A future parser output adds a section to the parsed document, and dbt gets a staging model for it.
- The `is_repeat` order flag and `replays.source_key` (design S3, S5).
- Hosting. The `prod` profile's tunnel still points at ClickHouse; it should point at the page and API.
