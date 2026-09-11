# Warehouse API contract

- Scope: the HTTP contract of the Rust service (axum + serde + reqwest) for the stories in `stories.md`. SQL shape lives in `queries.md`; SQL appears here only where it fixes a contract rule. Rule names come from the `clickhouse-best-practices` skill.
- `w3warehouse:` = `/home/daniel/code/warcraft/w3warehouse/services/api/src/api/` at 8a204c9. `gnl-frontend:` = `wc3-gym-frontend` at `origin/main`.
- Examples are real output from the 3 fixture replays (6 players, 323 `replay_events` rows) unless marked "cut".
- **(F)** = measured 2026-09-11 on 26.9.1 over the dev load: 6,567 replays (6,564 from `gs://w3warehouse-05b6-replays/w3g/gnl/` + 3 fixtures, loaded by parse bin + `INSERT ... FROM file()`), 950,132 `replay_events`, 12,881 `replay_openers` rows. Debugging only; the org deploy holds only app-reported GNL replays. **(X)** = measured on the fixtures.
- PR 2 pins compose.yaml:12, :43 and infrastructure/ci.yml:26 to `clickhouse-server:26.8` (26.8 LTS; today 24.10). All facts were measured on 26.9; PR 2 re-runs them on 26.8, and re-measures fixture numbers after the repeat flag (2.1).

## 1. Routes

| # | Method and path | Serves | Cache |
|---|---|---|---|
| 1 | `GET /health` | Ops probe only (`curl` from the box). No UI and no compose healthcheck calls it (rust.md §15). | `no-store` |
| 2 | `GET /mappings` | Story 1 picker, story 2 row names, story 4 timeline names | 1 hour |
| 3 | `GET /filters` | Shared filter row: map and player lists | 60 s |
| 4 | `POST /search` | Story 1 | `no-store` |
| 5 | `GET /openers` | Story 2, one tree level | 60 s |
| 6 | `GET /openers/replays` | Story 2, the row's replay button | 60 s |
| 7 | `GET /stats` | Story 3 | 60 s |
| 8 | `GET /replays/{id}` | Story 4 | 1 hour |

Not routes:

| Need | Source |
|---|---|
| `.w3g` download | The public R2 URL in `download_url` (2.5). The API never streams the file. |
| Command-card icons | Static frontend asset: `frontend/icons.json` maps a code to a file in `frontend/icons/` (index.html:1018-1019). The API sends codes only. |

## 2. Conventions

### 2.1 Wire format

| Rule | Value |
|---|---|
| Base path | The service serves at `/`. The browser calls `/api/...`. The Vite dev proxy strips `/api` (gnl-frontend: `vite.config.js`, proxy `rewrite`). The prod proxy does the same (2.9). Same origin, no CORS. |
| Body | JSON, UTF-8, `snake_case` keys |
| Player race | One letter as stored in `replay_players.race`: `H`, `O`, `N` (Night Elf), `U`, `R` |
| Matchup | As stored in `replays.matchup`, e.g. `"NvO"` |
| Times | `time_ms` = ms from game start. `duration_ms` = game length. Integers. |
| Object codes | 4 chars, case-sensitive, exactly as in `w3g.mappings.code` |
| Replay id | 64 lower-case hex chars (measured `length(replay_id) = 64`) |
| Empty query value | `race=` equals no `race`. The GNL `pageQuery` drops empty keys the same way (gnl-frontend: `src/helpers/fetch-wrapper.js:20-31`). |
| Unknown query key or body field | 400 (as w3warehouse: models.py:9-14) |
| SQL values | Every value is a bound `{name:Type}` parameter. Measured on 26.9: `sequenceMatch({pat:String})`, `IN {ids:Array(String)}`, `seq[{d:UInt8}]` and `LIMIT {limit:UInt32} OFFSET {offset:UInt32}` accept bound values (queries.md §0, §7). |
| Orders, not outcomes | Replays record commands, so every count and timeline row is an **order**. Finished-object counts wait for stat-events. Field names stay; the UI labels them "ordered". |
| Repeat flag | `is_repeat UInt8`, computed at load on `player_order_events` and `replay_events` (PR 2). 1 on a same-code order by one player less than 1000 ms after that player's previous same-code order, only for single-instance codes: the tier halls `hkee hcas ostr ofrt unp1 unp2 etoa etoe`, research (codes starting `R`), and hero training (hero codes, in the `unknown` bucket via `mv__order_unknown`). Buildings and units stay raw. The first order keeps its time. Flag, never delete. Search, openers, counts and stats read `is_repeat = 0`; the timeline hides flagged rows. |

Why (F): tier and research repeat almost only under 1 s (Stronghold 1,052 of 1,071); farms, towers and unit queues repeat at every gap. On 3 LAN stat-events games the rule fixed heroes exactly (14 orders → 8 = 8 real starts) and no time rule beat raw for buildings or units (`/home/daniel/.claude/jobs/ac2bfdc7/tmp/design-ground/order-calibration.md`). Tier halls sit in the buildings bucket, so the rule uses the code list, not the kind.

### 2.2 Shared filters

`/openers`, `/openers/replays` and `/stats` take the same keys. `POST /search` carries them in its body (2.3).

| Key | Type | Bounds | Meaning |
|---|---|---|---|
| `race` | letter | `H O N U R` | Race of the focus player |
| `opponent_race` | letter | `H O N U R` | Race of the other player |
| `player` | string | 1-64 chars | Focus player name. Exact, case-insensitive (`lowerUTF8()` on both sides, queries.md §1). |
| `map` | string | 1-64 chars | Exact map name, as `GET /filters` lists it |
| `min_minutes` | integer | 0-180 | `duration_ms >= min_minutes * 60000` |
| `max_minutes` | integer | 0-180, not below `min_minutes` | `duration_ms <= max_minutes * 60000` |

- No defaults. Bounds as w3warehouse: models.py:209-221, 290-300.
- A game passes when it has players P and Q on different teams. P matches `race` and `player`. Q matches `opponent_race`.
- P is the opener's owner on `/openers` (views.sql:52, index.html:887). On `/stats`, P and Q only select the cohort.
- Every route adds `replays.type = '1on1'` (index.html:750, views.sql:80).
- Decided: `R` is a fifth race, so `race=O` skips a Random who rolled Orc. Why: the rolled race is out of scope (`race_detected` has it for 964 of 1,004 Random players (F), queries.md §4.1 rule 4).
- No season or team filter until the dims loader (after the four pages).

