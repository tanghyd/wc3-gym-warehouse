# Warehouse queries

- Written 2026-09-11. Condensed 2026-09-11 with the final decisions. This file gives the exact SQL for each route in `docs/design/api.md`, the build-order compiler, the schema changes, the order-repeat flag and the SQL goldens.
- **Data: the host-binary ClickHouse 26.9.1.1204, read 2026-09-11 17:47 to 21:30.** From PR 1 the local compose project holds this load (plan.md §4). 6,567 replays: 6,564 from `gs://w3warehouse-05b6-replays/w3g/gnl/` plus the 3 fixtures. Claude loaded them 2026-09-11 with the parse bin plus `INSERT … FROM file()`. The parsed docs are at the main clone `data/parsed/gnl/` (git-ignored). This set is for debugging only. It is not the "about 1,000" set. The org deploy (Warcraft-Gym/wc3-gym-warehouse) holds only app-reported GNL replays.
- The load has 13,134 players and 950,132 `replay_events` rows. All replays are `type = '1on1'` with `gnl_series_id = 0`. 6,496 have events and 71 have none (§8 item 6).
- Review bases (stories.md D3): the 3 fixtures in the empty `wh-fixtures` compose project decide pass or fail. This full load is a dated scale check. `api.md` examples come from the fixtures.
- **Server version.** PR 2 pins compose.yaml:12, compose.yaml:43 and infrastructure/ci.yml:26 to `clickhouse/clickhouse-server:26.8.2` (the newest tag of the 26.8 LTS line; today 24.10). The patch tag is pinned, not `26.8`: `26.8` moves, and every measured plan here must run on one fixed server. A patch bump is a one-line commit. Every plan and M-fact here was measured on 26.9 (host binary). PR 2 re-runs them in the 26.8 container before it lands (§5 S4).
- Paths are relative to this repo. Rule names come from the `clickhouse-best-practices` skill.

## 0. How this was measured

| What | How |
|---|---|
| Server plans | `EXPLAIN indexes = 1` and `EXPLAIN ESTIMATE` over HTTP 8123 with `param_<name>` values, the Rust service's path. Read-only. |
| Result counts | The same queries with the golden params. |
| Memory | `system.query_log.memory_usage` for a tagged `query_id`, after `SYSTEM FLUSH LOGS`. |
| "After" plans | `clickhouse local` in a scratch process copies server rows with `remote()` (a read) into tables with the new key. Local tables have 1 part (116 granules); server `replay_events` has 4 parts (118). Local granule counts run 1-3 lower. |
| MV checks | `clickhouse local` loads the 6,564 docs of `data/parsed/gnl/` through the proposed MV, then compares with a window-function recount. |
| Goldens | A throwaway compiler generated each text. Each text ran on the server. |

Scale: `replay_events` has 141 rows per replay at the median, 229 at p90, 511 at the max. Rows read grow linearly with replays on every full-scan line.

## 1. Rules for every query

| Rule | Detail | Evidence |
|---|---|---|
| Values | Every value is a `{name:Type}` placeholder, sent as `param_<name>`. | api.md 2.1 |
| SQL text | Depends only on: which optional filters are set, the step count per slot, the sort (one fixed `ORDER BY` per list, api.md A2; two for openers), and server constants (win-rate floor 10, bucket widths). Never on user text. | §4 |
| `String` params | The service doubles each backslash. `param_x=a\tb` gives a 3-char value (a real tab). A quote passes as is. | curl |
| `Array(String)` params | `['a','b']`, with `\` and `'` escaped per element. `['it's']` fails: Code 130 `CANNOT_READ_ARRAY_FROM_TEXT` (HTTP 500). | curl |
| Integer params | Decimal. `param_n=-1` for `UInt32` gives HTTP 500, so validation (api.md 2.8) runs first. | curl |
| Unused params | Accepted. | §7 run |
| Format | The transport appends `\nFORMAT JSON` (api.md 2.8). This file omits it. | |
| Total | `count() OVER ()` in the page query. No-filter page: `total = 6567`. | G01 |
| No `SETTINGS` clause | `readonly = 1` rejects it (api.md 2.8). Add `max_rows_to_read` to the profile (`agent-query-safety`); value in §8 item 7. | |
| Player name | `lowerUTF8(name) = lowerUTF8({player:String})` on both sides, everywhere. `lower()` changes only ASCII letters. | `lower('ÖRC')` = `Örc`; `lowerUTF8` = `örc`. 27 distinct names differ, e.g. `КаланчаВорон#2539`. |
| Code `''` | No read returns an empty object or hero code. | 68 `player_heroes FINAL` rows have `hero_id = ''` (68 replays, `hero_slot` 1-3, `final_level` 1); reads drop them. 416 `hero_ability_events` rows are `retraining` with `ability_id = ''`. |
| Repeat orders | Every order read skips `is_repeat = 1` (§9). | §9 |

Dedup per engine (`insert-optimize-avoid-final`: an exact read needs `FINAL` or a dedup-safe shape):

| Table | Read rule | Why |
|---|---|---|
| `replays`, `replay_players`, `player_heroes`, `player_order_events`, `hero_ability_events`, `chat` | `FINAL` | ReplacingMergeTree (tables.sql:64, 91, 130, 118, 150, 166). Each read is small or one key range. |
| `replay_events`, 1-step slot | No `FINAL`. `GROUP BY replay_id, player_id` is the whole test. | A duplicate adds no new pair. |
| `replay_events`, 2+ step slot | `SELECT DISTINCT` on the RMT key columns, then `GROUP BY` + `sequenceMatch` (§4 rule 5). | A duplicate **can** add a match: `sequenceMatch('(?1).*(?2)')(t, e='A', e='A')` over `(0,'A'),(0,'A')` gives 1 (C8). |
| `replay_openers` (view) | No `FINAL`. `arrayCompact` drops the twin (views.sql:57-64). | The twin sits next to its row after the sort. |
| `openers` (§5 S2) | No `FINAL` | Plain MergeTree; the refresh swaps the table. |
| `mappings` | None | Plain MergeTree; TRUNCATE + INSERT (justfile:31-35). |

Duplicates now: `count()` = `count() FINAL` = 950,132. 0 full-key groups have 2+ rows. 1,736 `(replay_id, player_id, subject_code, time_ms)` groups have 2+ rows with distinct `seq`, so a dedup keeps `seq` (C8).

Write guard today: only backfill.sql:22-23 (`replay_id NOT IN (SELECT replay_id FROM w3g.replays_raw)`). It misses a `replay_id` twice in one glob and two concurrent runs. §5 adds `LIMIT 1 BY replay_id`.

## 2. Route summary

Rows read are `EXPLAIN ESTIMATE` on the server (6,567 replays, measured on 26.9). Search event rows come from the slot-only plan, because `ESTIMATE` does not count an `IN` subquery.

| Route | Queries | Table: key columns used | FINAL | Rows read now | After §5 |
|---|---|---|---|---|---|
| `GET /health` | `SELECT 1` | none | – | 0 | – |
| `GET /mappings` | 1 | `mappings`: none | – | 1,567 | – |
| `GET /filters` | 2 | `replays`, `replay_players`: `replay_id IN` set | yes | 6,567; 13,134 | – |
| `POST /search` | page + hydrate | `replay_events`: `race`, `event_type`, `subject_code`. `replay_players`: `(replay_id, player_id) IN` set. `replays`: runtime join filter (26.2+, §5 S4). | headers yes | events 28/118 granules with race, 118/118 with none; `replay_players` 13,134-26,268; `replays` 6,567 | S1: 2 granules with race, 5 with none |
| `GET /openers` | 1 | view: `replay_events` by `event_type`, plus 5 joins | headers yes | 950,132 + 26,268 + 13,134 + 1,567; 155.14 MiB per click | S2: `openers` 8,192 (1 granule). **S2 is a launch condition.** |
| `GET /openers/replays` | page + hydrate | the view, plus `replays` | yes | the same, plus 6,567 | S2: 1 granule |
| `GET /stats` | 4 | `replays`, `replay_players`, `player_heroes`: `replay_id IN` cohort | yes | no filter: 6,567, 26,268, 25,709. Filtered: 8,198-16,396 | – |
| `GET /replays/{id}` | 4 | six tables: `replay_id` | yes | `player_order_events` 41,421 (6/104 granules), `hero_ability_events` 16,434, `replays` 13,134, `player_heroes` 9,325, `replay_players` 4,942, `chat` 5 | – |

## 3. Routes

### 3.1 `GET /health`

```sql
SELECT 1
```

### 3.2 `GET /mappings`

```sql
SELECT code, name, kind, hero, is_supply_building
FROM w3g.mappings
WHERE kind IN ('building', 'unit', 'upgrade', 'item', 'hero', 'hero_skill')
  AND name != ''
ORDER BY name, code
```

- 649 rows. Kinds measured: building 56, hero 24, hero_skill 107, item 239, unit 142, unknown 918, upgrade 81.
- The service runs it on first use (`OnceCell`, rust.md 6.3). It fills the validator: code → `kind`, `is_supply_building` (api.md A3 400s, the `prefix` supply check). `is_supply_building` is not on the wire; `race` is derived in Rust (api.md 3.2).
- Decided: Orc Burrow gets `is_supply_building = 1` in the fork mapping export.
- Key: none. `mappings` is `ORDER BY code` (tables.sql:235); this filter is not on `code`. 1,567 rows, 2 granules. No index is needed.

```
ReadFromMergeTree (w3g.mappings)
  Prewhere filter column: kind IN ('building', 'unit', 'upgrade', 'item', 'hero', 'hero_skill') AND notEmpty(name)
  Condition: true
  Granules: 2/2
```

### 3.3 `GET /filters`

```sql
-- maps
SELECT map, count() AS games
FROM w3g.replay_map
WHERE map != ''
  AND replay_id IN (SELECT replay_id FROM w3g.replays FINAL WHERE type = '1on1')
GROUP BY map
ORDER BY games DESC, map
```

```sql
-- players
SELECT name, count() AS games
FROM w3g.replay_players FINAL
WHERE replay_id IN (SELECT replay_id FROM w3g.replays FINAL WHERE type = '1on1')
GROUP BY name
ORDER BY lowerUTF8(name), name
```

- 14 maps (top: `Tidehunters 1.2`, 897 games); 2,401 players. `count()` is exact: `FINAL` leaves one row per grain key (`replay_id` for a map, via `replays FINAL` in views.sql:37; `(replay_id, player_id)` for a player).
- 0 names collide under `lowerUTF8`. A future collision lists a player twice; the filter then matches both, which is the intent.

```
maps:    ReadFromMergeTree (w3g.replays)  FINAL: 1   Output: replay_id, map_json
           Keys: replay_id   Condition: (replay_id in 6567-element set)   Granules: 2/2   generic exclusion search
           (the regex of views.sql:20-35 runs on each row)
players: ReadFromMergeTree (w3g.replay_players)  FINAL: 1
           Keys: replay_id   Condition: (replay_id in 6567-element set)   Granules: 3/3   generic exclusion search
```

### 3.4 `POST /search`

Two queries: the page (§4, texts in §7), then the hydrate. The page returns `replay_id`, `focus_player_id` (with 1+ slots) and `total`.

**Hydrate** (shared with 3.6; `ids` in page order; `source_key` from §5 S3):

