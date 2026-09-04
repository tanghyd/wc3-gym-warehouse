-- db/w3g/views.sql — all materialized views for the w3g database.
--
-- Applied after tables.sql on each pipeline run.
--
-- Contents:
--   - Load-time fan-out from replays_raw → projected tables (mv__replays,
--     mv__replay_players, mv__player_heroes, mv__player_group_hotkeys).
--   - Load-time link from replay_listings_raw → replay_listings.
--   - Event-stream MVs that populate the denormalized replay_events mart
--     (mv_events__order, mv_events__hero, mv_events__hero_trained).
--   - refresh__opener_rollup — refreshable MV that atomically rebuilds the
--     opener_rollup table; driven by scripts/pipeline.sh's explicit SYSTEM REFRESH.

CREATE DATABASE IF NOT EXISTS w3g;

-- ---------- Load-time fan-out from replays_raw ----------

CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.mv__replays
TO w3g.replays AS
SELECT
    r.replay_id                                                              AS replay_id,
    JSONExtractString(r.doc, 'map')                                          AS map_json,
    JSONExtractString(r.doc, 'gamename')                                     AS gamename,
    JSONExtractString(r.doc, 'creator')                                      AS creator,
    JSONExtractString(r.doc, 'type')                                         AS type,
    JSONExtractString(r.doc, 'matchup')                                      AS matchup,
    JSONExtractUInt(r.doc, 'duration')                                       AS duration_ms,
    JSONExtractUInt(r.doc, 'buildNumber')                                    AS build_number,
    JSONExtractString(r.doc, 'version')                                      AS version,
    JSONExtractBool(r.doc, 'expansion')                                      AS expansion,
    JSONExtractUInt(r.doc, 'parseTime')                                      AS parse_time_ms,
    coalesce(JSONExtract(r.doc, 'winningTeamId', 'Nullable(Int8)'), -1)      AS winning_team_id,
    JSONExtractInt(r.doc, 'randomseed')                                      AS random_seed,
    JSONExtractUInt(r.doc, 'startSpots')                                     AS start_spots,
    JSONExtract(r.doc, 'observers', 'Array(String)')                         AS observers,
    JSONExtractUInt(r.doc, 'settings', 'speed')                              AS speed,
    JSONExtractBool(r.doc, 'settings', 'fixedTeams')                         AS fixed_teams,
    JSONExtractBool(r.doc, 'settings', 'teamsTogether')                      AS teams_together,
    JSONExtractBool(r.doc, 'settings', 'fullSharedUnitControl')              AS full_shared_unit_control,
    JSONExtractBool(r.doc, 'settings', 'alwaysVisible')                      AS always_visible,
    JSONExtractBool(r.doc, 'settings', 'mapExplored')                        AS map_explored,
    JSONExtractBool(r.doc, 'settings', 'referees')                           AS referees,
    JSONExtractString(r.doc, 'settings', 'observerMode')                     AS observer_mode,
    JSONExtractBool(r.doc, 'settings', 'randomHero')                         AS random_hero,
    JSONExtractBool(r.doc, 'settings', 'randomRaces')                        AS random_races,
    JSONExtractBool(r.doc, 'settings', 'hideTerrain')                        AS hide_terrain,
    r.ingested_at                                                            AS ingested_at
FROM w3g.replays_raw AS r;

CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.mv__replay_players
TO w3g.replay_players AS
SELECT
    r.replay_id                                                              AS replay_id,
    JSONExtractUInt(p, 'id')                                                 AS player_id,
    JSONExtractString(p, 'name')                                             AS name,
    JSONExtractString(p, 'color')                                            AS color,
    coalesce(JSONExtract(p, 'teamid', 'Nullable(Int8)'), -1)                 AS team_id,
    JSONExtractString(p, 'race')                                             AS race,
    JSONExtractString(p, 'raceDetected')                                     AS race_detected,
    JSONExtractUInt(p, 'apm')                                                AS apm,
    JSONExtractUInt(p, 'actions', 'rightclick')                              AS actions_rightclick,
    JSONExtractUInt(p, 'actions', 'basic')                                   AS actions_basic,
    JSONExtractUInt(p, 'actions', 'buildtrain')                              AS actions_buildtrain,
    JSONExtractUInt(p, 'actions', 'ability')                                 AS actions_ability,
    JSONExtractUInt(p, 'actions', 'item')                                    AS actions_item,
    JSONExtractUInt(p, 'actions', 'select')                                  AS actions_select,
    JSONExtractUInt(p, 'actions', 'removeunit')                              AS actions_removeunit,
    JSONExtractUInt(p, 'actions', 'subgroup')                                AS actions_subgroup,
    JSONExtractUInt(p, 'actions', 'selecthotkey')                            AS actions_selecthotkey,
    JSONExtractUInt(p, 'actions', 'assigngroup')                             AS actions_assigngroup,
    JSONExtractUInt(p, 'actions', 'esc')                                     AS actions_esc,
    JSONExtract(p, 'actions', 'timed', 'Array(UInt32)')                      AS apm_timed,
    r.ingested_at                                                            AS ingested_at
