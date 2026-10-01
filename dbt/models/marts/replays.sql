-- One row per replay: the header, the settings, a readable map name, the patch, the
-- result and, when one game arrived as two files, which file stands for it.
{{ config(order_by='replay_id') }}

WITH
    replaceRegexpOne(JSONExtractString(r.doc, 'map', 'file'), '\\.(w3x|w3m|w3g)$', '') AS stem,
    JSONExtractArrayRaw(r.doc, 'players') AS players,
    arrayMap(p -> JSONExtractUInt(p, 'id'), players) AS player_ids,
    arrayMap(p -> toInt8(JSONExtractInt(p, 'teamid')), players) AS team_ids,
    -- Who quit, in order: each leave's player, then the saver. A FLO player-saved file
    -- stops at the saver's own leave and drops it, so with no player leave recorded the
    -- saver quit first.
    arrayPushBack(arrayMap(l -> JSONExtractUInt(l, 'playerId'), JSONExtractArrayRaw(r.doc, 'leaves')),
                  JSONExtractUInt(r.doc, 'saverPlayerId')) AS quitters,
    -- The first player to quit lost, observers skipped. 0 when no quitter is a player.
    arrayFirstIndex(id -> has(player_ids, id), quitters) AS first_quit,
    -- The other team won. -1 unless the game has exactly two teams and a loser.
    if(first_quit > 0 AND length(arrayDistinct(team_ids)) = 2,
       arrayFirst(t -> t != team_ids[indexOf(player_ids, quitters[first_quit])], team_ids), -1) AS winner
SELECT
    r.replay_id                                                          AS replay_id,
    -- The map segment of a w3c filename, then "_v1.3" and camelCase into spaces.
    toLowCardinality(replaceRegexpAll(
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
    '_', ' '))                                                           AS map,
    JSONExtractString(r.doc, 'map')                                      AS map_json,
    JSONExtractString(r.doc, 'gamename')                                 AS gamename,
    JSONExtractString(r.doc, 'creator')                                  AS creator,
    toLowCardinality(JSONExtractString(r.doc, 'type'))                   AS type,
    toLowCardinality(JSONExtractString(r.doc, 'matchup'))                AS matchup,
    toUInt32(JSONExtractUInt(r.doc, 'duration'))                         AS duration_ms,
    toUInt32(JSONExtractUInt(r.doc, 'buildNumber'))                      AS build_number,
    toLowCardinality(JSONExtractString(r.doc, 'version'))                AS version,
    toLowCardinality(pt.patch)                                           AS patch,
    JSONExtractBool(r.doc, 'expansion')                                  AS expansion,
    toUInt32(JSONExtractUInt(r.doc, 'parseTime'))                        AS parse_time_ms,
    JSONExtractString(r.doc, 'source_key')                               AS source_key,
    winner                                                               AS winning_team_id,
    arrayStringConcat(arraySort(arrayFilter((n, t) -> t = winner,
        arrayMap(p -> JSONExtractString(p, 'name'), players), team_ids)), ',') AS winner_names,
    JSONExtractInt(r.doc, 'randomseed')                                  AS random_seed,
    concat(toString(random_seed), ':',
           arrayStringConcat(arraySort(arrayMap(p -> JSONExtractString(p, 'name'), players)), ',')) AS game_key,
    -- The copy that stands for the game: one with a recorded winner, then the lowest
    -- id. '' on that copy itself.
    if(first_value(r.replay_id) OVER game = r.replay_id, '', first_value(r.replay_id) OVER game) AS duplicate_of,
    toUInt8(JSONExtractUInt(r.doc, 'startSpots'))                        AS start_spots,
    JSONExtract(r.doc, 'observers', 'Array(String)')                     AS observers,
    toUInt8(JSONExtractUInt(r.doc, 'settings', 'speed'))                 AS speed,
    JSONExtractBool(r.doc, 'settings', 'fixedTeams')                     AS fixed_teams,
    JSONExtractBool(r.doc, 'settings', 'teamsTogether')                  AS teams_together,
    JSONExtractBool(r.doc, 'settings', 'fullSharedUnitControl')          AS full_shared_unit_control,
    JSONExtractBool(r.doc, 'settings', 'alwaysVisible')                  AS always_visible,
    JSONExtractBool(r.doc, 'settings', 'mapExplored')                    AS map_explored,
    JSONExtractBool(r.doc, 'settings', 'referees')                       AS referees,
    toLowCardinality(JSONExtractString(r.doc, 'settings', 'observerMode')) AS observer_mode,
    JSONExtractBool(r.doc, 'settings', 'randomHero')                     AS random_hero,
    JSONExtractBool(r.doc, 'settings', 'randomRaces')                    AS random_races,
    JSONExtractBool(r.doc, 'settings', 'hideTerrain')                    AS hide_terrain
FROM {{ ref('raw_replays') }} AS r
LEFT JOIN {{ ref('patches') }} AS pt ON pt.build_number = toUInt32(JSONExtractUInt(r.doc, 'buildNumber'))
WINDOW game AS (PARTITION BY game_key
                ORDER BY winner >= 0 DESC, r.replay_id)
-- raw_replays keeps a replaced document until a merge, so read it deduplicated.
SETTINGS final = 1