```sql
SELECT r.replay_id AS replay_id, mp.map AS map, r.matchup AS matchup, r.duration_ms AS duration_ms,
       r.winning_team_id AS winning_team_id, r.gnl_series_id AS gnl_series_id, r.gnl_game_no AS gnl_game_no,
       r.source_key AS source_key, p.players AS players
FROM (
    SELECT replay_id, matchup, duration_ms, winning_team_id, gnl_series_id, gnl_game_no, source_key
    FROM w3g.replays FINAL
    WHERE replay_id IN {ids:Array(String)}
) AS r
INNER JOIN (
    SELECT replay_id, arraySort(groupArray((player_id, name, race, team_id))) AS players
    FROM w3g.replay_players FINAL
    WHERE replay_id IN {ids:Array(String)}
    GROUP BY replay_id
) AS p ON p.replay_id = r.replay_id
LEFT JOIN (
    SELECT replay_id, map
    FROM w3g.replay_map
    WHERE replay_id IN {ids:Array(String)}
) AS mp ON mp.replay_id = r.replay_id
ORDER BY indexOf({ids:Array(String)}, r.replay_id)
```

- Rust derives `won` (team vs `winning_team_id`), `gnl` (the two ids, shown as text) and `download_url` = `DOWNLOAD_BASE_URL` (the public base URL) + `source_key`; empty `source_key` gives `null` (stories.md D1).
- Measured (without `source_key`), `ids = [dcd3…, 0ddb…]`: 2 rows in that order, e.g. `['dcd3…', 'Concealed Hill', 'NvO', 937219, 0, 0, 0, [[1,'thanks#11187','N',0],[2,'Okeanos#22605','O',1]]]`.
- Each header read is filtered by the id set before the join (`query-join-filter-before`). The `replay_id` filter reaches the view's `replays FINAL` read.

```
ReadFromMergeTree (w3g.replay_players) FINAL: 1  Keys: replay_id  Condition: (replay_id in 2-element set)  Granules: 3/3
ReadFromMergeTree (w3g.replays)        FINAL: 1  Keys: replay_id  Condition: (replay_id in 2-element set)  Granules: 2/2   (view)
ReadFromMergeTree (w3g.replays)        FINAL: 1  Keys: replay_id  Condition: (replay_id in 2-element set)  Granules: 2/2
```

Page plans (server, 26.9, before the `is_repeat` line; that line is a prewhere term and changes no key use):

```
G10  slot: ReadFromMergeTree (w3g.replay_events)   (the G06 slot)
       Prewhere filter column: race = 'N' AND subject_code IN ('eaom', 'eate') AND event_type IN ('building')
       Keys: race event_type subject_code   Granules: 28/118   generic exclusion search   (2,496 pairs)
     p0:   ReadFromMergeTree (w3g.replay_players) FINAL: 1
       Keys: replay_id player_id   Condition: ((replay_id, player_id) in 2496-element set)   Granules: 3/3
     p1:   ReadFromMergeTree (w3g.replay_players) FINAL: 1   Condition: true   Granules: 3/3
       Filter column: race = 'O'
     r:    ReadFromMergeTree (w3g.replays) FINAL: 1   Condition: true   Granules: 2/2
       Filter column: type = '1on1' AND RF2(replay_id, …) AND RF1(replay_id, …)   (runtime join filters)
G16  slot: Prewhere filter column: subject_code IN ('eaom', 'eate') AND event_type IN ('building')
       Keys: event_type subject_code   Granules: 118/118   generic exclusion search   (full scan)
G04  r:    Filter column: type = '1on1' AND RF1(replay_id, replay_id from w3g.replay_players)
G01  ReadFromMergeTree (w3g.replays) FINAL: 1   Condition: true   Granules: 2/2
G02  ReadFromMergeTree (w3g.replays) FINAL: 1   Keys: replay_id   Condition: (replay_id in 2-element set)   Granules: 2/2
```

- The `r` side gets runtime join filters (`RF1`, `RF2`), also past 1,000 probe rows. `enable_join_runtime_filters` came in 25.10 (default 0); default 1 since 26.2 (`system.settings_changes`). 26.8 has it; PR 2 confirms the `RF` lines on 26.8.

### 3.5 `GET /openers`

The SQL, over the view today and over `w3g.openers` after S2:

```sql
SELECT seq[{next:UInt8}] AS code,
       count() AS games,
       sum(won) AS wins,
       round(avg(duration_ms) / 60000, 1) AS avg_minutes,
       uniqExactIf(seq[{after:UInt8}], length(seq) >= {after:UInt8}) AS branches
FROM w3g.replay_openers
WHERE race = {race:String}
  [AND opponent_race = {opponent_race:String}]
  [AND map = {map:String}]
  [AND lowerUTF8(player_name) = lowerUTF8({player:String})]
  [AND duration_ms >= {min_ms:UInt32}]
  [AND duration_ms <= {max_ms:UInt32}]
  [AND arraySlice(seq, 1, {depth:UInt8}) = {prefix:Array(String)}]
GROUP BY code
ORDER BY games DESC, wins / games DESC, code                              -- sort=popular
ORDER BY games >= 10 DESC, wins / games DESC, games DESC, code            -- sort=winrate
```

- `[…]` lines appear only when set. `depth = len(prefix)`, `next = depth + 1`, `after = depth + 2`. No `prefix` line at depth 0.
- **`stopped`:** an opener that ends at `prefix` has `seq[next] = ''` (out-of-range index gives the default). Rust moves the `code = ''` row out of `rows`; `total = sum(games)`. At `prefix = eate,eaom`: `['', 59, 18, 3.8, 0]`. No clash: `seq` holds only mapped `building` codes (views.sql:68-69, S2 body).
- **One pass** (C4). index.html:906-923 joins two copies of the view (`c`, `b`), so the view runs twice per click. `uniqExactIf` gives `branches` in the same pass (w3warehouse analytics.py:712-717 does the same). At depth 5 (`after = 7`), `length(seq) >= 7` is never true (`seq` holds at most 6, views.sql:63), so `branches = 0`.
- The floor `10` is the server constant of api.md 3.5, pinned by tests here and in the UI.
- Measured (race N): depth 0 gives 4 rows, `eate` 2,503 games. `prefix = eate,eaom`, `sort = winrate`: `edob 466`, `etoa 872`, `etol 67`, `eden 816`, `eate 14`, `'' 59`. `player = MEDUSA#31315`: 1 row, `eate`, 2 games.

Plan today (the view, per click):

```
Join tree: opp[13134] ⋈ (mp[6567] ⋈ (r[3283] ⋈ (rp[2189] ⋈ (e ⋈ m))))
ReadFromMergeTree (w3g.replay_events)   Prewhere filter column: event_type = 'building'
  Keys: event_type   Granules: 118/118   generic exclusion search        (race is not pushed to the events)
ReadFromMergeTree (w3g.replay_players)  FINAL: 1   Condition: true   Granules: 3/3     (twice)
ReadFromMergeTree (w3g.replays)         FINAL: 1   Condition: true   Granules: 2/2     (twice: r and the map view)
ReadFromMergeTree (w3g.mappings)        Prewhere filter column: is_supply_building = 0 AND kind = 'building'
```

- Cost per click: 991,101 rows, 155.14 MiB (`system.query_log`). A `player` that matches nobody costs the same. The 60 s cache (api.md 2.7) keys on the URL, so each new `player` string is a new full scan. Hence S2 is a launch condition.

After S2 (`FROM w3g.openers`, local copy of the same rows):

```
ReadFromMergeTree (w3g.openers)
  Prewhere filter column: race = 'N' AND arraySlice(seq, 1, 2) = ['eate', 'eaom']
  Keys: race   Condition: (race in ['N', 'N'])   Granules: 1/2   Search Algorithm: binary search
```

Rows checked equal: `edob 466 254 14.6 5`, `etoa 872 447 16.1 6`, `etol 67 33 16.9 5` from both sources.

### 3.6 `GET /openers/replays`

Page today:

```sql
SELECT o.replay_id AS replay_id, o.player_id AS focus_player_id, count() OVER () AS total
FROM (
    SELECT replay_id, player_id
    FROM w3g.replay_openers
    WHERE race = {race:String}
      [AND … the same optional filters as 3.5 …]
      AND arraySlice(seq, 1, {depth:UInt8}) = {prefix:Array(String)}
) AS o
INNER JOIN (
    SELECT replay_id, gnl_series_id, gnl_game_no
    FROM w3g.replays FINAL
) AS r ON r.replay_id = o.replay_id
ORDER BY r.gnl_series_id DESC, r.gnl_game_no DESC, o.replay_id, o.player_id
LIMIT {limit:UInt32} OFFSET {offset:UInt32}
```

- One row per opener owner (api.md 3.6, A14). The view has 12,881 rows and 12,881 distinct `(replay_id, player_id)`, so no `GROUP BY`.
- A mirror where both hold the prefix gives two rows. Rust hydrates the distinct ids (3.4) and keeps each row's `focus_player_id`.
- The `replays` side relies on the runtime join filter (3.4). A `replay_id IN (view)` pre-filter would run the view a second time. The plan is the 3.5 plan plus one `replays FINAL` read.
- `prefix = eate,eaom,eden`, race N: 816 rows in 794 replays; 816 equals that tree row's `games`.

After S2 the join goes away:

```sql
SELECT replay_id, player_id AS focus_player_id, count() OVER () AS total
FROM w3g.openers
WHERE race = {race:String}
  [AND … the same optional filters as 3.5 …]
  AND arraySlice(seq, 1, {depth:UInt8}) = {prefix:Array(String)}
ORDER BY gnl_series_id DESC, gnl_game_no DESC, replay_id, player_id
LIMIT {limit:UInt32} OFFSET {offset:UInt32}
```

```
ReadFromMergeTree (w3g.openers)   Keys: race   Condition: (race in ['N', 'N'])   Granules: 1/2   Search Algorithm: binary search
```

- Measured on the local copy with an earlier `GROUP BY` shape; the `WHERE` is the same (`schema-pk-filter-on-orderby`). PR 2 re-runs `EXPLAIN` on this shape.

### 3.7 `GET /stats`

**Cohort** `<w>` on `w3g.replays FINAL`; `C` is `SELECT replay_id FROM w3g.replays FINAL WHERE <w>`:

```sql
type = '1on1'
[AND duration_ms >= {min_ms:UInt32}] [AND duration_ms <= {max_ms:UInt32}]
[AND replay_id IN (SELECT replay_id FROM w3g.replay_map WHERE map = {map:String})]
-- with opponent_race:
[AND replay_id IN (
    SELECT p.replay_id
    FROM (SELECT replay_id, team_id FROM w3g.replay_players FINAL [WHERE race = {race:String} [AND lowerUTF8(name) = lowerUTF8({player:String})]]) AS p
    INNER JOIN (SELECT replay_id, team_id FROM w3g.replay_players FINAL WHERE race = {opponent_race:String}) AS q
        ON q.replay_id = p.replay_id
    WHERE q.team_id != p.team_id)]
-- without opponent_race, but race or player set:
[AND replay_id IN (SELECT replay_id FROM w3g.replay_players FINAL WHERE race = {race:String} [AND lowerUTF8(name) = lowerUTF8({player:String})])]
```

Four queries in parallel. Exact filtered texts: §7 T1-T4.

```sql
-- durations (its sum is `games`)
SELECT least(intDiv(duration_ms, 300000), 12) AS bucket, count() AS n
FROM w3g.replays FINAL
WHERE <w>
GROUP BY bucket
ORDER BY bucket WITH FILL FROM 0
```

```sql
-- apm, over player-games
SELECT least(intDiv(apm, 25), 20) AS bucket, count() AS n
FROM w3g.replay_players FINAL
WHERE replay_id IN (C)
GROUP BY bucket
ORDER BY bucket WITH FILL FROM 0
```

