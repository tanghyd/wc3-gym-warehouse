# wc3-gym-warehouse

A warehouse of Warcraft III replays. Replays sit in a Cloudflare R2 bucket. A Rust drain parses them into ClickHouse, dbt models them, and a small API answers questions about them.

The design and build order are in [PLAN.md](PLAN.md). `docs/design/` predates the dbt prototype: its schema and routes describe the hand-written SQL this branch replaces.

Same rules as the other Warcraft-Gym repos: branch, PR to `main`, squash merge.

## Run it

Everything runs in Docker. `.env.example` holds a working local setup, with MinIO standing in for R2:

```
cp .env.example .env
just up          # clickhouse, minio with the 3 parser goldens, the api, the inspector, grafana
just ingest      # one drain pass over the bucket, then dbt build when it inserted documents
just dbt build   # seed the mappings, read ingest.docs, build and test every model
just ch          # a clickhouse-client shell
```

The replay inspector is at http://localhost:3000, the API at http://localhost:8000 (docs at http://localhost:8000/docs), Grafana at http://localhost:3001 and dbt's docs at http://localhost:8080 (after `just local::docs`).

| Recipe | Does |
|---|---|
| `just dbt <args>` | any dbt command in the dbt container, such as `build`, `test` or `docs generate` |
| `just local::docs` | writes dbt's docs site (models, columns, tests, lineage) into the target volume that http://localhost:8080 serves |
| `just local::upload-replays <folder> <date> [dest]` | copies every `.w3g` under a folder changed since a date into the bucket's `replays/<dest>/` (default `local`), except `LastReplay.w3g` (a copy of the latest game), such as `just local::upload-replays /home/daniel/warcraft/w3warehouse/data/w3g/replay_service 2000-01-01 w3warehouse-ladder`; then `just ingest` |
| `just ingest` | one drain pass (`just drain-once`), then `just dbt build` when the drain inserted a document or the last build failed; a host cron runs it |
| `just local::mc <args>` | the MinIO client against the local bucket, aliased `local`, such as `just local::mc ls -r local/warehouse/preview/replays/goldens` |
| `just local::drain-test` | the drain's unit tests and parser goldens, in its image |
| `just local::mappings` | rewrites `dbt/seeds/mappings_melee.csv` from the parser's tables, after a w3grs bump |
| `just local::api-test` | the API tests in its container: compiler goldens, then the live cases and the oracles |
| `just local::api-cases-update` | rewrites the answers in `api/tests/cases/` from the live stack |
| `just local::api-lock` | rewrites `api/uv.lock` after an `api/pyproject.toml` change, in the API image |
| `just local::reset` | drops every volume |

## How it fits together

```
R2 or MinIO (read only)            ClickHouse (dbt builds w3g.*)                  API            page
replays/<folder>/<file>.w3g  ─drain─▶ ingest.docs ─dbt─▶ raw_replays ─▶ marts ─▶ /query  ─▶ web :3000
                                                                        /search
```

1. Raw replays sit under `<env>/replays/`, where `<env>` (production, preview or development) is set as `W3WAREHOUSE_S3_PREFIX`. Every `.w3g` under `replays/` is drained the same way. Locally, `minio-setup` puts the 3 goldens under `replays/goldens/` with their own file names, and `just local::upload-replays` adds a folder, such as `replays/w3warehouse-ladder/`.
2. `just ingest` runs the drain (`pipeline/parse-rs`, w3grs) once. Per source it lists the replay prefix, 1,000 keys a request, and compares each `.w3g` with its row in `ingest.files` (ETag, size and parse version), a ClickHouse query, not a bucket read. It parses each new or changed file and inserts the document into `ingest.docs`, with the raw object key as `source_key` and the time the bucket last wrote that file as `source_last_modified`, and a row into `ingest.files`. A file that fails to parse gets a row with its `error` and waits for a new upload or parser version. The drain inserts over HTTP as the `ingest` user, which may only SELECT and INSERT on `ingest.*` (`infrastructure/docker/clickhouse/users.xml`, tables in `ingest.sql`). It only reads the buckets, so its key can be read-only: it never writes, moves or deletes an object. A second read-only source, such as a W3Champions bucket, is the `W3WAREHOUSE_SOURCE2_*` set in `.env`. When the drain inserted a document, or the last build failed (the git-ignored marker `data/dbt-build-pending` is set before a build and removed when it succeeds), `just ingest` runs `just dbt build`.
   ClickHouse runs `ingest.sql` only on an empty volume, so an existing volume needs it once: `just local::sql --multiquery < infrastructure/docker/clickhouse/ingest.sql` (every statement is `IF NOT EXISTS`).
   The compose network is fixed at 172.30.0.0/24 (`compose.yaml`), and the `default` user accepts only that subnet and loopback, the `ingest` user only that subnet (`infrastructure/docker/clickhouse/users.xml`). A different subnet needs both files changed.
