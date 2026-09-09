-- db/w3g/views.sql — all materialized views for the w3g database.
--
-- Applied after tables.sql on every run.
--
-- Contents:
--   - Load-time fan-out from replays_raw → projected tables (mv__replays,
--     mv__replay_players, mv__player_heroes, mv__player_group_hotkeys).
--   - Event-stream MVs that populate the denormalized replay_events mart
--     (mv_events__order, mv_events__hero, mv_events__hero_trained).
--   - refresh__opener_rollup — refreshable MV that atomically rebuilds the
--     opener_rollup table.

CREATE DATABASE IF NOT EXISTS w3g;

-- ---------- Readable map name ----------

-- The map name the search UI filters and displays on. Same derivation the
-- opener rollup does inline: strip the extension, then pull the map segment out
-- of the w3c filename, then tidy "_v1.3" and camelCase into spaces.
CREATE VIEW IF NOT EXISTS w3g.replay_map AS
WITH replaceRegexpOne(JSONExtractString(map_json, 'file'), '\\.(w3x|w3m|w3g)$', '') AS stem
SELECT
    replay_id,
    replaceRegexpAll(
        replaceRegexpAll(
            replaceRegexpOne(
                multiIf(
                    match(stem, '_w3c_[0-9]{6}_[0-9]{4}_[0-9]+$'),
                        extract(stem, '^(?:1v1_)?(.+?)_w3c_[0-9]{6}_[0-9]{4}_[0-9]+$'),
                    match(stem, '^(?:[0-9]+_)?w3c_[0-9]{6}_[0-9]{4}_'),
                        extract(stem, '^(?:[0-9]+_)?w3c_[0-9]{6}_[0-9]{4}_(.+)$'),
                    stem),
            '_v([0-9])', ' \\1'),
        '([a-z0-9])([A-Z])', '\\1 \\2'),
    '_', ' ') AS map
-- FINAL: replays is a ReplacingMergeTree, so an unmerged re-stage would double a row.
FROM w3g.replays FINAL;

-- ---------- One opener per player per game ----------

-- One row per player per 1v1, holding the first six distinct non-supply
-- buildings they put down. Both the opener rollup and the search page read it,
-- so the derivation lives here once. It keeps player_id and player_name, which
-- the rollup aggregates away, so a caller can ask about one player.
CREATE VIEW IF NOT EXISTS w3g.replay_openers AS
SELECT
    rp.race AS race,
    opp.race AS opponent_race,
    mp.map AS map,
    e.replay_id AS replay_id,
    e.player_id AS player_id,
    any(rp.name) AS player_name,
    r.duration_ms AS duration_ms,
    if(r.winning_team_id = rp.team_id, toUInt8(1), toUInt8(0)) AS won,
    -- arraySort -> arrayMap (drop time) -> arrayCompact (dedup spam-clicks)
    -- -> arraySlice (cap depth at 6).
    arraySlice(
        arrayCompact(
            arrayMap(t -> t.2,
                arraySort(t -> t.1, groupArray((e.time_ms, e.subject_code)))
            )
        ),
        1, 6
    ) AS seq
-- No FINAL on replay_events: the replay_id gate in backfill.sql means a replay
-- is inserted once. FINAL stays on the header joins.
FROM w3g.replay_events AS e
INNER JOIN w3g.mappings AS m
    ON m.code = e.subject_code AND m.kind = 'building'
INNER JOIN w3g.replay_players AS rp FINAL
    ON rp.replay_id = e.replay_id AND rp.player_id = e.player_id
INNER JOIN w3g.replays AS r FINAL
    ON r.replay_id = e.replay_id
INNER JOIN w3g.replay_map AS mp
    ON mp.replay_id = e.replay_id
INNER JOIN w3g.replay_players AS opp FINAL
    ON opp.replay_id = e.replay_id
WHERE e.event_type = 'building'
  AND m.is_supply_building = 0
  AND r.type = '1on1'
  -- Exclude unknown-winner replays (winning_team_id = -1): no team_id is -1,
  -- so `won` would always be 0, deflating winrate.
  AND r.winning_team_id >= 0
  -- Any two DISTINCT teams count as playing. WC3 lobbies allow arbitrary team
  -- slots, and observers never land in replay_players.
  AND rp.team_id != opp.team_id
  AND opp.player_id != e.player_id
GROUP BY race, opponent_race, map, replay_id, e.player_id, duration_ms, won;

-- ---------- Load-time fan-out from replays_raw ----------

CREATE MATERIALIZED VIEW IF NOT EXISTS w3g.mv__replays
TO w3g.replays AS
SELECT
    r.replay_id                                                              AS replay_id,
    JSONExtractUInt(r.doc, 'gnl', 'series_id')                               AS gnl_series_id,
    JSONExtractUInt(r.doc, 'gnl', 'game_no')                                 AS gnl_game_no,
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

-- ---------- Refreshable opener_rollup ----------
--
-- Atomically replaces opener_rollup. This trie aggregation can't be an
-- incremental MV: it assembles a per-(replay,player) time-ordered sequence
-- (groupArray → arraySort → arrayCompact) over replay_events and joins the
-- header tables. An insert trigger sees only the inserted block, so it would
-- miscount. Refreshable (re-run the whole query, swap the result) is the tool.
--
-- REFRESH EVERY 10 MINUTE bounds staleness without the backfill having to know
-- this rollup exists. `just backfill` follows with an explicit
-- SYSTEM REFRESH VIEW … when a run needs to be fresh the instant it exits.
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
    FROM w3g.replay_openers
    WHERE length(seq) > 0
)
GROUP BY race, opponent_race, map, prefix
-- The groupArray+arrayJoin build is memory-proportional to the corpus, so spill
-- the GROUP BY to disk past this threshold rather than let the box OOM.
-- ponytail: 1.5 GiB literal; raise the dial if the box grows.
SETTINGS max_bytes_before_external_group_by = 1500000000;