```sql
-- matchups
SELECT p.race AS race, q.race AS opponent_race,
       uniqExact(p.replay_id) AS games,
       uniqExactIf(p.replay_id, r.winning_team_id >= 0) AS decided,
       uniqExactIf(p.replay_id, r.winning_team_id >= 0 AND r.winning_team_id = p.team_id) AS wins
FROM (SELECT replay_id, player_id, race, team_id FROM w3g.replay_players FINAL WHERE replay_id IN (C)) AS p
INNER JOIN (SELECT replay_id, player_id, race, team_id FROM w3g.replay_players FINAL WHERE replay_id IN (C)) AS q
    ON q.replay_id = p.replay_id
INNER JOIN (SELECT replay_id, winning_team_id FROM w3g.replays FINAL WHERE replay_id IN (C)) AS r
    ON r.replay_id = p.replay_id
WHERE q.team_id != p.team_id
GROUP BY race, opponent_race
ORDER BY race, opponent_race
```

```sql
-- heroes: is_total = 1 marks the race total (the share's denominator)
SELECT p.race AS race, h.hero_id AS code, 0 AS is_total, uniqExact(h.replay_id, h.player_id) AS player_games
FROM (SELECT replay_id, player_id, hero_id FROM w3g.player_heroes FINAL WHERE replay_id IN (C) AND hero_id != '') AS h
INNER JOIN (SELECT replay_id, player_id, race, team_id FROM w3g.replay_players FINAL WHERE replay_id IN (C)) AS p
    ON p.replay_id = h.replay_id AND p.player_id = h.player_id
GROUP BY race, code
UNION ALL
SELECT race, '' AS code, 1 AS is_total, count() AS player_games
FROM w3g.replay_players FINAL
WHERE replay_id IN (C)
GROUP BY race
```

- `games` = the sum of the durations counts = `uniqExact(replay_id)` of the cohort.
- `WITH FILL FROM 0` gives a dense array (api.md 3.7). No filter: 13 duration rows, 21 APM rows. Filtered: `[[0,0],[1,1]]`.
- A mirror row gets `wins = null` in Rust. `FINAL` on every read; `uniqExact` where a join can fan out. No plain `count()` over `replay_events` (clickhouse-audit finding 7).
- Heroes: `hero_id != ''` drops the 68 empty rows; Rust reads the total from `is_total = 1`. Each race has exactly one `code = ''` row.
- Stats read no order rows, so `is_repeat` does not touch them. An identical `IN (C)` is built once (plan shows `subquery1` twice).
- Decided: `H O N U R` are the storage values in `replay_players.race` and the event tables, and every race `{…:String}` param here takes a letter; the wire ids are the GNL ids `HU OC NE UD RANDOM`, and the Rust API maps each one to its letter before the SQL runs and back again when it hydrates. `R` is a fifth race. No filter: `R` has 1,004 player-games, e.g. `['R', 'Ucrl', 106]`.

```
filtered durations: ReadFromMergeTree (w3g.replays) FINAL: 1
                      Keys: replay_id   Condition: (replay_id in 1-element set)   Granules: 2/2   Search Algorithm: binary search
filtered matchups:  ReadFromMergeTree (w3g.replay_players) FINAL: 1
                      Keys: replay_id   Condition: (replay_id in 1-element set)   Granules: 2/3   Search Algorithm: binary search
```

### 3.8 `GET /replays/{id}`

Four queries in parallel. A header with 0 rows gives 404 `No game with this id`. Params: `{"id": "<64 hex>"}`.

```sql
-- header
SELECT r.replay_id AS replay_id, mp.map AS map, r.matchup AS matchup, r.duration_ms AS duration_ms,
       r.winning_team_id AS winning_team_id, r.version AS version,
       r.gnl_series_id AS gnl_series_id, r.gnl_game_no AS gnl_game_no, r.source_key AS source_key
FROM (
    SELECT replay_id, matchup, duration_ms, winning_team_id, version, gnl_series_id, gnl_game_no, source_key
    FROM w3g.replays FINAL
    WHERE replay_id = {id:String}
) AS r
LEFT JOIN (SELECT replay_id, map FROM w3g.replay_map WHERE replay_id = {id:String}) AS mp ON mp.replay_id = r.replay_id
```

```sql
-- players, with heroes
SELECT p.player_id AS player_id, p.name AS name, p.race AS race, p.team_id AS team_id,
       p.apm AS apm, p.apm_timed AS apm_per_minute, h.heroes AS heroes
FROM (
    SELECT player_id, name, race, team_id, apm, apm_timed
    FROM w3g.replay_players FINAL
    WHERE replay_id = {id:String}
) AS p
LEFT JOIN (
    SELECT player_id, arraySort(groupArray((hero_slot, hero_id, final_level))) AS heroes
    FROM w3g.player_heroes FINAL
    WHERE replay_id = {id:String} AND hero_id != ''
    GROUP BY player_id
) AS h ON h.player_id = p.player_id
ORDER BY p.player_id
```

```sql
-- events (the timeline)
SELECT player_id, time_ms, event_type, code, hero_code
FROM (
    SELECT player_id, time_ms, CAST(kind AS String) AS event_type, object_code AS code,
           CAST(NULL, 'Nullable(String)') AS hero_code, seq
    FROM w3g.player_order_events FINAL
    WHERE replay_id = {id:String} AND kind != 'unknown' AND is_repeat = 0
    UNION ALL
    SELECT player_id, time_ms,
           if(event_type = 'retraining', 'hero_retrained', 'hero_skill'),
           if(event_type = 'retraining', hero_id, ability_id),
           hero_id, seq
    FROM w3g.hero_ability_events FINAL
    WHERE replay_id = {id:String}
    UNION ALL
    SELECT player_id, min(time_ms), 'hero_trained', hero_id, NULL, 0
    FROM w3g.hero_ability_events FINAL
    WHERE replay_id = {id:String}
    GROUP BY player_id, hero_id
)
ORDER BY time_ms, player_id, seq
```

```sql
-- chat
SELECT time_ms, player_id, mode, message
FROM w3g.chat FINAL
WHERE replay_id = {id:String}
  AND mode = 'All'
ORDER BY time_ms, seq
```

- Source: the `replay_id`-keyed tables, not `replay_events` (api.md 3.8, clickhouse-audit §4.3). A `replay_events` read by `replay_id` is a full scan on every candidate key (S1 key: `Granules: 116/116`).
- The union rebuilds what `mv_events__order`, `mv_events__hero` and `mv_events__hero_trained` write (views.sql:358-431), with the same `hero_trained = min(time_ms)` rule. `seq = 0` sorts `hero_trained` before its first skill at the same `time_ms`. `hero_code` is `Nullable(String)`.
- Decided: `hero_trained` timing is accepted (the first ability cast, not the training order). `is_repeat = 0` hides flagged repeats (§9). Private chat is hidden (`mode = 'All'`).
- Decided (C9): a retrain is `hero_retrained`, `code = hero_id`. It is timeline-only, not a search step kind; api.md 3.8 lists it in the `events[].event_type` enum. `hero_ability_events` has `ability` (87,357 rows, none empty) and `retraining` (416, all `ability_id = ''`). `mv_events__hero` has no type filter, so `replay_events` holds 416 `hero_skill` rows with `subject_code = ''`. Search validation rejects `''`, so no step matches them. In 0 groups does the first retrain come at or before the first ability, so `hero_trained` is unaffected.
- `dcd3…`: 158 `replay_events` rows minus 6 `unknown` = 152 raw events; 5 `hero_trained`; 3 chat lines; heroes `[[0,'Edem',4],[1,'Ekee',4]]`. Emulated flag: 1 building and 1 upgrade row are repeats, so 150 events after PR 2 (D1-D4).
- Decided: the `kind != 'unknown'` filter stays in SQL (6/104 granules, generic exclusion search).

```
header:  ReadFromMergeTree (w3g.replays) FINAL: 1  Keys: replay_id  Condition: (replay_id in ['dcd3…', 'dcd3…'])  Granules: 2/2  binary search  (twice: r and the view)
players: ReadFromMergeTree (w3g.replay_players) FINAL: 1  Keys: replay_id  Granules: 2/3  binary search
         ReadFromMergeTree (w3g.player_heroes)  FINAL: 1  Keys: replay_id  Granules: 2/4  binary search
events:  ReadFromMergeTree (w3g.player_order_events) FINAL: 1  Keys: replay_id kind
           Condition: and((kind not in [5, 5]), (replay_id in ['dcd3…', 'dcd3…']))  Granules: 6/104  generic exclusion search
         ReadFromMergeTree (w3g.hero_ability_events) FINAL: 1  Keys: replay_id  Granules: 2/12  binary search  (twice)
chat:    ReadFromMergeTree (w3g.chat) FINAL: 1  Keys: replay_id  Granules: 1/1  binary search
```

## 4. The build-order search compiler

Input: the validated body of api.md 3.4, plus `limit` and `offset` (no `sort`, api.md A2). Output: one SQL text and one param map. The compiler never reads the database. Validation runs first against the `mappings` cache (3.2). An empty body lists every game (G01).

### 4.1 Rules

| # | Part | Rule |
|---|---|---|
| 1 | Replay filter `r` | Always `type = '1on1'` (index.html:750). `min_minutes` → `duration_ms >= {min_ms:UInt32}` (× 60000); `max_minutes` → `duration_ms <= {max_ms:UInt32}`. `map` → `replay_id IN (SELECT replay_id FROM w3g.replay_map WHERE map = {map:String})`. Any slot with `result`: add `winning_team_id >= 0`. |
| 2 | No slots | `SELECT r.replay_id AS replay_id, count() OVER () AS total FROM w3g.replays AS r FINAL WHERE <r> ORDER BY … LIMIT … OFFSET …`. No focus player (api.md 2.5). |
| 3 | Slot set, 1 step | `SELECT replay_id, player_id FROM w3g.replay_events WHERE [race = {gI_race:String} AND] is_repeat = 0 AND <cond0> GROUP BY replay_id, player_id`. No `sequenceMatch` (it needs 2+ conditions; the `WHERE` is the whole test, index.html:720-721). No dedup step. |
| 4 | Slot set, 2+ steps, filter | `[race = {gI_race:String} AND] is_repeat = 0 AND event_type IN {gI_types:Array(String)} AND subject_code IN {gI_codes:Array(String)}` (sorted distinct values, byte order). |
| 5 | Slot set, 2+ steps, shape | `SELECT replay_id, player_id FROM (SELECT DISTINCT replay_id, player_id, time_ms, event_type, subject_code, seq FROM w3g.replay_events WHERE <rule 4>) GROUP BY replay_id, player_id HAVING sequenceMatch({gI_pat:String})(time_ms, <cond0>, …, <condN>)`. `DISTINCT` removes an unmerged duplicate and keeps `seq`, so real same-ms repeats survive (C8). A gap step adds its own aggregate to the `HAVING` (rule 7). |
| 6 | Step condition | `event_type = {gI_sK_type:String} AND subject_code = {gI_sK_code:String}`, plus `AND time_ms >= {gI_sK_from:UInt32}` and `AND time_ms <= {gI_sK_to:UInt32}` when set (s × 1000). |
| 7 | Patterns | The ordering pattern is `(?1)`, then `.*(?k)` per step k ≥ 2. It never carries `(?t…)`. Each step k with `within_previous_seconds` adds one more aggregate to the `HAVING`: `sequenceMatch({gI_sK_pat:String})(time_ms, <cond k-1>, <cond k>)`, pattern `(?1)(?t<={ms})(?2)`. Only that gap's two codes are conditions there, so no third step code can break it (§4.2). `ms` = s × 1000 (`time_ms` is milliseconds). Both patterns bind as `String` params. Forbidden: `(?t<=N).*` (w3warehouse compiler.py:909), `.*(?t<=N)`, bare `(?1)(?2)` (demands adjacency, clickhouse-audit §6), and any `(?t…)` in a pattern with 3 or more conditions. Only this rule produces links. |
| 8 | Slot player `pI` | `SELECT replay_id, player_id, team_id FROM w3g.replay_players FINAL WHERE [race = {gI_race:String}] [AND lowerUTF8(name) = lowerUTF8({gI_player:String})] [AND (replay_id, player_id) IN (<slot set>)]`. No `WHERE` when all three are absent. |
| 9 | Join | `FROM (<r>) AS r INNER JOIN (<p0>) AS p0 ON p0.replay_id = r.replay_id [INNER JOIN (<p1>) AS p1 ON p1.replay_id = r.replay_id]`. |
| 10 | Slots intersect | 2 slots: `WHERE p1.team_id != p0.team_id`. Every replay has 2 players on 2 teams, so each slot is one player (api.md A11) and a mirror works (G12). The `p1` race filter enforces the opponent race exactly (C3). |
| 11 | Result | `won` → `r.winning_team_id = pI.team_id`; `lost` → `r.winning_team_id != pI.team_id`. Both need rule 1's `winning_team_id >= 0`. |
| 12 | Grain and focus | `GROUP BY r.replay_id, r.gnl_series_id, r.gnl_game_no, r.duration_ms`. `min(p0.player_id) AS focus_player_id` (the lower id when both fit). `count() OVER () AS total`. The `GROUP BY` removes duplicates (G14: 364 rows, 364 ids). |
| 13 | Order | One fixed order (api.md 2.4, A2): `r.gnl_series_id DESC, r.gnl_game_no DESC, r.replay_id`, then `LIMIT {limit:UInt32} OFFSET {offset:UInt32}`. |
| 14 | Param names | `gI_race`, `gI_player`, `gI_sK_type`, `gI_sK_code`, `gI_sK_from`, `gI_sK_to`, `gI_types`, `gI_codes`, `gI_pat`, `gI_sK_pat`, `min_ms`, `max_ms`, `map`, `limit`, `offset`. `I` = slot, `K` = step. `gI_race` appears in both the slot set and `pI`. |
| 15 | Layout | 4 spaces per nesting level, exactly as §7. Goldens compare bytes. In a slot `WHERE`, each term after the first goes on its own `AND` line: race, `is_repeat = 0`, then the conditions. |