FROM w3g.replays_raw AS r
ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p;

-- Two parallel ARRAY JOINs (heroes + arrayEnumerate) zip the array with
-- its 1-based index; hero_slot is the 0-based version.
CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.mv__player_heroes
TO w3g.player_heroes AS
SELECT
    r.replay_id                                                              AS replay_id,
    JSONExtractUInt(p, 'id')                                                 AS player_id,
    toUInt8(h_idx - 1)                                                       AS hero_slot,
    JSONExtractString(h, 'id')                                               AS hero_id,
    JSONExtractUInt(h, 'level')                                              AS final_level,
    r.ingested_at                                                            AS ingested_at
FROM w3g.replays_raw AS r
ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
ARRAY JOIN
    JSONExtractArrayRaw(p, 'heroes')                AS h,
    arrayEnumerate(JSONExtractArrayRaw(p, 'heroes')) AS h_idx;

-- kv.1 is the group_key (0-9 as string), kv.2 the JSON sub-doc.
CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.mv__player_group_hotkeys
TO w3g.player_group_hotkeys AS
SELECT
    r.replay_id                                                              AS replay_id,
    JSONExtractUInt(p, 'id')                                                 AS player_id,
    toUInt8(kv.1)                                                            AS group_key,
    JSONExtractUInt(kv.2, 'assigned')                                        AS assigned,
    JSONExtractUInt(kv.2, 'used')                                            AS used,
    r.ingested_at                                                            AS ingested_at
FROM w3g.replays_raw AS r
ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
ARRAY JOIN JSONExtractKeysAndValuesRaw(JSONExtractRaw(p, 'groupHotkeys')) AS kv;