### 2.3 Filter-row keys on `/search`

The search body has no top-level `race`, `opponent_race` or `player`; each slot carries them, so two race fields cannot conflict:

| Route query key | Search body field |
|---|---|
| `race` | `groups[0].race` |
| `opponent_race` | `groups[1].race` |
| `player` | `groups[0].player` |
| `map`, `min_minutes`, `max_minutes` | same top-level name |

### 2.4 Paging and order

`POST /search` and `GET /openers/replays` follow the GNL list convention:

| Part | Rule | Source |
|---|---|---|
| Query keys | `limit` 1-100, default 25 (index.html:291); `offset` 0-10000, default 0 | fetch-wrapper.js:20-31 |
| Total | `X-Total-Count` header | fetch-wrapper.js:11-12, 162 |
| Body | JSON array of rows | fetch-wrapper.js:162-163 |

- **One fixed order:** `gnl_series_id DESC, gnl_game_no DESC, replay_id`. `/openers/replays` appends `focus_player_id` (row key, 2.5). No `sort` or `order` key (A2).
- Today it is a tie: all 6,567 replays have `gnl_series_id = 0` (F), so `replay_id` decides. `replays` has no play date (only `ingested_at`). Decided: keep it; the PR 3 re-stage adds a play date if the drain can read the upload time.
- On `POST /search`, `limit`/`offset` are query keys, not body fields (`postPage`, fetch-wrapper.js:11).
- Total = `count() OVER ()` in the page query. (X): 3 rows match, `LIMIT 2 OFFSET 1` gave 2 rows, each `total = 3`. Each page re-runs the query (cost: queries.md §2, §5 S1).

### 2.5 The replay row

`POST /search` and `GET /openers/replays` return this row. It feeds the shared replay table.

| Field | Type | Meaning |
|---|---|---|
| `replay_id` | string | 64 hex |
| `map` | string | `""` when the file name gives none |
| `matchup` | string | e.g. `"NvO"` |
| `duration_ms` | integer | Game length |
| `winning_team_id` | integer | `-1` when unknown (views.sql:108) |
| `gnl` | object or null | `{"series_id": int, "game_no": int}`. Null when `gnl_series_id = 0` (tables.sql:33-36). The UI shows it as text. |
| `download_url` | string or null | `DOWNLOAD_BASE_URL` + `replays.source_key` when both are non-empty, else null. The UI then shows "No file". |
| `focus_player_id` | integer or null | The player the result column reports. `/search`: the player `groups[0]` bound to; null with no groups; the lower `player_id` when both fit. `/openers/replays`: the opener's owner (3.6). |
| `players` | array | Sorted by `player_id`. Item: `player_id` int, `name` string, `race` letter, `team_id` int, `won` bool or null (null when `winning_team_id < 0`). |

- Row key: `(replay_id, focus_player_id)`. On `/openers/replays` a mirror game can appear twice (3.6).
- `source_key` (queries.md §5 S3, PR 3): the drain writes the raw R2 object key into each doc; `replays.source_key String DEFAULT ''` stores it. PR 3 re-stages the staging bucket (drain re-run, breadcrumbs cleared). Rows not loaded by the drain (fixtures, dev load) keep `''`.
- Names carry no flag and no MMR until the dims loader lands.

### 2.6 Errors

Every non-2xx answer is `{"error": "<text>"}` with `Cache-Control: no-store`. The GNL fetch wrapper reads `body.error` (gnl-frontend: fetch-wrapper.js `responseError`).

| Status | When | Example `error` text |
|---|---|---|
| 400 | Field fails validation. Text starts with the field path. | `groups[0].steps[1].subject_code: "eaox" is not a building code` |
| 400 | Body is not valid JSON, or has an unknown field | `body: unknown field "subject" at line 1 column 58` |
| 400 | ClickHouse 160 `TOO_SLOW`: `sequenceMatch` ran past its iteration cap (3.4 "Too complex") | `groups: search too complex: drop a repeated step or widen a time gap` |
| 400 | ClickHouse 158 `TOO_MANY_ROWS`: passed `max_rows_to_read` (2.8) | `query reads too much: narrow the filters` |
| 404 | Unknown route | `not found` |
| 404 | Replay id not found, or not 64 hex | `No game with this id` |
| 405 | Wrong method | `method not allowed` |
| 413 | Body over 16 KiB | `body: larger than 16384 bytes` |
| 415 | `POST` without `Content-Type: application/json` | `body: send Content-Type application/json` |
| 503 | ClickHouse unreachable (connect error or timeout) | `warehouse offline` |
| 503 | No query permit within 1 s (2.8), or ClickHouse 202 `TOO_MANY_SIMULTANEOUS_QUERIES`. With `Retry-After: 1`. | `warehouse busy: retry` |
| 503 | ClickHouse 241 `MEMORY_LIMIT_EXCEEDED` | `query used too much memory: narrow the filters` |
| 504 | ClickHouse 159 `TIMEOUT_EXCEEDED` | `query took too long: narrow the filters` |
| 500 | ClickHouse 396 `TOO_MANY_ROWS_OR_BYTES` (an API bug: every route caps its rows) | `warehouse query failed` |
| 500 | Any other ClickHouse error | `warehouse query failed` |

- axum's own rejections (JSON, 405, 413, 415, fallback) are plain text by default (not verified); the service maps them to the envelope in one place.
- The code comes from the `X-ClickHouse-Exception-Code` header (measured: `SELECT throwIf(1)` → HTTP 500, header `395`; names checked with `errorCodeToName`). rust.md 6.2 maps codes to rows.
- Decided: 160 and 158 are 400. Why: the same request always fails, and a 500 shows Retry (frontend.md 5.2).
- Decided: 241 is 503. Why: the user memory cap depends on other queries, so a retry can pass.
- ClickHouse text goes to the log, never to the client (it can quote SQL).

### 2.7 Caching