### 4.2 `sequenceMatch` facts

**`sequenceMatch` skips only events that match no condition.** The ClickHouse docs show conditions `number = 1`, `number = 2`, `number = 3` over the data 1, 3, 2: `(?1)(?2)` gives 0, because the 3 matches a condition and sits between. A `(?t<=N)` link therefore demands that its two steps are adjacent among the events that match any step. The slot `WHERE` admits every step code (rule 4), so with 3 or more steps one order of another step's code between the pair breaks the chain. The search then loses a real game.

**The compiler splits the two jobs** (rule 7). The ordering pattern keeps `.*` between every step and carries no `(?t…)`. Each gap step compiles to its own two-condition aggregate `sequenceMatch('(?1)(?t<=N)(?2)')(time_ms, <cond K-1>, <cond K>)`, ANDed into the `HAVING`. Only those two codes are conditions in that aggregate, so only they can break the gap.

Each ran as `SELECT sequenceMatch({p:String})(t, <conds>) FROM values('t UInt32, e String', …)` (26.9).

| Events (ms) | Conditions | Pattern | Result | Shows |
|---|---|---|---|---|
| A@0, A@5000, B@100000 | A, B | `(?1)(?t<=10000)(?2)` | 0 | The correct gap form rejects it |
| A@0, A@5000, B@100000 | A, B | `(?1)(?t<=10000).*(?2)` | 1 | The w3warehouse form gives a false match |
| A@0, X@3000, B@8000 | A, B | `(?1)(?t<=10000)(?2)` | 1 | A non-matching event does not break the gap |
| A@0 | A, A | `(?1).*(?2)` | 0 | "A then A" needs 2 events |
| A@0, A@10 | A, A | `(?1).*(?2)` | 1 | |
| A@0, A@0 (one row duplicated) | A, A | `(?1).*(?2)` and `(?1)(?t<=10000)(?2)` | 1 and 1 | A duplicate counts; rule 5's `DISTINCT` exists for this |
| A@0, B@10001 | A, B | `(?1)(?t<=10000)(?2)` | 0 | The bound is inclusive: 10001 fails |
| A@0, B@10000 | A, B | `(?1)(?t<=10000)(?2)` | 1 | … and 10000 passes |