-- replay_listings' authoritative source is the warcraft3.info sidecar
-- (api_id, map_id, the registry map_name/short) projected by explicit
-- file()-reading INSERTs in load_listings.sql. But sidecars only exist for
-- the warcraft3.info batch path — the S3Queue stream lands parsed replay docs
-- with no sidecar, so on a stream-only stack replay_listings stayed empty and
-- the Map dropdown + map filter (both read replay_listings.map_name) showed
-- nothing. This MV derives a fallback map_name from the map filename carried in
-- every replay doc, so the map filter works whenever replays exist (same
-- invariant the Players filter relies on). ReplacingMergeTree(ingested_at) lets
-- the later sidecar load (now() > the replay's ingested_at) supersede this
-- derived row with the registry name where a sidecar is present — reads see the
-- latest via replay_listings_dedup below; no OPTIMIZE … FINAL involved.
CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.mv__replay_listings
TO w3g.replay_listings AS
SELECT
    replay_id                                                                AS replay_id,
    0                                                                        AS api_id,
    0                                                                        AS map_id,
    0                                                                        AS map_alias_id,
    -- "Springtime_v1.3" -> "Springtime 1.3", "AutumnLeaves" -> "Autumn Leaves":
    -- _v<n> -> " <n>", then split camelCase, then remaining _ -> space.
    replaceRegexpAll(
        replaceRegexpAll(
            replaceRegexpOne(raw_name, '_v([0-9])', ' \\1'),
        '([a-z0-9])([A-Z])', '\\1 \\2'),
    '_', ' ')                                                                AS map_name,
    ''                                                                       AS map_short,
    ingested_at                                                              AS ingested_at
FROM (
    SELECT
        r.replay_id                                                          AS replay_id,
        r.ingested_at                                                        AS ingested_at,
        -- strip extension, then pull the map-name segment out of the w3c
        -- filename. Two layouts seen: "[<id>_]w3c_<date>_<time>_<NAME>" and
        -- "1v1_<NAME>_w3c_<date>_<time>_<id>"; non-w3c names pass through whole.
        replaceRegexpOne(JSONExtractString(r.doc, 'map', 'file'), '\\.(w3x|w3m|w3g)$', '') AS stem,
        multiIf(
            match(stem, '_w3c_[0-9]{6}_[0-9]{4}_[0-9]+$'),
                extract(stem, '^(?:1v1_)?(.+?)_w3c_[0-9]{6}_[0-9]{4}_[0-9]+$'),
            match(stem, '^(?:[0-9]+_)?w3c_[0-9]{6}_[0-9]{4}_'),
                extract(stem, '^(?:[0-9]+_)?w3c_[0-9]{6}_[0-9]{4}_(.+)$'),
            stem
        )                                                                    AS raw_name
    FROM w3g.replays_raw AS r
    WHERE JSONExtractString(r.doc, 'type') = '1on1'
      AND JSONExtractString(r.doc, 'map', 'file') != ''
);

-- ---------- Event-source fan-out from replays_raw ----------
--
-- These move the per-event ARRAY JOIN extraction out of load.sql and into MVs,
-- so a single INSERT into replays_raw (batch load OR S3Queue stream) cascades
-- all the way to replay_events with no orchestration. Each stamps the cohort
-- (race from the per-player doc field, matchup from the doc) so the downstream
-- replay_events fan-out needs no header JOIN — see player_order_events.
--
-- The four order kinds are separate MVs (one ARRAY JOIN each) rather than a
-- single UNION ALL view: an MV whose body references the source table more than
-- once has surprising trigger semantics, so we keep one source reference per MV.
-- `seq` is per (replay_id, player_id, kind), and kind is in the table sort key,
-- so seq=1 of different kinds don't collide.

CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.mv__order_building
TO w3g.player_order_events AS
SELECT
    r.replay_id                                  AS replay_id,
    JSONExtractUInt(p, 'id')                     AS player_id,
    'building'                                   AS kind,
    JSONExtractString(o, 'id')                   AS object_code,
    JSONExtractUInt(o, 'ms')                     AS time_ms,
    o_idx                                        AS seq,
    JSONExtractString(p, 'race')                 AS race,
    JSONExtractString(r.doc, 'matchup')          AS matchup,
    r.ingested_at                                AS ingested_at
FROM w3g.replays_raw AS r
ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
ARRAY JOIN
    JSONExtractArrayRaw(JSONExtractRaw(p, 'buildings'), 'order')                AS o,
    arrayEnumerate(JSONExtractArrayRaw(JSONExtractRaw(p, 'buildings'), 'order')) AS o_idx;

CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.mv__order_unit
TO w3g.player_order_events AS
SELECT
    r.replay_id                                  AS replay_id,
    JSONExtractUInt(p, 'id')                     AS player_id,
    'unit'                                       AS kind,
    JSONExtractString(o, 'id')                   AS object_code,
    JSONExtractUInt(o, 'ms')                     AS time_ms,
    o_idx                                        AS seq,
    JSONExtractString(p, 'race')                 AS race,
    JSONExtractString(r.doc, 'matchup')          AS matchup,
    r.ingested_at                                AS ingested_at
FROM w3g.replays_raw AS r
ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
ARRAY JOIN
    JSONExtractArrayRaw(JSONExtractRaw(p, 'units'), 'order')                AS o,
    arrayEnumerate(JSONExtractArrayRaw(JSONExtractRaw(p, 'units'), 'order')) AS o_idx;

CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.mv__order_item
TO w3g.player_order_events AS
SELECT
    r.replay_id                                  AS replay_id,
    JSONExtractUInt(p, 'id')                     AS player_id,
    'item'                                       AS kind,
    JSONExtractString(o, 'id')                   AS object_code,
    JSONExtractUInt(o, 'ms')                     AS time_ms,
    o_idx                                        AS seq,
    JSONExtractString(p, 'race')                 AS race,
    JSONExtractString(r.doc, 'matchup')          AS matchup,
    r.ingested_at                                AS ingested_at
FROM w3g.replays_raw AS r
ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
ARRAY JOIN
    JSONExtractArrayRaw(JSONExtractRaw(p, 'items'), 'order')                AS o,
    arrayEnumerate(JSONExtractArrayRaw(JSONExtractRaw(p, 'items'), 'order')) AS o_idx;

CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.mv__order_upgrade
TO w3g.player_order_events AS
SELECT
    r.replay_id                                  AS replay_id,
    JSONExtractUInt(p, 'id')                     AS player_id,
    'upgrade'                                    AS kind,
    JSONExtractString(o, 'id')                   AS object_code,
    JSONExtractUInt(o, 'ms')                     AS time_ms,
    o_idx                                        AS seq,
    JSONExtractString(p, 'race')                 AS race,
    JSONExtractString(r.doc, 'matchup')          AS matchup,
    r.ingested_at                                AS ingested_at
FROM w3g.replays_raw AS r
ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
ARRAY JOIN
    JSONExtractArrayRaw(JSONExtractRaw(p, 'upgrades'), 'order')                AS o,
    arrayEnumerate(JSONExtractArrayRaw(JSONExtractRaw(p, 'upgrades'), 'order')) AS o_idx;

-- The parser's unknown bucket (custom-map rawcodes; players[].unknown is
-- omitted entirely for replays without any, so the ARRAY JOIN fans out to
-- zero rows there — same shape as the four melee kinds above).
CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.mv__order_unknown
TO w3g.player_order_events AS
SELECT
    r.replay_id                                  AS replay_id,
    JSONExtractUInt(p, 'id')                     AS player_id,
    'unknown'                                    AS kind,
    JSONExtractString(o, 'id')                   AS object_code,
    JSONExtractUInt(o, 'ms')                     AS time_ms,
    o_idx                                        AS seq,
    JSONExtractString(p, 'race')                 AS race,
    JSONExtractString(r.doc, 'matchup')          AS matchup,
    r.ingested_at                                AS ingested_at