3. `just dbt build`:
   - `raw_replays` is a table rebuilt every run from the dbt source `ingest.docs`, read FINAL: per replay, the document at the highest parse version, then the newest `source_last_modified`. ClickHouse holds no bucket key or URL. See [Loading the same replay twice](#loading-the-same-replay-twice).
   - The staging view `valid_replays` reads `raw_replays FINAL` and leaves out every game in which a player gave no order (40 of 1,746 loaded games; 56 players gave no order). The marts `player_order_events` and `hero_ability_events` flatten orders and hero skills from it. Every mart reads `valid_replays`, so no mart, count, search or replay page sees such a game; `raw_replays` keeps its document.
   - The marts are tables that rebuild with an atomic swap.
4. The API reads the semantic catalog from dbt's `target/manifest.json` and queries ClickHouse as the read-only `api` user.

### dbt models (`dbt/`)

| Model | Grain |
|---|---|
| `raw_replays` | one parsed document per replay |
| `replays`, `replay_players` | replay header with readable map name, patch, result and `added_at`, and `duplicate_of` for a second file of one game; player per replay with the played race and `random` |
| `replay_events` | every order and hero skill per player in time order, with the played race, `is_repeat`, the `level` a skill point gives, the `x` and `y` of a building placement, and each hero at the order that trained it; build-order steps match here |
| `player_games` | one row per player per 1v1 game, a game saved twice counted once: played races and `random` flags of both players, map, patch, `added_at`, result, heroes in pick order with their levels and the first three as `first_hero`..`third_hero`, the length in 5-minute bins (`minutes_5`), `opener_1`..`opener_6`, and the opponent's start location (`opp_start_x`, `opp_start_y`) |
| `player_order_events` | every order a player gave; a building placement keeps its map `x` and `y` |
| `player_starts` | the start location of each player of a 1v1 replay and the rule that named it (see [Start locations and the tower rush](#start-locations-and-the-tower-rush)) |
| `start_locations` (seed) | the start locations of each map the replays carry, from the map files or, for 4 maps with no file, from where players build |
| `mappings` | object codes and names: the melee seed plus the custom-map seed |
| `patches` (seed) | the game patch of each build number, kept by hand: 6117 is 2.0, 7000 is 3.0 |
| `object_sources` (seed), `objects` | the building, altar, camp or shop each melee object comes from, kept by hand and checked against the orders; `objects` adds each skill under its hero and each building under its race, for the step pickers |
| `player_heroes`, `chat` | as named |

The opener tree is a `GROUP BY` over `player_games.opener_N`, so the refreshable rollup and its 10-minute staleness are gone.

Races: `race` is the played race. A player who picked a race played it (measured: every such player whose race the parser detected played that race). A player who picked Random played the race the parser detected, else the race letter of his first building or unit order code: the parser reads a race only from a train or research order, so a random player who only placed buildings has none. A random player with neither order keeps `RANDOM`: 9 of the 3,492 players, all in games he left without an order. `random` is 1 when the player picked Random, so Night Elf with `random` 1 is a Random player who rolled Night Elf. `matchup` is built from the played races.

A replay header holds no date. `added_at` is the time the bucket last wrote the raw file, so it orders replays by when they were added, not when they were played.

The winner comes from the parser's `leaves` (observers skipped). A player leave marked victory (result `09000000`) names the winning team, because the winner can leave the victory screen before the loser's leave is logged. Otherwise, in 1v1, the player opposite the first to quit won: the first player leave, or the saver (`saverPlayerId`) when no player leave is recorded, because a FLO player-saved w3c- file drops the saver's own leave. In a team game the other team won when every player of one team left before any player of the other. Otherwise `winning_team_id` is -1, as it is unless the game has exactly two teams. On the 1,706 loaded games the result matches the parser's leave-based pick (`winningTeamId`); both read the same leave blocks, so the match does not check the rule. The saver fallback is untested until the w3grs saver id is fixed: `saverPlayerId` is 1 in all 1,706 files.

One game can arrive as two files: they share `game_key` (random seed and sorted names). The most complete copy stands for the game (the longest, then the one with the most orders and skill points, then the lowest id), `duplicate_of` points the others at it, and only `player_games` leaves duplicates out. The per-replay tables keep one row per `replay_id`, duplicates included, because the replay page opens a file by id and build-order steps always join `player_games`. They do not keep every file: two files whose random seed, names and game name all match hash to one `replay_id` (below), so `raw_replays` holds the one the bucket wrote last and `duplicate_of` never sees the other. W3C game names are unique per game, so the service copy and a player-saved copy of one W3C game are such a pair.

### Loading the same replay twice

`replay_id` is a hash of game facts, not of the file bytes: the parser's SHA-256 of the random seed, the players' names in player-id order and the game name. Two files with the same facts are the same replay, and a re-parse keeps the id. Two files of one game whose facts differ get two ids and share a `game_key`, and `player_games` counts the game once.

`ingest.docs` and `ingest.files` are ReplacingMergeTrees on `(source, key)`, versioned by `parse_version`, then `source_last_modified`: the ClickHouse pattern for replacing rows by version without `ALTER TABLE ... DELETE`.

- A re-parse of an object (a parser bump or a re-upload) adds a row that the next merge collapses into the newer one. A second insert at the same version keeps the later row.
- Until that merge both rows are on disk, so readers ask for the merged answer: the drain reads `ingest.files FINAL` and dbt reads `ingest.docs FINAL`.
- `raw_replays` is rebuilt from it every run with one row per `replay_id`, so a re-run adds no row. It stays a ReplacingMergeTree on `replay_id` so that `valid_replays`, which every mart reads, and Grafana can read it FINAL. The uniqueness test is on `replays.replay_id`, which checks what the readers see.
- `OPTIMIZE TABLE ingest.docs FINAL` merges at once. It is never needed for a correct answer.

### Start locations and the tower rush

A replay names no start position, so `player_starts` reads it from where each player builds, against the start locations of the `start_locations` seed:

1. The start within 1,500 units of the player's earliest building placement that lies within 1,500 of any start.
2. Else, on a two-start map, the start the opponent does not hold.
3. Else none: `start_x` and `start_y` are NULL.

On the 1,706 loaded games: 3,385 players by rule 1 on the first building, 23 by rule 1 on a later building (18 to 96 s), 3 by rule 2 (8aac280e, e9d56e5b, a28d133b) and 1 with none (6361c666: the Undead gave no building order on a four-start map). The seed has two sources: `map file`, the 28 start locations (`sloc` units) of the 12 W3Champions map files in wc3-gnl-website `map-sources/`, as its creep-route catalogues `src/lib/creep-routes/maps/*.json` list them; and `cluster`, 8 centres of the players' first buildings for the 4 maps with no file there (Boulder Vale 1.7, Concealed Hill, Northern Isles, Springtime 1.3).

A tower placement is forward when it is under 3,000 units from the opponent's start; a player tower rushes when 2 or more of his forward towers fall in the step's window (`forward` on a building step, the Forward switch in the step editor). The presets: Human Scout Tower x3 by 4:00 with 2 of them forward (25 games), Orc Watch Tower x2 forward by 5:00 (6, 2 of them by a Random player), Night Elf Ancient Protector x2 forward by 5:00 (2). No Undead preset: a Ziggurat is also the farm.

The assumptions (measured in `threads/warehouse-dbt-prototype/review/start-positions.md`):

1. The map name and version the replay carries fix the start locations.
2. The map files (W3C builds of 2026-09-19) have the starts of the builds the replays used (2025-11-04 to 2026-06-15): first buildings sit p50 530 to 588 and p90 705 to 820 units from a file start on all 12 maps.
3. Slot, colour and player id do not decide the start (player 1 at the first file start in 766 games, at the second in 740).
4. Two players never share a start: 0 of 1,679 games.
5. A placement within 1,500 of a start stands at the player's own start: starts are 4,172 or more apart, and every first building is 3,621 or more from its second-nearest start.
6. On the 4 maps with no file (97 games) a start is a cluster centre; on the 12 file maps that centre lies 99 to 382 from the file start.
7. The start stays the opponent's home when his base moves.
8. A placement order is a building: a cancelled or blocked tower counts.
9. 3,000 units and "2 or more" are a chosen rule, not measured; the windows are the presets'.

The open guess is 7: an empty start location still counts as the opponent's home. It decides one game, 8aac280e (Springtime 1.4): the Night Elf builds only around the middle gold mine, and the Random Orc's 5 Watch Towers at 221 to 286 s stand 405 to 1,190 from the Night Elf's start but 3,821 or more from his first building. By the start it is a rush.

### dbt docs and tests

- Every model, seed and column has a description in YAML. Shared terms (replay_id, race, matchup, order kinds) are doc blocks in `dbt/models/docs.md`. `+persist_docs` in `dbt_project.yml` writes them into ClickHouse as table and column comments, so `system.tables.comment` and `system.columns.comment` carry them. A description must not contain a semicolon: dbt 2.0.6 splits the comment DDL on it.
- Tests: `unique` and `not_null` on each table's key, with composite keys as an expression such as `replay_id || ':' || toString(player_id)`. `relationships` from `replay_players`, `player_games` and `replay_events` to `replays`. `accepted_values` on race, result, order kind and event type. Singular tests in `dbt/tests/`: two `player_games` rows per 1v1 game and none for a duplicate, no event after the game's end (a warning), no gap in the openers, one copy per `game_key`, an order from every player of a game in the marts, a patch for every build (a warning), 2 or 4 start locations per map and no two players of a game at one start. Unit tests in `dbt/models/marts/unit_tests.yml` for the opener derivation, the `race_code` macro, the 1v1 result, team-game result, duplicate and patch rules of `replays`, and the three rules of `player_starts`. dbt 2.0.6 compares their String and float columns, not the integer or array ones.
- The source `ingest.docs` has freshness on `ingested_at`, when the drain inserted the document: `just dbt source freshness`.
- Exposures in `dbt/models/exposures.yml` name the three readers: the replay inspector, the query API and Grafana.
- dbt's docs site has no column-level lineage: dbt v2 builds it from static analysis, which is off for ClickHouse. It also lists the dbt and ClickHouse adapter macros, which dbt 2.0.6 cannot hide.
- A parser change bumps `PARSE_VERSION` in `pipeline/parse-rs/src/lib.rs`. The drain stamps the version on each `ingest.files` row and into each document as `parse_version`, so the next `just ingest` re-parses every raw replay and rebuilds the marts on the new documents. No `.env` edit, no restart.
- Never lower `PARSE_VERSION`: revert a parser change by bumping it forward, because FINAL keeps the row at the higher version.

## The query API (`api/`)

The catalog lives on the dbt models. `meta.semantic` in `dbt/models/marts/marts.yml` lists a model's dimensions (columns a caller may group or filter on) and measures (named aggregates), and the labels a page shows. A measure can carry a label, a type (`count` sums, `distinct` does not, `record`, `average`) and the summed `parts` it is made of, so a page that folds rows into "Other" still prints a record or an average exactly. `POST /query` adds the column `shown` to `player_games`: 1 on one player of each game in a result row, the lower player slot when both players fall in it, so `games`, `wins`, `losses` and the minutes count each game once a row, while `players` and the APM measures read every player. A game whose two players fall in two rows (by race, say) counts in both, so a page reads a total on its own instead of adding rows up. A record has no SQL of its own: a page reads its parts, `wins` and `losses`. Adding a measure is a YAML edit and a `just dbt build`; the API picks up the new manifest on its next request.

| Route | Answers |
|---|---|
| `GET /catalog` | every semantic model: its dimensions with types, its measures, and the labels, types, parts and notes of what a page shows |
| `POST /query` | measures grouped by dimensions, under filters and an optional build order |
| `POST /objects` | a step picker's groups for a kind (building, unit, hired, upgrade, hero, skill, item) and a side's race values, each object with the games in scope in which a player of the side ordered it |
| `POST /search` | one page of the games that fit both sides, with their figures (`summary`) and the same over the scope (`scope`) |
| `GET /strategies` | the strategy presets of `api/strategies.yaml`: `id`, `name`, `race`, `parent_id`, `source`, `vs_races` and their own `steps` |
| `POST /strategies/stats` | games, wins, losses and summed length of the games in scope with a player of the race, and of each of its presets, in one statement |

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
- A step is at least `count` orders of any of `codes` (kind `building`, `unit`, `upgrade`, `item`, `hero` or `skill`), each inside `from_s` to `to_s`; `exactly` makes the count exact. A skill count is the skill level: one point that takes the skill to `count` or more, counted since the hero's last retraining, and `exactly` makes it the highest level. A repeat click (a tier hall, research, hero order or skill point under 1000 ms after the same one) is no order, and nor is a skill point past level 3. A hero step reads the order that trained the hero, and `nth` makes it the side's 1st, 2nd or 3rd hero (`player_games.heroes`). A `then` step comes after the order that completes the step above, all its orders within `within_s` of that order when set; each run of `then` steps is one match over the player's order times. A `before` step counts its orders before the order that completes step `before` of the group, and with `negate` holds when there is none. An `and` step is its own condition, and `negate` makes it "did not happen". `forward` on a building step keeps only placements under 3,000 map units from the opponent's start location (`player_games.opp_start_x`, `opp_start_y`), so its `count` counts forward placements; a player whose opponent has no start has none.
- A result is a game: the Player side's conditions hold for one player and the Opponent side's for the other. When they hold both ways round (a mirror game where each player fits the Player side), it is still one row, shown from the lower player slot with `both: true`, and `summary.both` counts such games. The scope is the replay filters, both sides' races and names; `summary` adds the outcome, the openers and the steps. Both count games. Their `wins` and `losses`, the shown Player's, are null unless something tells the Player side from the Opponent side: race values, a name, openers, steps or the outcome (for the scope, race values or a name). With equal sides every game fits both ways round, so a record says nothing.
- `sort` is `added` (when the bucket got the replay), `duration` or `map`, with `-` for descending. The answer holds the two statements it ran in `sql`.

```
POST /query
{ "dimensions": ["opponent_race"], "measures": ["games", "win_rate"],
  "filters": { "race": ["N"], "minutes": { "gte": 10 } },
  "steps": [ { "type": "building", "code": "eaom" },
             { "type": "building", "code": "edob", "within_prev_s": 30 } ] }
```

A filter is a list of values or a `{gte, lte}` range. A step names an event type and object code. A step may bound the gap since the previous step (`within_prev_s`) and its own game time (`from_min`, `to_min`). Steps compile to `sequenceMatch` over `replay_events`. Every request value travels as a ClickHouse query parameter; names must come from the catalog.

```
POST /strategies/stats
{ "race": ["HU"], "opponent_race": ["NE"], "filters": { "map": ["Echo Isles 2.2"], "duration_ms": { "gte": 120000 } } }
```

A preset in `api/strategies.yaml` is a named Player side: one group of `POST /search` steps, for one race. A variant (`parent_id`) holds its parent's steps, then its own, so its games never pass its parent's. The API checks the file at start: unique ids, a parent of the same race, and every group one that `POST /search` takes. The stats statement holds one `countIf` set per preset of the race over the games in scope with a player of the race, each condition compiled as the Player side of a search and each game counted once with the search's shown player, so a preset's figures equal `POST /search`'s `summary` for its steps. Sources: the 24 builds of w3warehouse with their expansion times (`w3warehouse`), presets added here, such as the Human, Orc and Night Elf tower rushes (`gym-replays`), and the 32 build orders of the wc3-gnl-website as the steps every player who follows the guide does (`wc3-gnl-website`, with the guide's full order kept as a note).

`api/tests/cases/*.json` are request and response pairs against the 3 goldens. They are plain JSON so a later Rust port of the API can run the same cases. `api/tests/oracles/*.json` are hand-labelled searches: each names about 10 loaded games and the games its steps must match there, with the player shown and the games marked both, chosen and labelled by the SQL beside it (`<name>.sql`) on the order tables, not through the compiler. No recipe rewrites them.

## The replay inspector (`web/`)

A Next.js app in the wc3-gym-frontend look, light and dark, at http://localhost:3000. `/` searches strategies (`POST /search`): the Player and the Opponent each take a race from the race menu (with a Random submenu and an "Include Random" switch), a battle tag and steps, picked from cascading pickers (`POST /objects`) and grouped into alternatives, a building step optionally Forward; the Player also takes an outcome, Swap trades the sides, and "Load a strategy" fills a side's steps from a preset of its race. Map, patch and length scope the games. The Games card lists one game a row, 25 a page, under the games and, when something tells the sides apart, the Player's record, each against its scope; a game either player fits shows from the lower player slot with a "both" tag after the name; Show switches hide the heroes, the result or the length (`hide` in the URL). `/strategies` lists the named strategies of one race (`GET /strategies`, `POST /strategies/stats`): each preset's games, its share of the race's games (a variant's of its parent) on a meter, the record and the average length; the games number and Search open Replays with the preset in the Player side. Its Openers tab, `/strategies/openers` (the old `/openers` redirects there), is the opener tree of one race, a level per building, most played or best win rate first; a row counts the games won or lost in which a player opened that way, once when both did, and links to its games on `/` as an "Opened with" condition (`POST /query` on `player_games.opener_N`). Both tabs share one filter row, which applies each change, and start at games of 2 minutes or more. `/explore` counts anything by anything: the measures to show, up to two dimensions for the chart (rows and a column) and filters, read from `POST /query` on each change. The chart follows the measure types: tiles with no dimension, bars of a count by one dimension (columns for the 5-minute bins), a heat map of a count by two, and no chart for a record or an average alone or for three dimensions; the table under it lists every row. The games chip and a heat map's totals are read on their own, since a game counts in each row one of its players falls in; Other adds up the rows it folds. It starts at games of 2 minutes or more. The URL holds every filter, step and open row, so a link rebuilds the page. `/replays/<id>` shows one game: the players, their heroes and skills, APM per minute, both build orders and the chat (`GET /replays/{id}`, plus one `POST /query` on `mappings` for the names). Opened from a search with steps, a game carries the search (`q`, the Replays query) and its Player (`side`), and the page marks the orders each step matched with the step's number, on the chart and in the lists. It reads the steps as `POST /search` does, on the same orders: a repeat click neither counts nor shows, and a hero shows at the order that trained it. Server components read the API at `API_URL` (`http://api:8000` in compose), so the browser never calls it. The object and race icons live in `web/public/`: the classic command-card art in `icons-classic/`, the Reforged set in `icons/` for the codes classic lacks.

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
- `replays.source_key` (design S5).
- Hosting. No box runs the stack yet. The `prod` profile's tunnel publishes the inspector only.