The case that fixed rule 7 (G08's shape: `eaom`, then `eate` within 30 s, then `unit ewsp`, with a wisp order between `eaom` and `eate`). Not run here; it follows from the skip rule above, and PR 6 pins it as a golden.

| Events (ms) | Conditions | Pattern | Result | Shows |
|---|---|---|---|---|
| eaom@0, ewsp@1000, eate@2000, ewsp@3000 | eaom, eate, ewsp | `(?1)(?t<=30000)(?2).*(?3)` | 0 | The old one-pattern form drops a real build |
| the same rows | eaom, eate, ewsp | `(?1).*(?2).*(?3)` | 1 | The ordering pattern holds |
| the same rows | eaom, eate | `(?1)(?t<=30000)(?2)` | 1 | The gap aggregate sees only its own two codes |

The two new aggregates both give 1, so the slot matches.

Known limit, accepted: the gap aggregate and the ordering pattern match independently. A slot with an early A, B, C chain and a late A, B pair within N passes, although no single chain holds both. Rare on real builds; a golden in PR 6 records the shape. The old form's false negative hit every 3-step search with a common third code.

- **Equal timestamps.** `hero_trained` ties with the hero's first skill (views.sql:405-431). No documented order guarantee was found. Measured: "`hero_trained Edem` then a Demon Hunter skill" matches 1,605 of 1,605 player-games; the reverse order matches 3. Decided (C5): keep plain `time_ms` and pin golden E1 (§7).
- **Split `hero_trained`.** views.sql:405-408 assumes a hero's ability events arrive in one INSERT block. One doc is one `replays_raw` row, so this holds per doc. If it fails, two `hero_trained` rows land with different `time_ms`; neither `FINAL` nor `DISTINCT` merges them. The fix belongs in the load path, not the compiler. No step search asks "`hero_trained X` then `hero_trained X`".

### 4.3 D4 forms (PRs 15-16)

Decided (stories.md D4): minimum count, "without" and first hero are in, as PRs 15-16. Each keeps the slot's `GROUP BY replay_id, player_id` and adds one bound `HAVING` term. PR 15 adds one golden per form to §7.

| Form | Slot term | Full load (stories.md) |
|---|---|---|
| Count | `uniqExactIf(seq, <cond>) >= {gI_sK_min:UInt32}` over rows with `is_repeat = 0`; counts orders, not finished objects | NE, at least 5 `earc` orders by 5:00: 1,100 |
| Without | the "without" codes join the slot `IN` list; `countIf(subject_code IN {gI_without:Array(String)}) = 0`. A slot with only "without" codes uses `replay_players` of that race as its base. | NE, `eate`, without `eden`: 573 |
| First hero | earliest `hero_trained` is the code | NE, first hero `Edem`: 1,430 |

## 5. Schema changes

Five changes: S1-S3 and S5 change tables; S4 pins the image. S1, S2 and S5 land in PR 2; S3 in PR 3.

**How they land: a rebuild.** ClickHouse is derived state (PLAN.md:105): edit tables.sql and views.sql, `DROP DATABASE w3g`, then schema, mappings and a reload: `just box::schema box::mappings box::backfill-bucket` on the box; `just local::schema local::mappings local::load local::fixtures` and `just fixtures::up` locally (plan.md PR 1, PR 2; rust.md §16). No hand `EXCHANGE`, MV re-point or `DROP`.

- `backfill-bucket` reloads only what the bucket holds. The dev set reaches a bucket through PR 1b (`chore/drain-battle-test`, `just fixtures::battle-test`, rust.md §16), in containers only: the compose MinIO (`local` profile), the 6,564 files at `dev/replays/<file stem>/game1.w3g` (`W3WAREHOUSE_S3_PREFIX=dev`), the drain image `--once`, then `backfill-bucket`. Gates: plan.md PR 1b. The `dev/` prefix and its fake series ids never reach the org deploy.
- backfill.sql:17-23 gains `LIMIT 1 BY replay_id`, so one glob cannot stage a replay twice. C8's `DISTINCT` covers two concurrent runs.

### S1. `replay_events` ORDER BY → `(race, event_type, subject_code, replay_id, player_id, time_ms, seq)`

- **Rules:** `schema-pk-filter-on-orderby`, `schema-pk-prioritize-filters`, `schema-pk-plan-before-creation`, `schema-pk-cardinality-order` (race 5 < event_type 7 < subject_code ~600 < replay_id).
- **Access path:** every step sets `event_type` and `subject_code` (§4 rules 3-4); today they sit after `replay_id` (tables.sql:213). The opener refresh reads `event_type = 'building'` (views.sql:78).
- Rows estimated on a local copy (116-117 granules), measured on 26.9:

| Access | Current `(race, matchup, replay_id, …)` | Audit `(race, matchup, event_type, subject_code, …)` | **Decided `(race, event_type, subject_code, replay_id, …)`** | Event-first `(event_type, subject_code, race, …)` |
|---|---|---|---|---|
| G04 race N, 1 hero step | 204,800 (25) | 73,728 (9) | **16,384 (2)** | 8,192 (1) |
| G06 race N, 2 buildings | 204,800 (25) | 49,152 (6) | **16,384 (2)** | 16,384 (2) |
| G10 race N, opponent O | 57,344 (7) | 8,192 (1) | **16,384 (2)** | 16,384 (2) |
| G16 no race | 950,132 (116) | 188,416 (23) | **40,960 (5)** | 16,384 (2) |
| G08 race N, wisp + 2 more | 204,800 (25) | 204,800 (25) | **114,688 (14)** | 106,496 (13) |
| Opener refresh (`building`) | 950,132 (116) | 393,216 (48) | **262,144 (32)** | 237,568 (29) |

- The Current and Audit keys carry `matchup` after `race`, so their G10 figures used the matchup filter. The event-first column carries no `matchup`: its G10 equals its G06.
- Decided: the proposed key. Why: every race-set search reads one unbroken prefix; event-first wins 1-3 granules only when race is blank.
- `matchup` left the key (C3). Its saving grows with the corpus: the G10 range is about 1/5 of the G06 range. G08 gains least: `ewsp` is 25% of Night Elf rows.
- Before (server, 4 parts, G06): `Keys: race event_type subject_code … Granules: 28/118 … generic exclusion search`. After (local): `Granules: 2/117`. Same result set (2,496 pairs).
- Worse: a read by `replay_id` alone. No route does one.
- **Change:** tables.sql:195-197 (comment), tables.sql:213 (key). `matchup` stays as a column (`mv_events__order` writes it, views.sql:362); 3.8 does not read it.

### S2. `w3g.openers`, built by a refreshable MV, replaces `opener_rollup`

- **Rules:** `query-mv-refreshable`, `query-join-filter-before`, `schema-types-lowcardinality`.
- **Access path:** every `/openers` click and `/openers/replays` page runs the view: a full `replay_events` scan (118/118), `replay_players FINAL` twice, `replays FINAL` twice, the map regex on every replay. `opener_rollup` cannot serve the player filter (tables.sql:241-254), and nothing reads it (schema.md; clickhouse-audit finding 3).
- **Launch condition.** `/openers` and `/openers/replays` go public only after S2: each click reads 991,101 rows and 155.14 MiB today, on a 2 vCPU box (PLAN.md:78-81). The 26.9 host binary ran `max_threads = auto(16)`; a container sees the same host cores unless compose caps its CPUs. api.md 3.5 states the same condition. Fallback only if launch must come first: `max_threads = 1` in the api profile (rust.md §8); cost: every route then runs single-threaded.

```sql
CREATE TABLE IF NOT EXISTS w3g.openers
(
    race           LowCardinality(String),
    opponent_race  LowCardinality(String),
    map            LowCardinality(String),
    replay_id      String,
    player_id      UInt8,
    player_name    String,
    won            UInt8,
    duration_ms    UInt32,
    gnl_series_id  UInt32,
    gnl_game_no    UInt8,
    seq            Array(LowCardinality(String))
)
ENGINE = MergeTree
ORDER BY (race, opponent_race, map, replay_id, player_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.refresh__openers
REFRESH EVERY 1 DAY
TO w3g.openers AS
SELECT rp.race AS race, opp.race AS opponent_race, mp.map AS map, e.replay_id AS replay_id, e.player_id AS player_id,
       rp.name AS player_name, toUInt8(r.winning_team_id = rp.team_id) AS won, r.duration_ms AS duration_ms,
       r.gnl_series_id AS gnl_series_id, r.gnl_game_no AS gnl_game_no, e.seq AS seq
FROM (
    SELECT replay_id, player_id,
           arraySlice(arrayCompact(arrayMap(t -> t.2, arraySort(t -> t.1, groupArray((time_ms, subject_code))))), 1, 6) AS seq
    FROM w3g.replay_events
    WHERE event_type = 'building'
      AND is_repeat = 0
      AND subject_code IN (SELECT code FROM w3g.mappings WHERE kind = 'building' AND is_supply_building = 0)
    GROUP BY replay_id, player_id
) AS e
INNER JOIN (SELECT replay_id, player_id, name, race, team_id FROM w3g.replay_players FINAL) AS rp
    ON rp.replay_id = e.replay_id AND rp.player_id = e.player_id
INNER JOIN (SELECT replay_id, player_id, race, team_id FROM w3g.replay_players FINAL) AS opp
    ON opp.replay_id = e.replay_id
INNER JOIN (SELECT replay_id, duration_ms, winning_team_id, gnl_series_id, gnl_game_no
            FROM w3g.replays FINAL WHERE type = '1on1' AND winning_team_id >= 0) AS r
    ON r.replay_id = e.replay_id
INNER JOIN w3g.replay_map AS mp ON mp.replay_id = e.replay_id
WHERE rp.team_id != opp.team_id AND opp.player_id != e.player_id
SETTINGS max_bytes_before_external_group_by = 1500000000;
```

- **Aggregate first**, `mappings` via `IN` (the view joins first and aggregates last, views.sql:45-88). Checked equal to the view: 12,881 rows, 74,553 `seq` items, same `sum(cityHash64(replay_id, player_id, seq, race, opponent_race, map, won, duration_ms))` (2 runs each).
- `is_repeat = 0` changes 0 of the 12,881 `seq` arrays on the full load (emulated flag; `arrayCompact` already drops the adjacent twin). O1-O4 and R1 keep their totals.
- **Memory at 6,567 replays:** the view peaks at 155.14 MiB; this body at 122.58 MiB (-21%). Both read about 990,000 rows. If memory grows linearly: ~19 MiB at 1,000 replays, ~1.9 GB at 100,000; the box has 4 GB, capped at 80% (tuning.xml:16). S2 must ship before ~20,000 replays. Decided: PR 2 re-measures the refresh peak.
- The `SETTINGS` guard stays (views.sql:467-470). It spills the inner `GROUP BY` to disk past 1.5 GB. It does not cover the joins; join spill is not checked. The refresh runs as the MV definer, not the `readonly` user.
- Cadence: `REFRESH EVERY 1 DAY` as a safety net. Data enters only through `backfill` and `load` (backfill.sql:1-3; the drain writes to the bucket, not ClickHouse: drain.rs:1-4), so a shorter timer adds cost and no freshness (`query-mv-refreshable`). Both recipes refresh after every load (justfile:47, moved to `just/local.just` in PR 1, renamed to `SYSTEM REFRESH VIEW w3g.refresh__openers`).
- After (local): 12,881 rows (6,467 replays), `Keys: race`, `Granules: 1/2`, `binary search`. Key follows `schema-pk-cardinality-order`: race (5) < opponent_race (5) < map (14) < replay_id. With S1, the refresh reads 32 granules, not 116.
- **Change:** add both statements; change justfile:47; point 3.5 and 3.6 at `w3g.openers`; delete views.sql:433-470 and tables.sql:237-254; the `replay_openers` view (views.sql:45-88) goes once nothing reads it.

### S3. `replays.source_key`: the raw object key, for `download_url`

Decided (stories.md D1, C10): the drain writes the raw R2 object key into each doc; `replays.source_key` stores it; `download_url` = public base URL + `source_key`. Why: the key is where the file sits, so it cannot drift. PR 3 builds it (not conditional).

- drain.rs:203-206: the `gnl` object gains `"key": raw_key` next to `series_id` and `game_no`.
- tables.sql:36: `source_key String DEFAULT ''` after `gnl_game_no`. Empty means "no file" (`schema-types-avoid-nullable`).
- views.sql:97: `JSONExtractString(r.doc, 'gnl', 'key') AS source_key` in `mv__replays`.
- 3.4 hydrate and 3.8 header select it.
- rust.md §9 builds `download_url` = `DOWNLOAD_BASE_URL` + `source_key` when both are set, else null. The search mockup shows "No file" rows (build-order-search.html).
- Re-stage: re-run the drain over the staging bucket's `replays/` with the breadcrumbs cleared, then rebuild (PLAN.md:106). A replay not from the drain keeps `''` and shows "No file".
- Decided: the list keeps its fixed order (§4 rule 13). The PR 3 re-stage adds a play date if the drain can read the upload time.

### S4. Pin the ClickHouse image to 26.8.2

Decided: PR 2 pins compose.yaml:12, compose.yaml:43 and infrastructure/ci.yml:26 to `clickhouse/clickhouse-server:26.8.2` (the newest tag of the 26.8 LTS line; today 24.10). The concrete patch tag is pinned, not `26.8`: `26.8` moves, and every measured plan here must run on one fixed server. A patch bump is a one-line commit. Why 26.8: the plans in 3.4 and 3.6 skip a pre-join filter on `replays` because the server adds a runtime join filter, on by default from 26.2 (`query-join-filter-before`). Every plan and M-fact here was measured on 26.9 (host binary); PR 2 re-runs them in the 26.8 container before it lands. The local project, the fixtures project, CI and the box all run this one image (plan.md §4).

### S5. `is_repeat` on order rows

`player_order_events` and `replay_events` gain `is_repeat UInt8 DEFAULT 0`, set at load in PR 2. The rule, the MV SQL and the route effects are in §9.

### Considered, not proposed

| Idea | Rule | Why not now | Add when |
|---|---|---|---|
| `matchup` in the `replay_events` key and slot `WHERE` | `schema-pk-prioritize-filters` | Saves 1 granule on G10 (2 → 1). Costs the Random exception, a param, a key column, 5 golden branches. | Two-race searches dominate the slow-query log and the G10 slot read passes ~50 granules. Add after `subject_code`, never for an `R` slot (964 of 1,004 Random players have a rolled race in `matchup`). |
| `map` on `replays` (`MATERIALIZED`) | `query-join-consider-alternatives` | Rows read do not change; saves the 5 regexes per row (not measured). S2 stores `map` for openers. | A map filter or `/filters` shows in the slow-query log. Migration: one `ALTER TABLE … ADD COLUMN … MATERIALIZED`. |
| Skip index on `replay_players.name` | `query-index-skipping-indices` ("not as a first step") | The table is 3 granules. | `replay_players` passes ~50 granules. |
| Projection on `replay_events` by `replay_id` | – | 3.8 reads the source tables; server has `deduplicate_merge_projection_mode = throw` (clickhouse-audit §4.3). | Never, while 3.8 holds. |
| Coarse time-window pre-filter for 2+ steps (w3warehouse compiler.py:716-749) | `schema-pk-filter-on-orderby` | `time_ms` follows `replay_id` in every key; prunes nothing. | – |
| Filter `replays` by the slot set before the join | `query-join-filter-before` | A second `IN (<slot set>)` rebuilds the set; 26.2+ adds `RF1`. | Only if the runtime join filter is absent on 26.8. |

## 6. Design choices

| # | Decided | Why |
|---|---|---|
| C1 | Page query, then a hydrate by `replay_id IN {ids}` (3.4). | Each reads a key range; the hydrate is shared by 3.4 and 3.6. index.html:820-840 splits them the same way. |
| C2 | Filter `replay_players FINAL` by `(replay_id, player_id) IN (<slot set>)` before the join (§4 rule 8). | Plan shows `((replay_id, player_id) in 2496-element set)` on the key (`query-join-filter-before`). |
| C3 | Events filter on `race` only; the `p1` join enforces the opponent race. | `matchup` saves 1 granule on G10 only and costs the `R` exception, a param, a key column and 5 golden branches. |
| C4 | Openers in one pass with `uniqExactIf`; `code = ''` is `stopped`. | Halves the view runs; `stopped` is free (api.md A7). |
| C5 | Plain `time_ms` for equal timestamps, pinned by golden E1. | 1,605 of 1,605 in the intended order; a composite timestamp changes every golden. |
| C6 | S1 key, in the PR 2 rebuild. | 25 → 2 granules with race, 116 → 5 without. |
| C7 | S2, a launch condition for public openers. | 991k rows and 155 MiB per click become 1 granule; removes an unused table. |
| C8 | `SELECT DISTINCT` on the RMT key columns before a 2+ step `GROUP BY`, plus `LIMIT 1 BY replay_id` in backfill.sql. | Exact by construction. G06 slot: 2,496 pairs in all shapes; memory plain 1.42 MiB, `DISTINCT` 1.44 MiB, `FINAL` 14.15 MiB. |
| C9 | Timeline emits a retrain as `hero_retrained`, `code = hero_id` (3.8). | A retrain is a real action; relearned skills otherwise look like a data error. Cost: two `if()`s, one api.md 3.8 enum value, one UI label. |
| C10 | S3 `source_key` (stories.md D1). | The key cannot drift from the file. |
| C11 | S4, pin `26.8.2`; PR 2 re-measures on it. | Runtime join filters are on by default from 26.2. |
| C12 | Flag repeats at load (`is_repeat`), never delete (§9). | Replays record commands; flagged rows stay for audit (`insert-mutation-avoid-delete`). |

## 7. SQL goldens

Request in, exact SQL and params out. The compiler emits this text byte for byte (without `FORMAT`). "Total" is the full-load result on 26.9, for information only. No golden G01-G17 uses a flagged code (§9), so the `is_repeat` line leaves their totals unchanged. G08's count was measured with the old gap form; PR 6 re-measures.

| # | Request body (query keys) | Branch covered | Pattern | Total |
|---|---|---|---|---|
| G01 | `{}` | no slots | – | 6,567 |
| G02 | `{"map":"Springtime 1.3","min_minutes":5,"max_minutes":10}` | map, min, max | – | 2 |
| G03 | `{"groups":[{"race":"N"}]}` | empty slot, race only | – | 2,494 |
| G04 | slot N, step `hero_trained Edem` | 1 step: no `sequenceMatch`, no `DISTINCT` | – | 1,520 |
| G05 | slot N, `building eate` 0-15 s | step window | – | 2,162 |
| G06 | slot N, `eate` then `eaom` | 2 steps, open gap, `DISTINCT` | `(?1).*(?2)` | 2,263 |
| G07 | as G06, `eaom` within 60 s | gated gap, its own aggregate | `(?1).*(?2)` plus `(?1)(?t<=60000)(?2)` | 2,110 |
| G08 | slot N, `eate`, `unit ewsp` within 30 s, `hero_trained Edem` | 3 steps, mixed | `(?1).*(?2).*(?3)` plus `(?1)(?t<=30000)(?2)` | re-measure in PR 6 (old form: 1,499) |
| G09 | slot N, `emow` then `emow` | repeated step, IN lists deduped | `(?1).*(?2)` | 2,408 |
| G10 | G06 slot + `{"race":"O"}` | 2 slots, empty second | `(?1).*(?2)` | 654 |
| G11 | G06 slot + slot O `building oalt` | both slots have steps | `(?1).*(?2)` | 654 |
| G12 | slot N `eate` + slot N `eate` | mirror | – | 277 |
| G13 | slot N, player `medusa#31315`, won, `hero_trained Edem` | player bind, won | – | 2 |
| G14 | slot N `eate` + slot O lost | lost on slot 1 | – | 364 |
| G15 | slot N `eate` + slot R | `R` needs no branch | – | 184 |
| G16 | slot with no race, `eate` then `eaom` | no race: no key prefix | `(?1).*(?2)` | 2,439 |
| G17 | `{}` with `limit=2&offset=1` | paging | – | 6,567 |
| G18 | slot O, `building ostr` then `building ostr` | flagged code | `(?1).*(?2)` | 17 (693 raw; emulated flag, re-measured in PR 2) |

Each step object is `{"event_type": …, "subject_code": …}` plus the named timing fields.

<details><summary>G01 no slots</summary>

```sql
SELECT r.replay_id AS replay_id, count() OVER () AS total
FROM w3g.replays AS r FINAL
WHERE type = '1on1'
ORDER BY r.gnl_series_id DESC, r.gnl_game_no DESC, r.replay_id
LIMIT {limit:UInt32} OFFSET {offset:UInt32}
```
`{"limit": 25, "offset": 0}`
</details>

<details><summary>G02 no slots, map and minutes</summary>

```sql
SELECT r.replay_id AS replay_id, count() OVER () AS total
FROM w3g.replays AS r FINAL
WHERE type = '1on1'
  AND duration_ms >= {min_ms:UInt32}
  AND duration_ms <= {max_ms:UInt32}
  AND replay_id IN (SELECT replay_id FROM w3g.replay_map WHERE map = {map:String})
ORDER BY r.gnl_series_id DESC, r.gnl_game_no DESC, r.replay_id
LIMIT {limit:UInt32} OFFSET {offset:UInt32}
```
`{"limit": 25, "map": "Springtime 1.3", "max_ms": 600000, "min_ms": 300000, "offset": 0}`
</details>

<details><summary>G03 empty slot, race only</summary>

```sql
SELECT r.replay_id AS replay_id, min(p0.player_id) AS focus_player_id, count() OVER () AS total
FROM (
    SELECT replay_id, gnl_series_id, gnl_game_no, duration_ms, winning_team_id
    FROM w3g.replays FINAL
    WHERE type = '1on1'
) AS r
INNER JOIN (
    SELECT replay_id, player_id, team_id
    FROM w3g.replay_players FINAL
    WHERE race = {g0_race:String}
) AS p0 ON p0.replay_id = r.replay_id
GROUP BY r.replay_id, r.gnl_series_id, r.gnl_game_no, r.duration_ms
ORDER BY r.gnl_series_id DESC, r.gnl_game_no DESC, r.replay_id
LIMIT {limit:UInt32} OFFSET {offset:UInt32}
```
`{"g0_race": "N", "limit": 25, "offset": 0}`
</details>

<details><summary>G04 one step: no sequenceMatch</summary>

Request: `{"groups":[{"race":"N","steps":[{"event_type":"hero_trained","subject_code":"Edem"}]}]}`

```sql
SELECT r.replay_id AS replay_id, min(p0.player_id) AS focus_player_id, count() OVER () AS total
FROM (
    SELECT replay_id, gnl_series_id, gnl_game_no, duration_ms, winning_team_id
    FROM w3g.replays FINAL
    WHERE type = '1on1'
) AS r
INNER JOIN (
    SELECT replay_id, player_id, team_id
    FROM w3g.replay_players FINAL
    WHERE race = {g0_race:String}
      AND (replay_id, player_id) IN (
        SELECT replay_id, player_id
        FROM w3g.replay_events
        WHERE race = {g0_race:String}
          AND is_repeat = 0
          AND event_type = {g0_s0_type:String} AND subject_code = {g0_s0_code:String}
        GROUP BY replay_id, player_id)
) AS p0 ON p0.replay_id = r.replay_id
GROUP BY r.replay_id, r.gnl_series_id, r.gnl_game_no, r.duration_ms
ORDER BY r.gnl_series_id DESC, r.gnl_game_no DESC, r.replay_id
LIMIT {limit:UInt32} OFFSET {offset:UInt32}
```
`{"g0_race": "N", "g0_s0_code": "Edem", "g0_s0_type": "hero_trained", "limit": 25, "offset": 0}`
</details>

<details><summary>G05 one step with a window</summary>

Request: `{"groups":[{"race":"N","steps":[{"event_type":"building","subject_code":"eate","time_from_seconds":0,"time_to_seconds":15}]}]}`

The text equals G04, except the condition line reads:

```sql
          AND event_type = {g0_s0_type:String} AND subject_code = {g0_s0_code:String} AND time_ms >= {g0_s0_from:UInt32} AND time_ms <= {g0_s0_to:UInt32}
```
`{"g0_race": "N", "g0_s0_code": "eate", "g0_s0_from": 0, "g0_s0_to": 15000, "g0_s0_type": "building", "limit": 25, "offset": 0}`
</details>

<details><summary>G06 two steps, open gap</summary>

Request: `{"groups":[{"race":"N","steps":[{"event_type":"building","subject_code":"eate"},{"event_type":"building","subject_code":"eaom"}]}]}`

```sql
SELECT r.replay_id AS replay_id, min(p0.player_id) AS focus_player_id, count() OVER () AS total
FROM (
    SELECT replay_id, gnl_series_id, gnl_game_no, duration_ms, winning_team_id
    FROM w3g.replays FINAL
    WHERE type = '1on1'
) AS r
INNER JOIN (
    SELECT replay_id, player_id, team_id
    FROM w3g.replay_players FINAL
    WHERE race = {g0_race:String}
      AND (replay_id, player_id) IN (
        SELECT replay_id, player_id
        FROM (
            SELECT DISTINCT replay_id, player_id, time_ms, event_type, subject_code, seq
            FROM w3g.replay_events
            WHERE race = {g0_race:String}
              AND is_repeat = 0
              AND event_type IN {g0_types:Array(String)}
              AND subject_code IN {g0_codes:Array(String)})
        GROUP BY replay_id, player_id
        HAVING sequenceMatch({g0_pat:String})(
            time_ms,
            event_type = {g0_s0_type:String} AND subject_code = {g0_s0_code:String},
            event_type = {g0_s1_type:String} AND subject_code = {g0_s1_code:String}))
) AS p0 ON p0.replay_id = r.replay_id
GROUP BY r.replay_id, r.gnl_series_id, r.gnl_game_no, r.duration_ms
ORDER BY r.gnl_series_id DESC, r.gnl_game_no DESC, r.replay_id
LIMIT {limit:UInt32} OFFSET {offset:UInt32}
```
`{"g0_codes": ["eaom", "eate"], "g0_pat": "(?1).*(?2)", "g0_race": "N", "g0_s0_code": "eate", "g0_s0_type": "building", "g0_s1_code": "eaom", "g0_s1_type": "building", "g0_types": ["building"], "limit": 25, "offset": 0}`
</details>

<details><summary>G07 gated gap</summary>

Request: G06, plus `"within_previous_seconds": 60` on `eaom`.

The text equals G06, except the `HAVING` becomes:

```sql
        HAVING sequenceMatch({g0_pat:String})(
            time_ms,
            event_type = {g0_s0_type:String} AND subject_code = {g0_s0_code:String},
            event_type = {g0_s1_type:String} AND subject_code = {g0_s1_code:String})
          AND sequenceMatch({g0_s1_pat:String})(
            time_ms,
            event_type = {g0_s0_type:String} AND subject_code = {g0_s0_code:String},
            event_type = {g0_s1_type:String} AND subject_code = {g0_s1_code:String}))
```
`{"g0_codes": ["eaom", "eate"], "g0_pat": "(?1).*(?2)", "g0_race": "N", "g0_s0_code": "eate", "g0_s0_type": "building", "g0_s1_code": "eaom", "g0_s1_pat": "(?1)(?t<=60000)(?2)", "g0_s1_type": "building", "g0_types": ["building"], "limit": 25, "offset": 0}`

With two steps the gap aggregate carries the same two conditions as the ordering pattern, so the total stays 2,110.
</details>

<details><summary>G09 repeated step, G18 flagged code (text equals G06)</summary>

A repeated code never changes the text. Only the params differ.

- G09 (`emow` then `emow`; `DISTINCT` keeps it exact under an unmerged duplicate): `{"g0_codes": ["emow"], "g0_pat": "(?1).*(?2)", "g0_race": "N", "g0_s0_code": "emow", "g0_s0_type": "building", "g0_s1_code": "emow", "g0_s1_type": "building", "g0_types": ["building"], "limit": 25, "offset": 0}`
- G18 (race O, `ostr` then `ostr`; `is_repeat = 0` drops the sub-second re-click): `{"g0_codes": ["ostr"], "g0_pat": "(?1).*(?2)", "g0_race": "O", "g0_s0_code": "ostr", "g0_s0_type": "building", "g0_s1_code": "ostr", "g0_s1_type": "building", "g0_types": ["building"], "limit": 25, "offset": 0}`
</details>

<details><summary>G08 three steps, mixed gaps and kinds</summary>

Request: `{"groups":[{"race":"N","steps":[{"event_type":"building","subject_code":"eate"},{"event_type":"unit","subject_code":"ewsp","within_previous_seconds":30},{"event_type":"hero_trained","subject_code":"Edem"}]}]}`

The text equals G06, except the `HAVING` becomes:

```sql
        HAVING sequenceMatch({g0_pat:String})(
            time_ms,
            event_type = {g0_s0_type:String} AND subject_code = {g0_s0_code:String},
            event_type = {g0_s1_type:String} AND subject_code = {g0_s1_code:String},
            event_type = {g0_s2_type:String} AND subject_code = {g0_s2_code:String})
          AND sequenceMatch({g0_s1_pat:String})(
            time_ms,
            event_type = {g0_s0_type:String} AND subject_code = {g0_s0_code:String},
            event_type = {g0_s1_type:String} AND subject_code = {g0_s1_code:String}))
```
`{"g0_codes": ["Edem", "eate", "ewsp"], "g0_pat": "(?1).*(?2).*(?3)", "g0_race": "N", "g0_s0_code": "eate", "g0_s0_type": "building", "g0_s1_code": "ewsp", "g0_s1_pat": "(?1)(?t<=30000)(?2)", "g0_s1_type": "unit", "g0_s2_code": "Edem", "g0_s2_type": "hero_trained", "g0_types": ["building", "hero_trained", "unit"], "limit": 25, "offset": 0}`

Byte order: `Edem` sorts before `eate`.

The old one-pattern form `(?1)(?t<=30000)(?2).*(?3)` gave 1,499. An `Edem` order between the `eate` and the `ewsp` broke its gap, so 1,499 is a floor. PR 6 re-measures on the new shape.
</details>

<details><summary>G10 slot and opponent race</summary>

Request: `{"groups":[{"race":"N","steps":[{"event_type":"building","subject_code":"eate"},{"event_type":"building","subject_code":"eaom"}]},{"race":"O"}]}`

```sql
SELECT r.replay_id AS replay_id, min(p0.player_id) AS focus_player_id, count() OVER () AS total
FROM (
    SELECT replay_id, gnl_series_id, gnl_game_no, duration_ms, winning_team_id
    FROM w3g.replays FINAL
    WHERE type = '1on1'
) AS r
INNER JOIN (
    SELECT replay_id, player_id, team_id
    FROM w3g.replay_players FINAL
    WHERE race = {g0_race:String}
      AND (replay_id, player_id) IN (
        SELECT replay_id, player_id
        FROM (
            SELECT DISTINCT replay_id, player_id, time_ms, event_type, subject_code, seq
            FROM w3g.replay_events
            WHERE race = {g0_race:String}
              AND is_repeat = 0
              AND event_type IN {g0_types:Array(String)}
              AND subject_code IN {g0_codes:Array(String)})
        GROUP BY replay_id, player_id
        HAVING sequenceMatch({g0_pat:String})(
            time_ms,
            event_type = {g0_s0_type:String} AND subject_code = {g0_s0_code:String},
            event_type = {g0_s1_type:String} AND subject_code = {g0_s1_code:String}))
) AS p0 ON p0.replay_id = r.replay_id
INNER JOIN (
    SELECT replay_id, player_id, team_id
    FROM w3g.replay_players FINAL
    WHERE race = {g1_race:String}
) AS p1 ON p1.replay_id = r.replay_id
WHERE p1.team_id != p0.team_id
GROUP BY r.replay_id, r.gnl_series_id, r.gnl_game_no, r.duration_ms
ORDER BY r.gnl_series_id DESC, r.gnl_game_no DESC, r.replay_id
LIMIT {limit:UInt32} OFFSET {offset:UInt32}
```
`{"g0_codes": ["eaom", "eate"], "g0_pat": "(?1).*(?2)", "g0_race": "N", "g0_s0_code": "eate", "g0_s0_type": "building", "g0_s1_code": "eaom", "g0_s1_type": "building", "g0_types": ["building"], "g1_race": "O", "limit": 25, "offset": 0}`
</details>

<details><summary>G11 both slots with steps</summary>

Request: G10, but slot 1 is `{"race":"O","steps":[{"event_type":"building","subject_code":"oalt"}]}`. The text equals G10, except the `p1` block reads:

```sql
INNER JOIN (
    SELECT replay_id, player_id, team_id
    FROM w3g.replay_players FINAL
    WHERE race = {g1_race:String}
      AND (replay_id, player_id) IN (
        SELECT replay_id, player_id
        FROM w3g.replay_events
        WHERE race = {g1_race:String}
          AND is_repeat = 0
          AND event_type = {g1_s0_type:String} AND subject_code = {g1_s0_code:String}
        GROUP BY replay_id, player_id)
) AS p1 ON p1.replay_id = r.replay_id
```
`{"g0_codes": ["eaom", "eate"], "g0_pat": "(?1).*(?2)", "g0_race": "N", "g0_s0_code": "eate", "g0_s0_type": "building", "g0_s1_code": "eaom", "g0_s1_type": "building", "g0_types": ["building"], "g1_race": "O", "g1_s0_code": "oalt", "g1_s0_type": "building", "limit": 25, "offset": 0}`
</details>

<details><summary>G12 mirror</summary>

Request: `{"groups":[{"race":"N","steps":[{"event_type":"building","subject_code":"eate"}]},{"race":"N","steps":[{"event_type":"building","subject_code":"eate"}]}]}`

The text equals G11, except the `p0` block is the G04 `p0` block (the 1-step slot set, lines `INNER JOIN (` to `) AS p0 ON p0.replay_id = r.replay_id`).

`{"g0_race": "N", "g0_s0_code": "eate", "g0_s0_type": "building", "g1_race": "N", "g1_s0_code": "eate", "g1_s0_type": "building", "limit": 25, "offset": 0}`

Every row has `focus_player_id = 1`: both players fit (§4 rule 12).
</details>

<details><summary>G13 player bind and won</summary>

Request: `{"groups":[{"race":"N","player":"medusa#31315","result":"won","steps":[{"event_type":"hero_trained","subject_code":"Edem"}]}]}`

```sql
SELECT r.replay_id AS replay_id, min(p0.player_id) AS focus_player_id, count() OVER () AS total
FROM (
    SELECT replay_id, gnl_series_id, gnl_game_no, duration_ms, winning_team_id
    FROM w3g.replays FINAL
    WHERE type = '1on1'
      AND winning_team_id >= 0
) AS r
INNER JOIN (
    SELECT replay_id, player_id, team_id
    FROM w3g.replay_players FINAL
    WHERE race = {g0_race:String}
      AND lowerUTF8(name) = lowerUTF8({g0_player:String})
      AND (replay_id, player_id) IN (
        SELECT replay_id, player_id
        FROM w3g.replay_events
        WHERE race = {g0_race:String}
          AND is_repeat = 0
          AND event_type = {g0_s0_type:String} AND subject_code = {g0_s0_code:String}
        GROUP BY replay_id, player_id)
) AS p0 ON p0.replay_id = r.replay_id
WHERE r.winning_team_id = p0.team_id
GROUP BY r.replay_id, r.gnl_series_id, r.gnl_game_no, r.duration_ms
ORDER BY r.gnl_series_id DESC, r.gnl_game_no DESC, r.replay_id
LIMIT {limit:UInt32} OFFSET {offset:UInt32}
```
`{"g0_player": "medusa#31315", "g0_race": "N", "g0_s0_code": "Edem", "g0_s0_type": "hero_trained", "limit": 25, "offset": 0}`

Result: `0ddb…` and `9233…`, the two Medusa#31315 fixture games; the lower-case input matched.
</details>

<details><summary>G14 lost on slot 1</summary>

Request: `{"groups":[{"race":"N","steps":[{"event_type":"building","subject_code":"eate"}]},{"race":"O","result":"lost"}]}`

```sql
SELECT r.replay_id AS replay_id, min(p0.player_id) AS focus_player_id, count() OVER () AS total
FROM (
    SELECT replay_id, gnl_series_id, gnl_game_no, duration_ms, winning_team_id
    FROM w3g.replays FINAL
    WHERE type = '1on1'
      AND winning_team_id >= 0
) AS r
INNER JOIN (
    SELECT replay_id, player_id, team_id
    FROM w3g.replay_players FINAL
    WHERE race = {g0_race:String}
      AND (replay_id, player_id) IN (
        SELECT replay_id, player_id
        FROM w3g.replay_events
        WHERE race = {g0_race:String}
          AND is_repeat = 0
          AND event_type = {g0_s0_type:String} AND subject_code = {g0_s0_code:String}
        GROUP BY replay_id, player_id)
) AS p0 ON p0.replay_id = r.replay_id
INNER JOIN (
    SELECT replay_id, player_id, team_id
    FROM w3g.replay_players FINAL
    WHERE race = {g1_race:String}
) AS p1 ON p1.replay_id = r.replay_id
WHERE r.winning_team_id != p1.team_id
  AND p1.team_id != p0.team_id
GROUP BY r.replay_id, r.gnl_series_id, r.gnl_game_no, r.duration_ms
ORDER BY r.gnl_series_id DESC, r.gnl_game_no DESC, r.replay_id
LIMIT {limit:UInt32} OFFSET {offset:UInt32}
```
`{"g0_race": "N", "g0_s0_code": "eate", "g0_s0_type": "building", "g1_race": "O", "limit": 25, "offset": 0}`
</details>

<details><summary>G15 Random slot</summary>

Request: `{"groups":[{"race":"N","steps":[{"event_type":"building","subject_code":"eate"}]},{"race":"R"}]}`

The text equals G14 without its two `winning_team_id` lines: the `r` block loses `      AND winning_team_id >= 0`, and the outer `WHERE` is the single line `WHERE p1.team_id != p0.team_id`. `R` needs no branch, because no rule reads `matchup`.

`{"g0_race": "N", "g0_s0_code": "eate", "g0_s0_type": "building", "g1_race": "R", "limit": 25, "offset": 0}`
</details>

<details><summary>G16 steps with no race</summary>

Request: `{"groups":[{"steps":[{"event_type":"building","subject_code":"eate"},{"event_type":"building","subject_code":"eaom"}]}]}`

```sql
SELECT r.replay_id AS replay_id, min(p0.player_id) AS focus_player_id, count() OVER () AS total
FROM (
    SELECT replay_id, gnl_series_id, gnl_game_no, duration_ms, winning_team_id
    FROM w3g.replays FINAL
    WHERE type = '1on1'
) AS r
INNER JOIN (
    SELECT replay_id, player_id, team_id
    FROM w3g.replay_players FINAL
    WHERE (replay_id, player_id) IN (
        SELECT replay_id, player_id
        FROM (
            SELECT DISTINCT replay_id, player_id, time_ms, event_type, subject_code, seq
            FROM w3g.replay_events
            WHERE is_repeat = 0
              AND event_type IN {g0_types:Array(String)}
              AND subject_code IN {g0_codes:Array(String)})
        GROUP BY replay_id, player_id
        HAVING sequenceMatch({g0_pat:String})(
            time_ms,
            event_type = {g0_s0_type:String} AND subject_code = {g0_s0_code:String},
            event_type = {g0_s1_type:String} AND subject_code = {g0_s1_code:String}))
) AS p0 ON p0.replay_id = r.replay_id
GROUP BY r.replay_id, r.gnl_series_id, r.gnl_game_no, r.duration_ms
ORDER BY r.gnl_series_id DESC, r.gnl_game_no DESC, r.replay_id
LIMIT {limit:UInt32} OFFSET {offset:UInt32}
```
`{"g0_codes": ["eaom", "eate"], "g0_pat": "(?1).*(?2)", "g0_s0_code": "eate", "g0_s0_type": "building", "g0_s1_code": "eaom", "g0_s1_type": "building", "g0_types": ["building"], "limit": 25, "offset": 0}`

The 2,439 total is from a run before `DISTINCT`. `DISTINCT` changes no total while the table has no duplicates (§1).
</details>

<details><summary>G17 paging</summary>

Query `?limit=2&offset=1`, body `{}`. The text equals G01. `{"limit": 2, "offset": 1}`
</details>

Goldens for the other builders (SQL from §3 with these params):

| # | Builder | Params | Measured |
|---|---|---|---|
| O1 | 3.5, depth 0, popular | `{"after": 2, "next": 1, "race": "N"}` | 4 rows; `eate` 2,503 games, 5 branches |
| O2 | 3.5, `prefix`, winrate | `{"after": 4, "depth": 2, "next": 3, "prefix": ["eate", "eaom"], "race": "N"}` | 6 rows, incl. `['', 59, 18, 3.8, 0]` (`stopped`) |
| O3 | 3.5, player | `{"after": 2, "next": 1, "player": "MEDUSA#31315", "race": "N"}` | 1 row, `eate`, 2 games |
| O4 | 3.5, depth 5 | `{"after": 7, "depth": 5, "next": 6, "prefix": ["eate", "eaom", "etoa", "edob", "eden"], "race": "N"}` | 8 rows, all `branches = 0` |
| R1 | 3.6 | `{"depth": 3, "limit": 25, "offset": 0, "prefix": ["eate", "eaom", "eden"], "race": "N"}` | 816 player-games (794 replays), equal to the `eden` tree row |
| T1-T4 | 3.7, opponent block | `{"opponent_race": "O", "player": "medusa#31315", "race": "N"}` | durations `[[0,0],[1,1]]`; matchups `N-O 1/1/1`, `O-N 1/1/0`; totals `N 1`, `O 1` (`is_total = 1`); `Edem`, `Ekee`, `Oshd`, `Obla` 1 each |
| T5 | 3.7 heroes, no filter | `{}` | one `code = ''` row per race, each `is_total = 1` (a real `hero_id = ''` must not appear) |
| H1 | 3.4 hydrate | `{"ids": ["dcd3…", "0ddb…"]}` (full ids) | 2 rows, input order |
| D1-D4 | 3.8 | `{"id": "dcd39e47097a4a010bc4006e0bf521e3726a0b8e9284cc0b8e2fb74411fbfef8"}` | header 1 row; 2 players; 150 events (152 raw minus 2 flagged); 3 chat lines (0 `Private`, 0 `retraining`) |
| D5 | 3.8 events, a retrain | any `replay_id` from `hero_ability_events WHERE event_type = 'retraining'` | no `code = ''`; the retrain is `hero_retrained` with the hero code |
| E1 | §4.2 equal timestamps | every player-game with `hero_trained Edem`: step 1 `hero_trained Edem`, step 2 its first `hero_skill`, `(?1).*(?2)` | 1,605 of 1,605 match (full load, 26.9) |
| F1 | §9 flag | full load, `sum(is_repeat)` per class after PR 2 | hero 11,429, tier 4,392, research 3,651 (19,472 total; 26.9 window emulation) |

## 8. Settled questions

Numbers kept so other documents' links hold.

1. Dev data: the 6,567-replay load of the header. Debug only; the org deploy holds only app-reported GNL replays. PR 1b battle-tests the same set through the real drain path (§5).
2. Equal timestamps: plain `time_ms`, pinned by golden E1 (C5).
3. `gnl_series_id = 0` everywhere: the list keeps its fixed order; the PR 3 re-stage adds a play date if the drain can read the upload time.
4. S1 key: as proposed.
5. Random: `H O N U R` are the storage values and every race param here takes a letter; the wire ids are the GNL ids `HU OC NE UD RANDOM`, mapped to the letters at the Rust API boundary (3.7). `R` is a fifth race, and filters read `race`, not `race_detected`.
6. 71 replays with no events: PR 1 checks whether they are LAN games hit by the w3grs post-2.0.2 action-id shift (the calibration saw w3grs return 0 orders on a LAN game vs the AI). Until then they show in no-slot search and stats, never in step search or openers.
7. `max_rows_to_read`: profile limits are measured after PR 2 (about 10× the largest route read).
8. `kind != 'unknown'` stays in SQL (3.8).
9. The 68 `hero_id = ''` rows are dropped in reads.
10. S2 refresh peak: re-measured in PR 2.

## 9. Orders are commands

Replays record COMMANDS, not outcomes. A re-click adds an order, so repeats double-count. Every UI label reads "ordered", and the count form counts orders ("at least 5 Archer orders by 5:00"). Counts of finished objects need stat-events, which wait.

### 9.1 Measured on the full load

Server 26.9, `player_order_events FINAL`, 6,567 replays. A repeat is a same-code order by the same player after an earlier one; the gap is from the previous same-code order. Classes: hero = `unknown` rows with a `mappings` `kind = 'hero'` code; tier = the 8 tier-hall codes; research = codes starting with `R`.

| Class | Orders | Repeats | 0 ms | 1-249 ms | 250-999 ms | 1-5 s | ≥ 5 s | Under 1 s |
|---|---|---|---|---|---|---|---|---|
| unit | 403,805 | 346,701 | 1,264 | 72,227 | 9,282 | 10,972 | 252,956 | 23.9% |
| building (not tier) | 207,893 | 111,418 | 43 | 1,884 | 6,015 | 13,816 | 89,660 | 7.1% |
| item | 101,708 | 46,590 | 87 | 4,725 | 726 | 2,566 | 38,486 | 11.9% |
| research | 57,822 | 14,539 | 88 | 3,541 | 22 | 267 | 10,621 | 25.1% |
| hero | 38,175 | 11,649 | 509 | 10,900 | 20 | 28 | 192 | 98.1% |
| tier | 24,722 | 4,714 | 138 | 4,233 | 21 | 9 | 313 | 93.2% |
| other unknown | 2,525 | 701 | 0 | 61 | 1 | 21 | 618 | 8.8% |

- Hero and tier repeats sit almost all under 1 s. The largest flagged hero gap is 449 ms.
- For hero, tier and research, the 250-999 ms band is nearly empty (20, 21, 22). The 1000 ms cut sits in a gap.
- Research repeats of ≥ 5 s are real later levels (one code serves levels 1-3). The rule keeps them.
- Farms, towers and unit queues repeat across every gap. No time rule separates re-clicks from real orders there.

Tier codes (repeats under 1 s of all repeats): `etoa` 483/548, `etoe` 229/273, `hcas` 246/260, `hkee` 797/832, `ofrt` 389/431, `ostr` 1,052/1,071, `unp1` 739/794, `unp2` 457/505.

Where the codes sit (w3grs buckets): tier codes in `building`; research in `upgrade` (all 57,470 rows start with `R`) plus 352 `Rhsb` rows in `unknown`; hero training in `unknown` via `mv__order_unknown` (38,175 rows, 24 codes). So the rule uses the code list, not the kind. Order arrays are time-sorted: 0 of 836,650 rows have a smaller `time_ms` than the previous `seq` of the same `(replay_id, player_id, kind)`.

### 9.2 Calibration

Report: `docs/design/order-calibration.md`. Truth: stat-events of 3 short LAN test games (5.5-7 min, v2.00 build 6117).

| Class | Truth starts | Raw orders | With the rule | Result |
|---|---|---|---|---|
| hero | 8 | 14 | 8 | exact (6 surplus clicks, all < 190 ms) |
| tier | 8 | 8 | 8 | unchanged |
| research | 2 | 2 | 2 | unchanged (too few to be evidence) |
| building | 52 | 58 | 58 (raw) | no time rule beats raw (best: 500 ms, abs err 6 → 5) |
| unit | 86 | 98 | 98 (raw) | a 250 ms collapse also removes 3 real queued units; raw is a one-sided upper bound |

- Use the FIRST order time. All 17 single-instance first orders are 113-1637 ms before the logged start, within the 1 s clock resolution plus drift.
- A 4th game (vs the AI, LAN) failed: w3grs returned 0 unit, research, tier and hero orders (§8 item 6).

### 9.3 The rule

Decided: flag, never delete, an order when all hold:
- its code is single-instance: a tier hall (`hkee`, `hcas`, `ostr`, `ofrt`, `unp1`, `unp2`, `etoa`, `etoe`), research (code starts with `R`), or hero training (`mappings.kind = 'hero'`: `Edem Ekee Emoo Ewar Hamg Hblm Hmkg Hpal Nalc Nbrn Nbst Nfir Nngs Npbm Nplh Ntin Obla Ofar Oshd Otch Ucrl Udea Udre Ulic`);
- the same player ordered the same code earlier in the same replay;
- the previous same-code order is less than 1000 ms before it.

Buildings, units and items stay raw. The first order of a burst keeps `is_repeat = 0`, so its time counts. The gap runs from the previous raw order, so a chain of sub-second clicks flags all but the first.

### 9.4 Load (PR 2)

Columns (`schema-types-minimize-bitwidth`, `schema-types-avoid-nullable`): `is_repeat UInt8 DEFAULT 0` after `seq` in `player_order_events` (tables.sql:113) and in `replay_events` (tables.sql:209). Neither key changes. Set at insert, never by `ALTER … UPDATE` (`insert-mutation-avoid-update`).

One doc is one `replays_raw` row, so the flag is computed per doc, from each player's order array for one bucket. `mv__order_building` becomes:

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.mv__order_building
TO w3g.player_order_events AS
WITH ['hkee', 'hcas', 'ostr', 'ofrt', 'unp1', 'unp2', 'etoa', 'etoe'] AS tier_codes,
     (SELECT groupArray(code) FROM w3g.mappings WHERE kind = 'hero') AS hero_codes
SELECT
    r.replay_id                                  AS replay_id,
    JSONExtractUInt(p, 'id')                     AS player_id,
    'building'                                   AS kind,
    JSONExtractString(o, 'id')                   AS object_code,
    JSONExtractUInt(o, 'ms')                     AS time_ms,
    o_idx                                        AS seq,
    o_rep                                        AS is_repeat,
    JSONExtractString(p, 'race')                 AS race,
    JSONExtractString(r.doc, 'matchup')          AS matchup,
    r.ingested_at                                AS ingested_at
FROM w3g.replays_raw AS r
ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
ARRAY JOIN
    JSONExtractArrayRaw(JSONExtractRaw(p, 'buildings'), 'order')                AS o,
    arrayEnumerate(JSONExtractArrayRaw(JSONExtractRaw(p, 'buildings'), 'order')) AS o_idx,
    arrayMap((c, t, i) -> toUInt8(
            (has(tier_codes, c) OR startsWith(c, 'R') OR has(hero_codes, c))
            AND arrayExists((c2, t2, j) -> j < i AND c2 = c AND t - t2 < 1000, codes, ts, arrayEnumerate(codes))),
        arrayMap(x -> JSONExtractString(x, 'id'), JSONExtractArrayRaw(JSONExtractRaw(p, 'buildings'), 'order')) AS codes,
        arrayMap(x -> toUInt32(JSONExtractUInt(x, 'ms')), JSONExtractArrayRaw(JSONExtractRaw(p, 'buildings'), 'order')) AS ts,
        arrayEnumerate(codes))                                                  AS o_rep;
```

- `mv__order_upgrade` and `mv__order_unknown` take the same `WITH` and `is_repeat` lines, with `'upgrades'` and `'unknown'` for `'buildings'`. `mv__order_unit` and `mv__order_item` are unchanged; their rows take `DEFAULT 0`.
- `arrayExists` over an earlier same-code order within 1000 ms equals "gap to the previous same-code order < 1000 ms", because the arrays are time-sorted (9.1). Cost is O(n²) per player bucket.
- `hero_codes` reads `mappings`, which `just local::mappings` (or `box::mappings`) loads before any backfill (`mv_events__order` already joins it). The subquery runs at each insert, not at CREATE; the PR 2 hero-flag golden runs through the real rebuild order (`schema`, `mappings`, `load`), not clickhouse-local, and proves it.
- `mv_events__order` (views.sql:358-378) adds `e.is_repeat AS is_repeat`. The hero MVs write `DEFAULT 0`: `hero_trained` comes from ability events, not orders.
- Checked (26.9, `clickhouse local`, the 6,564 `data/parsed/gnl/` docs through these MVs): 19,467 flags (building 4,390, upgrade 3,633, unknown 11,444). A window-function recount of the rule gives 0 mismatches. F1's 19,472 adds the 5 flags of the 3 fixtures (server, 26.9, re-read 2026-09-11). An `arrayLastIndex(…) AS k` alias inside the lambda gave wrong flags (9,805 mismatches), so do not use it. PR 2 re-runs this check on 26.8.

### 9.5 How each route skips flagged rows

| Route or form | Change | Effect on the full load (emulated, 26.9) |
|---|---|---|
| `POST /search` (§4 rules 3-4) | `AND is_repeat = 0` in every slot `WHERE` | G01-G17 unchanged; G18 693 → 17 |
| `GET /openers`, `/openers/replays` (S2) | `AND is_repeat = 0` in the refresh body | 0 of 12,881 `seq` arrays change |
| D4 count form (4.3) | counts rows with `is_repeat = 0` | – |
| `GET /stats` (3.7) | none: reads no order rows | – |
| `GET /replays/{id}` timeline (3.8) | `AND is_repeat = 0` on the `player_order_events` branch | `dcd3…`: 152 → 150 events |