FROM w3g.replays_raw AS r
ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
ARRAY JOIN
    JSONExtractArrayRaw(JSONExtractRaw(p, 'unknown'), 'order')                AS o,
    arrayEnumerate(JSONExtractArrayRaw(JSONExtractRaw(p, 'unknown'), 'order')) AS o_idx;

-- ev.value is sometimes a string (ability code) and sometimes a number;
-- trim quotes from JSONExtractRaw to flatten both cases.
CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.mv__hero_ability_events
TO w3g.hero_ability_events AS
SELECT
    r.replay_id                                  AS replay_id,
    JSONExtractUInt(p, 'id')                     AS player_id,
    toUInt8(h_idx - 1)                           AS hero_slot,
    JSONExtractString(h, 'id')                   AS hero_id,
    JSONExtractString(ev, 'type')                AS event_type,
    trim(BOTH '"' FROM JSONExtractRaw(ev, 'value')) AS ability_id,
    JSONExtractUInt(ev, 'time')                  AS time_ms,
    ev_idx                                       AS seq,
    JSONExtractString(p, 'race')                 AS race,
    JSONExtractString(r.doc, 'matchup')          AS matchup,
    r.ingested_at                                AS ingested_at
FROM w3g.replays_raw AS r
ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
ARRAY JOIN
    JSONExtractArrayRaw(p, 'heroes')                AS h,
    arrayEnumerate(JSONExtractArrayRaw(p, 'heroes')) AS h_idx
ARRAY JOIN
    JSONExtractArrayRaw(h, 'abilityOrder')                AS ev,
    arrayEnumerate(JSONExtractArrayRaw(h, 'abilityOrder')) AS ev_idx;

CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.mv__chat
TO w3g.chat AS
SELECT
    r.replay_id                                  AS replay_id,
    JSONExtractUInt(c, 'playerId')               AS player_id,
    JSONExtractString(c, 'playerName')           AS player_name,
    JSONExtractString(c, 'mode')                 AS mode,
    JSONExtractString(c, 'message')              AS message,
    JSONExtractUInt(c, 'timeMS')                 AS time_ms,
    c_idx                                        AS seq,
    r.ingested_at                                AS ingested_at
FROM w3g.replays_raw AS r
ARRAY JOIN
    JSONExtractArrayRaw(r.doc, 'chat')                AS c,
    arrayEnumerate(JSONExtractArrayRaw(r.doc, 'chat')) AS c_idx;

