-- One row per replay: the header, the settings, and a readable map name.
{{ config(order_by='replay_id') }}

WITH replaceRegexpOne(JSONExtractString(r.doc, 'map', 'file'), '\\.(w3x|w3m|w3g)$', '') AS stem
SELECT
    r.replay_id                                                          AS replay_id,
    -- The GNL series and game number the object key carried, written into the
    -- parsed document by the drain. 0 for a replay from any other source.
    toUInt32(JSONExtractUInt(r.doc, 'gnl', 'series_id'))                 AS gnl_series_id,
    toUInt8(JSONExtractUInt(r.doc, 'gnl', 'game_no'))                    AS gnl_game_no,
    -- The map segment of a w3c filename, then "_v1.3" and camelCase into spaces.
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
    '_', ' ')                                                            AS map,
    JSONExtractString(r.doc, 'map')                                      AS map_json,
    JSONExtractString(r.doc, 'gamename')                                 AS gamename,
    JSONExtractString(r.doc, 'creator')                                  AS creator,
    JSONExtractString(r.doc, 'type')                                     AS type,
    JSONExtractString(r.doc, 'matchup')                                  AS matchup,
    toUInt32(JSONExtractUInt(r.doc, 'duration'))                         AS duration_ms,
    toUInt32(JSONExtractUInt(r.doc, 'buildNumber'))                      AS build_number,
    JSONExtractString(r.doc, 'version')                                  AS version,
    JSONExtractBool(r.doc, 'expansion')                                  AS expansion,
    toUInt32(JSONExtractUInt(r.doc, 'parseTime'))                        AS parse_time_ms,
    -- -1 when the parser could not tell who won.
    coalesce(JSONExtract(r.doc, 'winningTeamId', 'Nullable(Int8)'), -1)  AS winning_team_id,
    JSONExtractInt(r.doc, 'randomseed')                                  AS random_seed,
    toUInt8(JSONExtractUInt(r.doc, 'startSpots'))                        AS start_spots,
    JSONExtract(r.doc, 'observers', 'Array(String)')                     AS observers,
    toUInt8(JSONExtractUInt(r.doc, 'settings', 'speed'))                 AS speed,
    JSONExtractBool(r.doc, 'settings', 'fixedTeams')                     AS fixed_teams,
    JSONExtractBool(r.doc, 'settings', 'teamsTogether')                  AS teams_together,
    JSONExtractBool(r.doc, 'settings', 'fullSharedUnitControl')          AS full_shared_unit_control,
    JSONExtractBool(r.doc, 'settings', 'alwaysVisible')                  AS always_visible,
    JSONExtractBool(r.doc, 'settings', 'mapExplored')                    AS map_explored,
    JSONExtractBool(r.doc, 'settings', 'referees')                       AS referees,
    JSONExtractString(r.doc, 'settings', 'observerMode')                 AS observer_mode,
    JSONExtractBool(r.doc, 'settings', 'randomHero')                     AS random_hero,
    JSONExtractBool(r.doc, 'settings', 'randomRaces')                    AS random_races,
    JSONExtractBool(r.doc, 'settings', 'hideTerrain')                    AS hide_terrain
FROM {{ ref('raw_replays') }} AS r