| Response | `Cache-Control` | Why |
|---|---|---|
| `GET /mappings` 200 | `public, max-age=3600` | Changes only when `just mappings` runs (justfile:31-35) |
| `GET /replays/{id}` 200 | `public, max-age=3600` | Changes only on a re-stage (PLAN.md:106). No private chat (3.8). |
| `GET /filters`, `/openers`, `/openers/replays`, `/stats` 200 | `public, max-age=60` | Report-to-searchable is already minutes (PLAN.md:54) |
| `POST /search`, `GET /health`, every error | `no-store` | An error must not stick |

- If CORS is ever on, send `Vary: Origin` (else a shared cache keeps the first caller's CORS header) and `Access-Control-Expose-Headers: X-Total-Count`.

### 2.8 Limits

| Limit | Value | Enforced by |
|---|---|---|
| Request body | 16 KiB (2 groups × 8 full steps ≈ 2 KiB) | axum body limit |
| Groups per search | 0-2 (w3warehouse: models.py:331-335) | validation |
| Steps per group | 0-8 (story 1) | validation |
| `without` codes per group | 0-3 (story 1) | validation |
| `limit` / `offset` | 1-100 / 0-10000 | validation |
| `prefix` codes | 0-5 on `/openers`, 1-6 on `/openers/replays` (depth cap 6, index.html:448) | validation |
| String fields | 1-64 chars | validation |
| Query permits | 6, shared; wait up to 1 s, then 503 `warehouse busy: retry` | `tokio::sync::Semaphore`, one permit per query |
| ClickHouse user | `readonly = 1` | user profile |
| `max_concurrent_queries_for_user` | 8 (above 6 permits: a 202 means another client) | user profile (rust.md §8) |
| `max_execution_time` | 5 s (as w3warehouse: compiler.py:357) | user profile |
| `max_memory_usage` | 1 GB (box 4 GB, stack idles at 1.2 GB, PLAN.md:20, 74) | user profile |
| `max_result_rows` | 100000, `result_overflow_mode = throw` (backstop) | user profile |
| `http_wait_end_of_query` | 1 (A10) | user profile |
| `max_rows_to_read` | 10,000,000, `read_overflow_mode = throw`; summed over all tables of a query (rust.md M11); 158 → 400 | user profile (rust.md §8) |
| `max_memory_usage_for_user` | 2 GB | user profile (rust.md §8) |
| `max_bytes_before_external_group_by`, `_sort` | 500 MB each | user profile (rust.md §8) |
| `cancel_http_readonly_queries_on_client_close` | 1 (a dropped request ends its query) | user profile (rust.md §8) |
| Requests per client IP | one edge rate-limit rule on `/api/*` | Cloudflare, once the ingress in 2.9 exists (A12) |

- Starting values. Decided: measure after PR 2 (`max_rows_to_read` = 10 × the largest route read; memory caps from ingest and refresh peaks).
- Semaphore why: all visitors share one user; `/stats` and `/replays/{id}` each run 4 queries at once (rust.md 3.1 `try_join!`), so 3 loads need 12 slots against 8. No quota: it keys on the one shared user.
- Limits sit in the profile (`agent-query-safety`): `readonly = 1` rejects a query `SETTINGS` clause (measured: Code 164). SQL ends in a `FORMAT JSON` clause, never `default_format`.

### 2.9 Public ingress

- Today the only tunnel ingress goes to ClickHouse (infrastructure/cloudflared/config.yml.example:9-11).
- Proposed: browser → Cloudflare tunnel → nginx (`ui`, compose.yaml:78-84, serves the Vite build) → `/api/` stripped → `api:8000` (rust.md §15). Needs a site-hostname ingress rule and one per-IP rate-limit rule on `/api/*` (plan support not checked).
- Until then nothing limits one client; the semaphore only guards ClickHouse. Open for Daniel at PR 10 (§6 Q10, Q12).

## 3. Route contracts

### 3.1 `GET /health`

- No parameters. Runs `SELECT 1` as the read-only user.
- 200 `{"status": "ok"}`. 503 `{"error": "warehouse offline"}`.
- The UI never calls it; "Retry" re-runs the page's `load` (frontend.md 5.2).

### 3.2 `GET /mappings`

No parameters. Response: an array, one item per named object, sorted by `name`.

| Field | Type | Meaning |
|---|---|---|
| `code` | string | 4-char object code |
| `name` | string | Display name |
| `kind` | enum | `building`, `unit`, `upgrade`, `item`, `hero`, `hero_skill` |
| `race` | letter or null | Owner race, derived in Rust (table below). Null = neutral or no race. |
| `hero` | string or null | On a `hero_skill`: the hero's display name (`mappings.hero`). Null otherwise. |

- Rows: `kind != 'unknown' AND name != ''` (index.html:1014), filtered in SQL. (X): 649 rows, 649 distinct codes, so a code is unique among these rows.
- `kind` to step `event_type` (index.html:462-469): `building`, `unit`, `upgrade`, `item` → the same word; `hero` → `hero_trained`; `hero_skill` → `hero_skill`.
- `race` is derived: `mappings.race` is `''` on every `upgrade` and `hero_skill` row (F).

| `kind` | Rule | Example |
|---|---|---|
| `building`, `unit` | 1st letter, lower case | `eaom` → N |
| `hero` | 1st letter, any case | `Edem` → N |
| `upgrade` | override map first, then the 2nd letter | `Recb` → N; `Rwdm` → O (override) |
| `hero_skill` | owning hero: `mappings.hero` → that hero's `code` → its 1st letter | `AEmb` → Demon Hunter → `Edem` → N; `AHfa` → Priestess of the Moon → `Emoo` → N |
| `item` | none | `ankh` → null |

- Letter to race: `h` H, `o` O, `e` N, `u` U, anything else null. A leading `n`/`N` is neutral (tavern heroes, mercenaries, creeps). A derived `race` is never `R`.
- (F): of 107 named skills only `AHfa` has a 2nd letter unlike its hero's race; 24 hero names are unique; all 107 resolve. Upgrade 2nd letters: `e` 22, `h` 21, `o` 19, `u` 18, `w` 1 (`Rwdm`, War Drums, Orc), hence `{"Rwdm": 'O'}` in `mappings.rs`. index.html:479-490 gets both wrong.
- Unit test: one Rust test over `eaom`, `Edem`, `Recb`, `Rwdm`, `AEmb`, `AHfa`, `ankh` (rust.md 6.3).

```
GET /mappings
```
```json
[
  {"code": "eate", "name": "Altar of Elders", "kind": "building", "race": "N", "hero": null},
  {"code": "ankh", "name": "Ankh of Reincarnation", "kind": "item", "race": null, "hero": null},
  {"code": "Recb", "name": "Corrosive Breath", "kind": "upgrade", "race": "N", "hero": null},
  {"code": "Edem", "name": "Demon Hunter", "kind": "hero", "race": "N", "hero": null},
  {"code": "AEmb", "name": "Mana Burn", "kind": "hero_skill", "race": "N", "hero": "Demon Hunter"}
]
```
(Cut to 5 of 649 rows.) Errors: 400 (unknown key), 503, 500.

### 3.3 `GET /filters`

- No parameters. Response: `{maps: [{map, games}], players: [{name, games}]}`, all counts integers.
- `maps` sorted by `games` desc, then `map`. `players` sorted by `lowerUTF8(name)`, then `name` (queries.md 3.3).
- Both count only 1on1 games. No row cap: `replay_players` holds 2 rows per replay (13,134 rows (F), queries.md §2). `max_result_rows` is the backstop.

```
GET /filters
```
```json
{
  "maps": [
    {"map": "Springtime 1.3", "games": 2},
    {"map": "Concealed Hill", "games": 1}
  ],
  "players": [
    {"name": "FoCuS#31324", "games": 1},
    {"name": "Medusa#31315", "games": 2},
    {"name": "moosangsung#1804", "games": 1},
    {"name": "Okeanos#22605", "games": 1},
    {"name": "thanks#11187", "games": 1}
  ]
}
```

### 3.4 `POST /search`

Query: `limit`, `offset` (2.4). Body:

| Field | Type | Bounds | Default |
|---|---|---|---|
| `map` | string | 1-64 | none |
| `min_minutes` | integer | 0-180 | none |
| `max_minutes` | integer | 0-180, not below `min_minutes` | none |
| `groups` | array of Group | 0-2 | `[]` |

Group (one player slot):

| Field | Type | Bounds | Default | Meaning |
|---|---|---|---|---|
| `race` | letter | `H O N U R` | none | Slot player's race |
| `player` | string | 1-64 | none | Slot player's name, case-insensitive |
| `result` | enum | `won`, `lost` | none | Slot player's outcome. When set, games with an unknown winner drop out (`winning_team_id >= 0`, views.sql:81-83). |
| `steps` | array of Step | 0-8 | `[]` | Ordered build steps |
| `without` | array of codes | 0-3, each a `/mappings` code | `[]` | The slot player has no order of any of these codes in the game. PR 15. |

Step:

| Field | Type | Bounds | Default | Meaning |
|---|---|---|---|---|
| `event_type` | enum | `building`, `unit`, `upgrade`, `item`, `hero_trained`, `hero_skill` | required | Kind of step |
| `subject_code` | string | exactly 4 chars | required | A `/mappings` code whose `kind` fits `event_type` (3.2), else 400 |
| `within_previous_seconds` | integer | 1-3600 | none | Gap to the previous step. 400 on step 0. |
| `time_from_seconds` | integer | 0-10800 | none | `time_ms >= value * 1000` |
| `time_to_seconds` | integer | 1-10800, not below `time_from_seconds` | none | `time_ms <= value * 1000` |
| `min_count` | integer | 2-100 | none (1) | At least this many orders of `subject_code` inside the step window: "at least 5 Archer orders by 5:00". PR 15. |
| `first_hero` | bool | only on `hero_trained` | `false` | `subject_code` is the player's first hero. PR 15. |

Field names and bounds of the first five Step fields come from w3warehouse: models.py:46-173. The API accepts codes only, never names.

Match rules:

| Rule | Detail |
|---|---|
| Slots are players | `groups[0]` and `groups[1]` bind to two different players of one replay (different `player_id` and `team_id`). w3warehouse: compiler.py:381-387 merged same-race groups (A11). |
| Empty slot | A group with no steps and no `without` binds on `race`, `player` and `result` only (the "opponent Orc" slot; w3warehouse: models.py:170-173). |
| No groups | Lists every 1on1 game passing `map` and minutes. Paging bounds the cost. |
| Orders only | Every step condition adds `is_repeat = 0` (2.1). |
| One step | No `sequenceMatch`. The step's WHERE condition is the whole test (index.html:720-721). |
| 2+ steps | `sequenceMatch({pat:String})(time_ms, cond1, ...)`. The pattern starts `(?1)`. Each later step adds `(?t<={ms})(?k)` when `within_previous_seconds` is set, else `.*(?k)`. Never `.*(?t<=N)` or `(?t<=N).*` (compiler.py:909 bug). |
| Step window | `time_from_seconds`, `time_to_seconds` go into that step's condition as bound `UInt32` values. |
| Repeated step | "A then A" needs two A events (measured: one gives 0, two give 1 for `(?1).*(?2)`). |
| Equal timestamps | Decided: a real-data golden pins the order. Why: 1,605 of 1,605 came in order (F; queries.md C5). |
| Minimum count | One bound `HAVING` term per counted step: `uniqExactIf(seq, <step cond>) >= {gI_sK_min:UInt32}`. Not `count()`: `replay_events` dedupes only at merge (`insert-optimize-avoid-final`). The step sits in the sequence at its first matching order. |
| Without | The codes join the slot's `subject_code IN` list; one bound term `countIf(subject_code IN {gI_without:Array(String)}) = 0`. A slot with only `without` codes uses `replay_players FINAL` of that race as its base. |
| First hero | The player's earliest `hero_trained` row has this code (as w3warehouse: compiler.py:806-844). Decided: `hero_trained` = first ability cast, not training order; accepted. (F): that and `player_heroes.hero_slot = 0` both give 1,514 Night Elf player-games for `Edem`. |
| Too complex | A pattern caps at 1,000,000 iterations, then 160 → 400 (2.6). (F), race N: 7 × `unit ewsp` at 600 s gaps then `building etol` within 1 s fails in ~0.06 s; 4 × fails too; 8 × with open gaps returns 2,668 pairs. No setting raises the cap on 26.9, and a step cap cannot prevent it. |
| Dedup and header shape | queries.md §4.1 is the source. Rules 10-11: each slot binds through `replay_players FINAL` with `(replay_id, player_id) IN (<slot set>)`. Rule 14: page `GROUP BY r.replay_id, …`. `replays FINAL` relies on the runtime join filter (`RF1`, on by default from 26.2, measured on 26.9), not a second `IN` (queries.md §5). Header reads use `FINAL` (`insert-optimize-avoid-final`). |

One slot, every value bound (PR 2 adds `is_repeat = 0`; PR 15 adds the count and without terms):

```sql
SELECT replay_id, player_id
FROM (
    SELECT DISTINCT replay_id, player_id, time_ms, event_type, subject_code, seq
    FROM w3g.replay_events
    WHERE race = {g0_race:String}                  -- key prefix: schema-pk-filter-on-orderby
      AND event_type IN {g0_types:Array(String)}
      AND subject_code IN {g0_codes:Array(String)})
GROUP BY replay_id, player_id
HAVING sequenceMatch({g0_pat:String})(time_ms,
    event_type = {g0_s0_type:String} AND subject_code = {g0_s0_code:String},
    event_type = {g0_s1_type:String} AND subject_code = {g0_s1_code:String}
        AND time_ms <= {g0_s1_to:UInt32})
```

- SQL text changes only with the request shape; values never enter it.
- `DISTINCT` drops an unmerged ReplacingMergeTree duplicate but keeps `seq`, so real same-ms repeats survive (queries.md §4.1 rules 3, 5; C8; `insert-optimize-avoid-final`). One-step slots skip it.
- Read cost (F; queries.md §5 S1; `schema-pk-filter-on-orderby`): current key (tables.sql:213) 28 of 118 granules with race, 118 without. S1 key: 2 and 5 of 116; largest G08 114,688 rows, ~1.75 million at 100,000 replays (linear estimate).

Response: 200, array of replay rows (2.5), with `X-Total-Count`.

Example (story 1 Review: Night Elf, `eate` then `eaom`, opponent Orc; fixtures):

```
POST /search?limit=25
Content-Type: application/json

{"groups": [
  {"race": "N", "steps": [
    {"event_type": "building", "subject_code": "eate"},
    {"event_type": "building", "subject_code": "eaom"}]},
  {"race": "O"}
]}
```
```
200 OK
X-Total-Count: 2
Cache-Control: no-store
```
```json
[
  {"replay_id": "0ddbb4abacfb6b62d88223ac6bb3902edc0bdc3a2eac55e29ffe367405cffa60",
   "map": "Springtime 1.3", "matchup": "NvO", "duration_ms": 403900, "winning_team_id": 1,
   "gnl": null, "download_url": null, "focus_player_id": 2,
   "players": [
     {"player_id": 1, "name": "FoCuS#31324", "race": "O", "team_id": 0, "won": false},
     {"player_id": 2, "name": "Medusa#31315", "race": "N", "team_id": 1, "won": true}]},
  {"replay_id": "dcd39e47097a4a010bc4006e0bf521e3726a0b8e9284cc0b8e2fb74411fbfef8",
   "map": "Concealed Hill", "matchup": "NvO", "duration_ms": 937219, "winning_team_id": 0,
   "gnl": null, "download_url": null, "focus_player_id": 1,
   "players": [
     {"player_id": 1, "name": "thanks#11187", "race": "N", "team_id": 0, "won": true},
     {"player_id": 2, "name": "Okeanos#22605", "race": "O", "team_id": 1, "won": false}]}
]
```

- `replay_id` decides the order (`gnl_series_id = 0`). Without the `{"race": "O"}` group the total is 3: `(0ddb…, 2)`, `(9233…, 2)`, `(dcd3…, 1)`.

Goldens (story 1 "Done when"):

| Case | Expected |
|---|---|
| A@0, A@5 s, B@100 s; step B `within_previous_seconds: 10` | `(?1)(?t<=10000)(?2)`, 0 (measured). Old `(?1)(?t<=10000).*(?2)` gives 1. |
| A@0, X@3 s, B@8 s; conditions A, B; bound 10 s | 1 (measured): a non-step event does not break the bound |
| One step `hero_trained Edem`, `race: N` | No `sequenceMatch`. Total 3 (X), 1,520 (F). |
| `eate` then `eaom`, `race: N` | Total 3 (X), 2,263 (F). With `{"race": "O"}` second group: 2 (X), 654 (F). |
| Race N, 7 × `unit ewsp` each `within_previous_seconds: 600`, then `building etol` `within_previous_seconds: 1` | Valid; ClickHouse 160; API 400 `groups: search too complex: …`. Live parity case (rust.md 17.3) + stub test 160 → 400. |
| PR 15: race N, step `unit earc`, `min_count: 5`, `time_to_seconds: 300` | 1 (X, `dcd3…`), 1,100 (F) |
| PR 15: race N, step `building eate`, `without: ["eden"]` | 1 (X), 573 (F) |
| PR 15: race N, step `hero_trained Edem`, `first_hero: true` | 3 (X), 1,430 (F) |
| PR 15 check | Whether the parser drops cancelled training orders. |

Errors:

| Status | Example `error` text |
|---|---|
| 400 | `groups: at most 2 items` |
| 400 | `groups[0].steps: at most 8 items` |
| 400 | `groups[0].steps[0].within_previous_seconds: not allowed on the first step` |
| 400 | `groups[1].steps[2].time_to_seconds: must not be below time_from_seconds` |
| 400 | `groups[0].steps[1].subject_code: "Edem" is a hero, use event_type hero_trained` |
| 400 | `groups[0].race: must be one of H, O, N, U, R` |
| 400 | `groups[0].steps[0].min_count: must be 2-100` (PR 15) |
| 400 | `groups[0].steps[0].first_hero: only on hero_trained` (PR 15) |
| 400 | `groups[0].without: at most 3 codes` (PR 15) |
| 400 | `groups: search too complex: drop a repeated step or widen a time gap` |
| 400 | `limit: must be 1-100` |
| 503, 504, 500 | 2.6 |

### 3.5 `GET /openers`

One level of the openers tree.

| Key | Type | Bounds | Default |
|---|---|---|---|
| shared filters (2.2) | | `race` required | |
| `prefix` | comma-separated codes | 0-5. Each a non-supply `building` code in `/mappings`. A code may repeat, not twice in a row. | empty (top level) |
| `sort` | enum | `popular`, `winrate` | `popular` |

Response:

| Field | Type | Meaning |
|---|---|---|
| `race` | letter | Echo |
| `prefix` | array of codes | Echo |
| `total` | integer | Player-games whose opener starts with `prefix` |
| `stopped` | integer | Part of `total` whose opener ends exactly at `prefix`. `sum(rows[].games) + stopped = total`. |
| `rows[].code` | string | Building at depth `len(prefix) + 1` |
| `rows[].games` | integer | Player-games |
| `rows[].wins` | integer | Games that player won |
| `rows[].avg_minutes` | number | Mean `duration_ms / 60000`, one decimal |
| `rows[].branches` | integer | Distinct buildings at the next depth. 0 at depth 6. |

- Opener: a player's first six non-supply building orders with `is_repeat = 0`, in time order, consecutive repeats removed (`arrayCompact`, views.sql:57-64; A13). (F): 5,337 of 12,881 openers repeat a code. Fix the views.sql:41 comment ("distinct"). A prefix with a code twice in a row never matches: 400.
- Decided: `otrb` gets `is_supply_building = 1` in the fork's mappings export. Why: 3,386 of 3,396 Orc openers hold it (F); `uzig` is already 1.
- Only decided 1on1 games count (views.sql:80-83), so the cohort can be smaller than `/stats`.
- `popular`: `games` desc, `wins/games` desc, `code`. `winrate`: rows with 10+ games first, then `wins/games` desc, `games` desc, `code` (index.html:899-903).
- Decided: the floor 10 (story 2, index.html:446) is a literal in the `winrate` ORDER BY (queries.md 3.5) and one frontend constant, pinned by a golden and a test. Not on the wire.
- No row cap: one race's non-supply buildings ((X): 56 `building` rows, four races).
- Source: `replay_openers` view today, the queries.md §5 S2 `openers` table (`query-mv-refreshable`) later; same contract. Both routes go public only on S2: on the view each click reads 991,101 rows, 155.14 MiB (F), and each new `player` string misses the 60 s cache. PR 2 re-measures the S2 refresh.

```
GET /openers?race=N
```
```json
{"race": "N", "prefix": [], "total": 3, "stopped": 0,
 "rows": [{"code": "eate", "games": 3, "wins": 3, "avg_minutes": 9.7, "branches": 1}]}
```

```
GET /openers?race=N&prefix=eate,eaom
```
```json
{"race": "N", "prefix": ["eate", "eaom"], "total": 3, "stopped": 0,
 "rows": [
   {"code": "etoa", "games": 2, "wins": 2, "avg_minutes": 6.7, "branches": 1},
   {"code": "eden", "games": 1, "wins": 1, "avg_minutes": 15.6, "branches": 1}]}
```

`GET /openers?race=N&player=Medusa%2331315` gives one row: `eate`, 2 games.

Golden: `prefix=eate,eaom,eate` is valid, 14 openers (F; queries.md 3.5). `prefix=eate,eate` is 400.

| Status | Example `error` text |
|---|---|
| 400 | `race: required` |
| 400 | `prefix: at most 5 codes` |
| 400 | `prefix[1]: "emow" is a supply building` |
| 400 | `prefix[1]: "eate" repeats the code before it` |
| 400 | `sort: must be popular or winrate` |

### 3.6 `GET /openers/replays`

The games behind one tree row.

| Key | Type | Bounds | Default |
|---|---|---|---|
| shared filters (2.2) | | `race` required | |
| `prefix` | comma-separated codes | 1-6, as in 3.5 | required |
| `limit`, `offset` | 2.4 | | |

- Response: 200, array of replay rows (2.5), with `X-Total-Count`.
- One row per opener owner (`(replay_id, player_id)` of the view; `focus_player_id` = owner, A14), so `X-Total-Count` = the tree row's `games`. (F): prefix `eate` 2,503 rows in 2,270 replays; `eate,eaom,eden` 816 in 794 (queries.md 3.6). The hydrate takes the page's distinct ids.

```
GET /openers/replays?race=N&prefix=eate,eaom,eden
```
```
200 OK
X-Total-Count: 1
```
```json
[{"replay_id": "dcd39e47097a4a010bc4006e0bf521e3726a0b8e9284cc0b8e2fb74411fbfef8",
  "map": "Concealed Hill", "matchup": "NvO", "duration_ms": 937219, "winning_team_id": 0,
  "gnl": null, "download_url": null, "focus_player_id": 1,
  "players": [
    {"player_id": 1, "name": "thanks#11187", "race": "N", "team_id": 0, "won": true},
    {"player_id": 2, "name": "Okeanos#22605", "race": "O", "team_id": 1, "won": false}]}]
```

Errors: as 3.5, plus `prefix: required` and the paging errors.

### 3.7 `GET /stats`

Request: shared filters only.

| Field | Type | Meaning |
|---|---|---|
| `games` | integer | Distinct replays in the cohort (`uniqExact(replay_id)`). The page states it. |
| `matchups[]` | array | One row per ordered race pair, sorted by `race`, then `opponent_race` |
| `matchups[].race`, `.opponent_race` | letter | Row race, column race |
| `matchups[].games` | integer | All games of that pair |
| `matchups[].decided` | integer | Games with a known winner |
| `matchups[].wins` | integer or null | Decided games won by `race`. Null on a mirror row. |
| `heroes[]` | array | One item per player race, sorted by `race` |
| `heroes[].race` | letter | |
| `heroes[].player_games` | integer | Player-games of that race: the share's denominator |
| `heroes[].picks[]` | array | `{code, player_games}`, sorted by `player_games` desc, then `code`. Tavern heroes count under the player's race. |
| `durations` | object | `{"width_minutes": 5, "cap_minutes": 60, "counts": [int]}` |
| `apm` | object | `{"width": 25, "cap": 500, "counts": [int]}`, over player-games |

- Histogram: `counts[i]` covers `[i*width, (i+1)*width)`; index `cap/width` holds all values ≥ `cap` (as w3warehouse: analytics.py:1260-1286). Dense to the last non-empty bucket; empty cohort `[]`. No `pct`.
- 1-3 heroes per player, so shares sum past 100% (models.py:485-490).
- Dedup (story 3): `replays`, `replay_players`, `player_heroes` read `FINAL`; `uniqExact` on every count; no plain `count()` over `replay_events` (queries.md §1, `insert-optimize-avoid-final`).
- Decided: drop the 68 `player_heroes` rows with `hero_id = ''` (F) in reads. The win-rate floor is the 3.5 constant.

Example (story 3 Review, no filter, fixtures):

```
GET /stats
```
```json
{
  "games": 3,
  "matchups": [
    {"race": "H", "opponent_race": "N", "games": 1, "decided": 1, "wins": 0},
    {"race": "N", "opponent_race": "H", "games": 1, "decided": 1, "wins": 1},
    {"race": "N", "opponent_race": "O", "games": 2, "decided": 2, "wins": 2},
    {"race": "O", "opponent_race": "N", "games": 2, "decided": 2, "wins": 0}
  ],
  "heroes": [
    {"race": "H", "player_games": 1, "picks": [{"code": "Hmkg", "player_games": 1}]},
    {"race": "N", "player_games": 3, "picks": [
      {"code": "Edem", "player_games": 3}, {"code": "Ekee", "player_games": 2},
      {"code": "Nngs", "player_games": 1}]},
    {"race": "O", "player_games": 2, "picks": [
      {"code": "Oshd", "player_games": 2}, {"code": "Obla", "player_games": 1},
      {"code": "Ofar", "player_games": 1}, {"code": "Otch", "player_games": 1}]}
  ],
  "durations": {"width_minutes": 5, "cap_minutes": 60, "counts": [0, 2, 0, 1]},
  "apm": {"width": 25, "cap": 500, "counts": [0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 1]}
}
```

Hero rows come from `player_heroes`. APM rows come from `replay_players.apm`: 89, 140, 227, 307, 346, 373 (X). Errors: 400 on a bad filter, then 2.6.

### 3.8 `GET /replays/{id}`

`id` must be 64 lower-case hex. Anything else gives 404 `No game with this id`, and no query runs.

| Field | Type | Meaning |
|---|---|---|
| `replay_id`, `map`, `matchup`, `duration_ms`, `winning_team_id`, `gnl`, `download_url` | | As in 2.5 |
| `version` | string | `replays.version` |
| `players[]` | array | Sorted by `player_id`. `player_id`, `name`, `race`, `team_id`, `won` as in 2.5. |
| `players[].apm` | integer | Whole-game APM |
| `players[].apm_per_minute` | array of int | `replay_players.apm_timed`, one value per game minute (inferred (X): 7 values for 6.7 min, 16 for 15.6 min) |
| `players[].heroes[]` | array | `{slot, code, final_level}` from `player_heroes`, sorted by `slot` |
| `events[]` | array | The order timeline, sorted by `time_ms`, `player_id`, `seq`. Rows with `is_repeat = 1` are hidden. |
| `events[].player_id`, `.time_ms` | integer | |
| `events[].event_type` | enum | The six step kinds, plus `hero_retrained` (timeline only, never a search step; queries.md 3.8, C9). `unknown` rows are left out. |
| `events[].code` | string | Object code; the name comes from `/mappings`. On `hero_retrained`, the hero's code. |
| `events[].hero_code` | string or null | On `hero_skill` and `hero_retrained`: the hero (`hero_ability_events.hero_id`). The UI nests skills under it. Null otherwise. |
| `chat[]` | array | `{time_ms, player_id, mode, message}`, sorted by `time_ms`. Only `mode = 'All'`. |

- Decided: hide private chat (`AND mode = 'All'`, queries.md 3.8). Why: the route is public and cached 1 hour. (F): 5 lines, 3 `All`, 2 `Private`.
- Source: tables keyed by `replay_id` (`replays`, `replay_players`, `player_heroes`, `player_order_events`, `hero_ability_events`, `chat`; tables.sql:92, 119, 131, 151, 167; `schema-pk-filter-on-orderby`). `replay_events` by `replay_id` is a full scan (queries.md 3.8). Headers read `FINAL`.
- No event cap: 152 events in 15.6 min (X), ~600 for 60 min. `max_result_rows` is the backstop.
- The GNL series shows as text: the GNL route `/match/:id` is member-only and needs a match id the warehouse lacks.

Example (story 4 Review, fixtures; arrays cut):

```
GET /replays/dcd39e47097a4a010bc4006e0bf521e3726a0b8e9284cc0b8e2fb74411fbfef8
```
```json
{
  "replay_id": "dcd39e47097a4a010bc4006e0bf521e3726a0b8e9284cc0b8e2fb74411fbfef8",
  "map": "Concealed Hill", "matchup": "NvO", "duration_ms": 937219, "winning_team_id": 0,
  "version": "2.00", "gnl": null, "download_url": null,
  "players": [
    {"player_id": 1, "name": "thanks#11187", "race": "N", "team_id": 0, "won": true, "apm": 140,
     "apm_per_minute": [110, 96, 162, 130, 149],
     "heroes": [{"slot": 0, "code": "Edem", "final_level": 4}, {"slot": 1, "code": "Ekee", "final_level": 4}]},
    {"player_id": 2, "name": "Okeanos#22605", "race": "O", "team_id": 1, "won": false, "apm": 89,
     "apm_per_minute": [54, 36, 72, 84, 98],
     "heroes": [{"slot": 0, "code": "Ofar", "final_level": 3}, {"slot": 1, "code": "Oshd", "final_level": 2},
                {"slot": 2, "code": "Otch", "final_level": 1}]}
  ],
  "events": [
    {"player_id": 2, "time_ms": 2105, "event_type": "unit", "code": "opeo", "hero_code": null},
    {"player_id": 1, "time_ms": 2601, "event_type": "unit", "code": "ewsp", "hero_code": null},
    {"player_id": 2, "time_ms": 6722, "event_type": "building", "code": "oalt", "hero_code": null},
    {"player_id": 1, "time_ms": 8025, "event_type": "building", "code": "eate", "hero_code": null}
  ],
  "chat": [
    {"time_ms": 9573, "player_id": 1, "mode": "All", "message": "glhf"}
  ]
}
```

- Cut: `apm_per_minute` has 16 values per player. `events` has 152 rows (158 `replay_events` minus 6 `unknown`) before the repeat flag, 150 after PR 2 (2 flagged; queries.md D1-D4). `chat` holds 3 lines, all `All`.
- Later in the timeline: `{"player_id": 1, "time_ms": 142254, "event_type": "hero_trained", "code": "Edem", "hero_code": null}` and `{"player_id": 1, "time_ms": 142254, "event_type": "hero_skill", "code": "AEim", "hero_code": "Edem"}`.
- `hero_trained` is synthetic, at the hero's first ability event (views.sql:405-431).

Errors: 404 `No game with this id` (the story text); 503, 504, 500 per 2.6.

## 4. Design choices

| # | Decided | Why |
|---|---|---|
| A1 | `POST /search` with a JSON body | Serde gives field paths; one codec (frontend) cannot drift. On the S1 key a search reads 2-5 of 116 granules, so an edge cache saves little. The route query holds share state (stories D2). |
| A2 | `limit`/`offset` + `X-Total-Count`, one fixed order, no `sort` | `count() OVER ()` is free; GNL `getPage`/`postPage` read it. No story asks for a sort; no play date exists. |
| A3 | Unknown or wrong-kind code: 400 naming the field, via in-memory `mappings` | It can never match, so an empty 200 misleads. Goldens need no database. |
| A4 | `/mappings` derives `race` | `mappings.race` is empty for upgrades and skills (F); index.html gets `AHfa`, `Rwdm` wrong. |
| A5 | Race ids: stored letters `H O N U R` | Every table and `matchup` uses them. GNL ids (`HU OC UD NE RANDOM`, gnl-frontend: `src/helpers/races.js`) need a map everywhere. |
| A6 | `max-age` tiers (2.7), no ETags | 60 s staleness is invisible next to minutes of ingest (PLAN.md:54). |
| A7 | Openers carry `stopped`; story 2 reads "children plus stopped sum to the parent" | 59 stopped at `prefix=eate,eaom` (F; queries.md 3.5). |
| A8 | `/stats`: one route, one cohort | Story 3 states one cohort size; charts are small. |
| A9 | `/replays/{id}`: one route | The page shows almost all of it at once. |
| A10 | `http_wait_end_of_query = 1` | One error path: a failure is a non-200 with the code header. Exists on 26.9 (default 0); PR 2 re-checks on 26.8. |
| A11 | `groups[i]` is player i; two different players | Mirrors become searchable. |
| A12 | 6-permit semaphore (1 s wait), 202 → 503, one per-IP edge rule (2.9) | With the 202 map alone, 3 loads at once fail. Only the edge rule stops one client taking every permit. |
| A13 | Openers keep `arrayCompact`, not `arrayDistinct` | Top repeats are real extra buildings (F): `otrb` 3,368, `hwtw` 568, `eaom` 543, `eden` 239, `usep` 234. Story 2 says "first buildings". |
| A14 | `/openers/replays`: one row per opener owner | The tree counts player-games. Row key `(replay_id, focus_player_id)`. |
| A15 | Count, `without`, first hero in PRs 15-16 (stories D4) | Each adds one bound `HAVING` term to the slot shape. PLAN.md:40 plans first hero. Cross-player order, ordered negation, OR in a step and second hero stay out. |

## 5. Dropped from the w3warehouse request model

| Dropped (w3warehouse: models.py) | Why |
|---|---|
| `subject` names (54-60) | Codes only |
| `hero_ordinal` (98-118) | Replaced by Step `first_hero` (PR 15) |
| `matchup` list (316-327) | `groups[i].race`, `race`/`opponent_race` |
| `player_names`, `players_match_all` (222-240) | One player per slot |
| `warnings`, `sql`, `params`, `?dry_run` (453-459, main.py:348-351) | Goldens test SQL in Rust |
| Empty-request guard (338-368) | Paging bounds the cost |
| `event_type: unknown` (19-24) | Custom maps out of scope |
| openers `sample_replays`, `codes` (548-576) | `/openers/replays`, `/mappings` |
| `game_mode`, `seasons`, `min_mmr`, `max_mmr`, `w3c_linked_only`, `annotations`, `rolled_race` (196-287, 597) | Out of scope; seasons wait for the dims loader |
| Histogram `pct` (503-510) | Client scales; it had two meanings |

## 6. Questions

Numbers stay stable for references from other documents.

1. Race ids: decided, letters (A5).
2. List order: decided, fixed order now; PR 3 adds a play date if the drain can read the upload time (2.4).
3. Readonly profile over HTTP: a check, not a question. `?readonly=1` in a URL fails with Code 164; a native `--readonly=1` session accepts `--param_x` (measured). PR 4 (users.d, empty-password test) and the live CI job on 26.8 (rust.md 17.3) run `curl -u <api user>: 'http://127.0.0.1:8123/?param_x=7' --data-binary 'SELECT {x:UInt8} FORMAT JSON'`.
4. `stopped`: decided (A7).
5. `hero_trained` timing: decided, first cast accepted (3.4 "First hero").
6. Private chat: decided, hidden (3.8).
7. `download_url`: decided, `source_key` (2.5, PR 3).
8. Profile limits: decided, measured after PR 2 (2.8).
9. Random players: decided, `R` is a fifth race (2.2).
10. **Open for Daniel, decide at PR 10: GNL backend search path and hosting.** PLAN.md:39 plans `GET /replays/search` in the GNL backend. Options: (a) the backend forwards a POST body to this API's `POST /search`; (b) the backend queries ClickHouse itself. Hosting: (a) the box through nginx first, pages copied into the GNL app later; (b) the GNL app from the start. Recommend (a) and (a): after the ingress move 8123 is not public, and one compiler owns the search SQL.
11. Orc Burrow: decided, `is_supply_building = 1` in the fork export (3.5).
12. **Open for Daniel, decide at PR 10: public ingress (2.9).** Options: (a) tunnel to ClickHouse 8123 with a password (today); (b) tunnel to the `ui` nginx with a site hostname and one per-IP rate-limit rule on `/api/*` (rust.md R9). Recommend (b): the API checks then hold, and raw SQL is not public.