-- Field names vary across parser output shapes: prefer toPlayerId/ms, fall
-- back to recipient/time.
CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.mv__resource_transfers
TO w3g.resource_transfers AS
SELECT
    r.replay_id                                  AS replay_id,
    JSONExtractUInt(p, 'id')                     AS from_player_id,
    coalesce(JSONExtract(t, 'toPlayerId', 'Nullable(UInt8)'),
             JSONExtractUInt(t, 'recipient'))    AS to_player_id,
    JSONExtractInt(t, 'gold')                    AS gold,
    JSONExtractInt(t, 'lumber')                  AS lumber,
    coalesce(JSONExtract(t, 'ms', 'Nullable(UInt32)'),
             JSONExtractUInt(t, 'time'))         AS time_ms,
    t_idx                                        AS seq,
    r.ingested_at                                AS ingested_at
FROM w3g.replays_raw AS r
ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
ARRAY JOIN
    JSONExtractArrayRaw(p, 'resourceTransfers')                AS t,
    arrayEnumerate(JSONExtractArrayRaw(p, 'resourceTransfers')) AS t_idx;

-- ---------- Event fan-out into replay_events ----------

-- build / unit / item / upgrade order events. race/matchup ride in on the
-- source row (stamped at extraction), so the only JOIN is the static mappings
-- dim — no dependency on the header tables being populated first.
CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.mv_events__order
TO w3g.replay_events AS
SELECT
    e.race                                        AS race,
    e.matchup                                     AS matchup,
    e.replay_id                                   AS replay_id,
    e.player_id                                   AS player_id,
    e.time_ms                                     AS time_ms,
    CAST(e.kind AS String)                        AS event_type,
    e.object_code                                 AS subject_code,
    coalesce(nullIf(m.name, ''), e.object_code)   AS subject_name,
    ''                                            AS detail,
    e.seq                                         AS seq,
    e.ingested_at                                 AS ingested_at
FROM w3g.player_order_events AS e
-- Match on (code, kind): WC3 codes are unique per kind today, but a code
-- present under >1 kind would otherwise fan one event row into duplicates
-- the ReplacingMergeTree can't collapse. e.kind ('building'/'unit'/'item'/
-- 'upgrade') equals mappings.kind exactly, so this is a no-op on today's data.
LEFT JOIN w3g.mappings AS m
    ON m.code = e.object_code AND m.kind = CAST(e.kind AS String);

-- hero skill events. race/matchup ride in on the source row; the only JOINs
-- are the static mappings dim (ability name, hero name).
CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.mv_events__hero
TO w3g.replay_events AS
SELECT
    h.race                                        AS race,
    h.matchup                                     AS matchup,
    h.replay_id                                   AS replay_id,
    h.player_id                                   AS player_id,
    h.time_ms                                     AS time_ms,
    'hero_skill'                                  AS event_type,
    h.ability_id                                  AS subject_code,
    coalesce(nullIf(ma.name, ''), h.ability_id)   AS subject_name,
    coalesce(nullIf(mh.name, ''), h.hero_id)      AS detail,
    h.seq                                         AS seq,
    h.ingested_at                                 AS ingested_at
FROM w3g.hero_ability_events AS h
-- Pin the kind on both joins so a future code collision across kinds can't
-- fan a hero-skill row into duplicates (see mv_events__order). All ability_ids
-- resolve under kind='hero_skill', all hero_ids under kind='hero' today.
LEFT JOIN w3g.mappings AS ma
    ON ma.code = h.ability_id AND ma.kind = 'hero_skill'
LEFT JOIN w3g.mappings AS mh
    ON mh.code = h.hero_id AND mh.kind = 'hero';

-- Synthetic hero_trained events: first ability event per (replay, player,
-- hero) is the summon time within a fraction of a second. Correctness
-- assumes all of a hero's ability events arrive in one INSERT block —
-- safe today (one INSERT per pipeline run, ~33k rows ≪ default block size).
CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.mv_events__hero_trained
TO w3g.replay_events AS
SELECT
    f.race                                     AS race,
    f.matchup                                  AS matchup,
    f.replay_id                                AS replay_id,
    f.player_id                                AS player_id,
    f.time_ms                                  AS time_ms,
    'hero_trained'                             AS event_type,
    f.hero_id                                  AS subject_code,
    coalesce(nullIf(mh.name, ''), f.hero_id)   AS subject_name,
    ''                                         AS detail,
    CAST(0 AS UInt32)                          AS seq,
    now()                                      AS ingested_at
FROM (
    -- race/matchup are functionally determined by (replay_id, player_id), so
    -- carrying them through GROUP BY just rides the cohort along — no JOIN.
    SELECT replay_id, player_id, hero_id, race, matchup, min(time_ms) AS time_ms
    FROM w3g.hero_ability_events
    GROUP BY replay_id, player_id, hero_id, race, matchup
) AS f
LEFT JOIN w3g.mappings AS mh
    ON mh.code = f.hero_id AND mh.kind = 'hero';

