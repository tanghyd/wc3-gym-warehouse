-- One row per replay: the header, the settings, a readable map name, the patch, the
-- result and, when one game arrived as two files, which file stands for it.
{{ config(order_by='replay_id') }}

WITH
    replaceRegexpOne(JSONExtractString(r.doc, 'map', 'file'), '\\.(w3x|w3m|w3g)$', '') AS stem,
    JSONExtractArrayRaw(r.doc, 'players') AS players,
    coalesce(JSONExtract(r.doc, 'winningTeamId', 'Nullable(Int8)'), -1) AS recorded,
    -- (last command ms, team id) per player, latest first
    arrayReverseSort(arrayMap(p -> (JSONExtractUInt(p, 'lastActionMs'),
        coalesce(JSONExtract(p, 'teamid', 'Nullable(Int8)'), -1)), players)) AS last_actions,
    -- The last-actor rule, for a 1on1 the file names no winner for: the player whose last
    -- command came later stayed in the game. A player with no command (every Computer
    -- slot) gives no time to compare, and equal times name no one.
    if(JSONExtractString(r.doc, 'type') = '1on1' AND last_actions[2].1 > 0
           AND last_actions[1].1 > last_actions[2].1,
       last_actions[1].2, -1) AS last_actor_team
SELECT
    r.replay_id                                                          AS replay_id,
    -- The GNL series and game number the object key carried, written into the
    -- parsed document by the drain. 0 for a replay from any other source.
    toUInt32(JSONExtractUInt(r.doc, 'gnl', 'series_id'))                 AS gnl_series_id,
    toUInt8(JSONExtractUInt(r.doc, 'gnl', 'game_no'))                    AS gnl_game_no,
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
    recorded                                                             AS recorded_winning_team_id,
    if(recorded >= 0, recorded, last_actor_team)                         AS winning_team_id,
    toLowCardinality(multiIf(recorded >= 0, 'replay',
                             last_actor_team >= 0, 'last_actor', 'unknown')) AS result_source,
    JSONExtractInt(r.doc, 'randomseed')                                  AS random_seed,
    concat(toString(random_seed), ':',
           arrayStringConcat(arraySort(arrayMap(p -> JSONExtractString(p, 'name'), players)), ',')) AS game_key,
    -- The copy that stands for the game: a w3c- file (the client's own copy names the
    -- saver the winner even when he quit first), then one with a recorded winner,
    -- then the lowest id. '' on that copy itself.
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
                ORDER BY startsWith(basename(source_key), 'w3c-') DESC, recorded >= 0 DESC, r.replay_id)