-- ---------- Read-time dedup view (replace load-time OPTIMIZE … FINAL) ----------
-- replay_listings is genuinely versioned: the link MV writes a provisional row,
-- then load_listings.sql overwrites it with the warcraft3.info sidecar's
-- canonical map_name under a newer ingested_at. Reads go through this view so
-- they always see the latest version per replay — argMax(col, ingested_at)
-- reproduces FINAL's "latest row per key" as plain aggregation, so the base
-- table needs neither a read-time FINAL nor a load-time OPTIMIZE … FINAL. See
-- catalog/semantics/replay-events-read-skips-final.md and the matching w3c
-- dedup views in db/w3c/tables.sql. Defined BEFORE refresh__opener_rollup below,
-- which reads it.
CREATE VIEW IF NOT EXISTS w3g.replay_listings_dedup AS
SELECT
    replay_id,
    argMax(api_id,       ingested_at) AS api_id,
    argMax(map_id,       ingested_at) AS map_id,
    argMax(map_alias_id, ingested_at) AS map_alias_id,
    argMax(map_name,     ingested_at) AS map_name,
    argMax(map_short,    ingested_at) AS map_short
FROM w3g.replay_listings
GROUP BY replay_id;

-- Same pattern for the minimap-asset dim: pipeline re-runs re-insert every
-- staged map, so readers (api/minimaps.py) go through this instead of FINAL.
CREATE VIEW IF NOT EXISTS w3g.maps_dedup AS
SELECT
    checksum_sha1,
    argMax(file,           ingested_at) AS file,
    argMax(canonical_name, ingested_at) AS canonical_name,
    argMax(width,          ingested_at) AS width,
    argMax(height,         ingested_at) AS height,
    argMax(bounds,         ingested_at) AS bounds,
    argMax(png_base64,     ingested_at) AS png_base64
FROM w3g.maps
GROUP BY checksum_sha1;

-- ---------- Refreshable opener_rollup ----------
--
-- Atomically replaces opener_rollup. This trie aggregation can't be an
-- incremental MV: it assembles a per-(replay,player) time-ordered sequence
-- (groupArray → arraySort → arrayCompact) over replay_events FINAL and 5-way-
-- joins the header tables. An insert trigger sees only the inserted block —
-- not the FINAL-collapsed state, not events arriving in a later block — so it
-- would miscount. Refreshable (re-run the whole query, swap the result) is the
-- correct tool; the only question is who triggers the refresh.
--
-- REFRESH EVERY 10 MINUTE makes it writer-agnostic: BOTH writers of
-- replays_raw — the batch load (scripts/pipeline.sh) and the S3Queue stream
-- (stream.sql) — cascade into replay_events, and neither needs to know this
-- rollup exists. The interval bounds staleness to ≤10 min regardless of which
-- writer landed data. scripts/pipeline.sh ALSO issues an explicit SYSTEM REFRESH … WAIT
-- at its tail, so a batch run is deterministically fresh the instant it exits
-- (the invariants test runs right after). Idle re-scans against unchanged data
-- are cheap at this corpus size (high-MMR 1v1 only) — bounded freshness wins
-- the trade. test_opener_rollup_matches_live_recount guards against drift.
--
-- After the w3info collapse, replay_listings is in w3g — no cross-DB JOIN.
CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.refresh__opener_rollup
REFRESH EVERY 10 MINUTE
TO w3g.opener_rollup AS
SELECT
    race,
    opponent_race,
    map,
    toUInt8(length(prefix))     AS depth,
    prefix,
    count()                     AS matches,
    sum(won)                    AS wins,
    sum(duration_ms)            AS sum_duration_ms,
    groupArraySample(10)(replay_id) AS sample_replays
FROM (
    SELECT
        race, opponent_race, map, replay_id, duration_ms, won,
        arrayJoin(
            arrayMap(k -> arraySlice(seq, 1, k), range(1, length(seq) + 1))
        ) AS prefix
    FROM (
        SELECT
            rp.race AS race,
            opp.race AS opponent_race,
            coalesce(l.map_name, '') AS map,
            e.replay_id AS replay_id,
            e.player_id AS player_id,
            r.duration_ms AS duration_ms,
            if(r.winning_team_id = rp.team_id, toUInt8(1), toUInt8(0)) AS won,
            -- arraySort → arrayMap (drop time) → arrayCompact (dedup spam-
            -- clicks) → arraySlice (cap depth at 6).
            arraySlice(
                arrayCompact(
                    arrayMap(t -> t.2,
                        arraySort(t -> t.1, groupArray((e.time_ms, e.subject_code)))
                    )
                ),
                1, 6
            ) AS seq
        -- No FINAL on replay_events: the zero-duplicate invariant is asserted
        -- at load (load.sql) and verified by pipeline.sh — the same invariant
        -- the API hot path relies on to read without FINAL. FINAL stays on the
        -- dim/header joins below.
        FROM w3g.replay_events AS e
        INNER JOIN w3g.mappings AS m
            ON m.code = e.subject_code AND m.kind = 'building'
        INNER JOIN w3g.replay_players AS rp FINAL
            ON rp.replay_id = e.replay_id AND rp.player_id = e.player_id
        INNER JOIN w3g.replays AS r FINAL
            ON r.replay_id = e.replay_id
        INNER JOIN w3g.replay_players AS opp FINAL
            ON opp.replay_id = e.replay_id
        LEFT JOIN w3g.replay_listings_dedup AS l
            ON l.replay_id = e.replay_id
        WHERE e.event_type = 'building'
          AND m.is_supply_building = 0
          AND r.type = '1on1'
          -- Exclude unknown-winner replays (winning_team_id = -1): no team_id is
          -- -1, so `won` would always be 0, deflating winrate. The API search
          -- path gates identically (compiler.py: r.winning_team_id >= 0).
          AND r.winning_team_id >= 0
          -- Any two DISTINCT teams count as playing — WC3 lobbies allow
          -- arbitrary team slots (real 1v1s exist on teams [3,4], [0,5]), and
          -- observers never land in replay_players (every 1on1 has exactly two
          -- rows), so distinctness is the whole invariant. A 0/1 gate here
          -- silently dropped those replays from the rollup.
          AND rp.team_id != opp.team_id
          AND opp.player_id != e.player_id
        GROUP BY race, opponent_race, map, replay_id, e.player_id, duration_ms, won
    )
    WHERE length(seq) > 0
)
GROUP BY race, opponent_race, map, prefix
-- The groupArray+arrayJoin build is memory-proportional to the corpus — the
-- realistic OOM path when this refresh runs on the small VM (CH OOMs ~3 GiB at
-- full-corpus size). Spill the GROUP BY to disk past this threshold instead.
-- ponytail: 1.5 GiB literal; raise the dial (or REFRESH EVERY) if the VM grows.
SETTINGS max_bytes_before_external_group_by = 1500000000;

-- ---------------------------------------------------------------------------
-- Build Order Analytics feature rollup (handoff/scope-build-order-analytics.md).
--
-- Same shape as refresh__opener_rollup: a refreshable MV re-derived wholesale
-- on a cadence (per-player-game aggregates need the full event set, so an
-- insert-triggered MV can't maintain them incrementally).
--
-- Semantics worth naming:
--   * first/second/third hero come from player_heroes.hero_slot 0/1/2 —
--     verified training order (100% agreement with earliest hero_trained
--     event on the typed subset, 2026-07-20).
--   * expansion_time_s = the FIRST built town-hall event of the player's own
--     race (htow/ogre/unpl/etol). The pre-placed starting hall is never an
--     event, so the first build IS the expansion — the scope doc's "2nd
--     unpl" sketch predates this check. min() also makes spam re-clicks
--     harmless (they land later). NULL = never expanded (one-base). Tier
--     upgrades are distinct codes (unp1/hkee/...) and can't masquerade.
--     Cancelled-then-abandoned expansions still count — replays log intent,
--     not completion (see building-cancel trap).
--   * building_first_s holds first-seen time for EVERY building code (the
--     scope doc's "key tech" map, un-curated: which codes are "key" is a
--     query-time choice, not a schema one).
--   * unit_mix counts train intents per unit code — cumulative investment,
--     never a survived-army snapshot.
--   * event coverage: all 1v1 melee replays carry typed building/unit events
--     (the event_type='unknown' mass is custom modes), so typed filters are
--     safe here.
-- Cadence + memory budget are sized for the e2-medium VM (3.06 GiB TOTAL
-- server cap, shared with loader queries and merges — the 2026-07-20 deploy
-- OOM'd the loader's verify step when a 10-minute tick raced it). Features
-- only change when a load lands, so hourly is fresh enough; the pipeline
-- tail still forces a refresh after every batch load.
-- EMPTY: no create-time refresh — a fresh CREATE during schema-apply
-- otherwise fires the first refresh CONCURRENTLY with the loads and blows
-- the shared 3.06 GiB cap (the 2026-07-20 deploys #2/#3 both lost the
-- loader's verify step as the OvercommitTracker victim). The pipeline tail's
-- explicit SYSTEM REFRESH does the first fill, after loads, serialized.
CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.refresh__player_game_features
REFRESH EVERY 1 HOUR
TO w3g.player_game_features EMPTY AS
SELECT
    pg.race            AS race,
    pg.opponent_race   AS opponent_race,
    pg.replay_id       AS replay_id,
    pg.player_id       AS player_id,
    pg.season          AS season,
    pg.duration_ms     AS duration_ms,
    pg.won             AS won,
    coalesce(h.hs[1], '') AS first_hero,
    coalesce(h.hs[2], '') AS second_hero,
    coalesce(h.hs[3], '') AS third_hero,
    pg.expansion_time_s AS expansion_time_s,
    pg.building_first_s AS building_first_s,
    pg.unit_mix         AS unit_mix
FROM
(
    SELECT
        rp.race AS race,
        opp.race AS opponent_race,
        e.replay_id AS replay_id,
        e.player_id AS player_id,
        coalesce(mm.season, 0) AS season,
        r.duration_ms AS duration_ms,
        if(r.winning_team_id = rp.team_id, toUInt8(1), toUInt8(0)) AS won,
        -- Any town-hall code works: a player only ever builds their own
        -- race's hall, and code-matching (not race-matching) keeps Random
        -- players covered. 0 is impossible for a real build event, so
        -- nullIf is a safe "no town-hall built" marker.
        nullIf(toNullable(minIf(toFloat32(e.first_s),
            e.subject_code IN ('htow', 'ogre', 'unpl', 'etol'))), 0) AS expansion_time_s,
        mapFromArrays(
            groupArrayIf(e.subject_code, e.event_type = 'building'),
            groupArrayIf(toFloat32(e.first_s), e.event_type = 'building')) AS building_first_s,
        mapFromArrays(
            groupArrayIf(e.subject_code, e.event_type = 'unit'),
            groupArrayIf(toUInt16(e.n), e.event_type = 'unit')) AS unit_mix
    FROM
    (
        SELECT replay_id, player_id, event_type, subject_code,
               min(time_ms) / 1000.0 AS first_s, count() AS n
        FROM w3g.replay_events
        WHERE event_type IN ('building', 'unit')
        GROUP BY replay_id, player_id, event_type, subject_code
    ) AS e
    INNER JOIN w3g.replay_players AS rp FINAL
        ON rp.replay_id = e.replay_id AND rp.player_id = e.player_id
    INNER JOIN w3g.replays AS r FINAL
        ON r.replay_id = e.replay_id
    INNER JOIN w3g.replay_players AS opp FINAL
        ON opp.replay_id = e.replay_id
    LEFT JOIN
    (
        SELECT l.replay_id AS replay_id, m.season AS season
        FROM w3c.replay_links_dedup AS l
        INNER JOIN w3c.matches_dedup AS m
            ON m.ongoing_match_id = l.ongoing_match_id
    ) AS mm ON mm.replay_id = e.replay_id
    WHERE r.type = '1on1' AND r.winning_team_id >= 0
      AND rp.team_id != opp.team_id AND opp.player_id != e.player_id
    GROUP BY race, opponent_race, replay_id, player_id, season, duration_ms, won
) AS pg
LEFT JOIN
(
    SELECT replay_id, player_id,
           arrayMap(t -> t.2, arraySort(groupArray((hero_slot, hero_id)))) AS hs
    FROM
    (
        SELECT replay_id, player_id, hero_slot,
               argMax(hero_id, ingested_at) AS hero_id
        FROM w3g.player_heroes
        GROUP BY replay_id, player_id, hero_slot
    )
    GROUP BY replay_id, player_id
) AS h ON h.replay_id = pg.replay_id AND h.player_id = pg.player_id
SETTINGS max_bytes_before_external_group_by = 500000000, max_threads = 2;
