-- One row per replay: the header, the settings, a readable map name, the patch, the
-- result and, when one game arrived as two files, which file stands for it.
{{ config(order_by='replay_id') }}

WITH
    replaceRegexpOne(JSONExtractString(r.doc, 'map', 'file'), '\\.(w3x|w3m|w3g)$', '') AS stem,
    JSONExtractArrayRaw(r.doc, 'players') AS players,
    arrayMap(p -> JSONExtractUInt(p, 'id'), players) AS player_ids,
    -- -1 for a missing team, as replay_players.team_id has it; player_games compares the two
    arrayMap(p -> coalesce(JSONExtract(p, 'teamid', 'Nullable(Int8)'), toInt8(-1)), players) AS team_ids,
    JSONExtractArrayRaw(r.doc, 'leaves') AS leaves,
    -- A player's leave the game marked victory (result 09). The winner can leave the
    -- victory screen before the loser's leave is logged, so this outranks quit order.
    arrayFirst(l -> JSONExtractString(l, 'result') = '09000000'
                    AND has(player_ids, JSONExtractUInt(l, 'playerId')), leaves) AS victory_leave,
    -- 1v1: who quit, in order: each leave's player, then the saver. A FLO player-saved
    -- file stops at the saver's own leave and drops it, so with no player leave recorded
    -- the saver quit first.
    arrayPushBack(arrayMap(l -> JSONExtractUInt(l, 'playerId'), leaves),
                  JSONExtractUInt(r.doc, 'saverPlayerId')) AS quitters,
    -- The first player to quit lost, observers skipped. 0 when no quitter is a player.
    arrayFirstIndex(id -> has(player_ids, id), quitters) AS first_quit,
    -- Team game: the team of each player leave in log order, each player once, observers skipped.
    arrayMap(id -> team_ids[indexOf(player_ids, id)],
             arrayDistinct(arrayFilter(id -> has(player_ids, id), arrayMap(l -> JSONExtractUInt(l, 'playerId'), leaves)))) AS leave_teams,
    -- How many leaves in a row, from the first, are of the first team to lose a player.
    if(arrayFirstIndex(t -> t != leave_teams[1], leave_teams) = 0, length(leave_teams),
       arrayFirstIndex(t -> t != leave_teams[1], leave_teams) - 1) AS first_team_run,
    -- The victory leave's team won. Else in 1v1 the player who did not quit first won, and
    -- in a team game the other team won when every player of one team left before any
    -- player of the other. -1 (no winner) otherwise, and unless the game has two teams.
    multiIf(length(arrayDistinct(team_ids)) != 2, -1,
            victory_leave != '', team_ids[indexOf(player_ids, JSONExtractUInt(victory_leave, 'playerId'))],
            length(team_ids) = 2, if(first_quit > 0, arrayFirst(t -> t != team_ids[indexOf(player_ids, quitters[first_quit])], team_ids), -1),
            notEmpty(leave_teams) AND first_team_run >= countEqual(team_ids, leave_teams[1]),
                arrayFirst(t -> t != leave_teams[1], team_ids),
            -1) AS winner
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
    -- when the bucket last wrote the raw file; a replay header holds no date
    parseDateTimeBestEffortOrZero(JSONExtractString(r.doc, 'source_last_modified'), 'UTC') AS added_at,
    winner                                                               AS winning_team_id,
    arrayStringConcat(arraySort(arrayFilter((n, t) -> t = winner,
        arrayMap(p -> JSONExtractString(p, 'name'), players), team_ids)), ',') AS winner_names,
    JSONExtractInt(r.doc, 'randomseed')                                  AS random_seed,
    concat(toString(random_seed), ':',
           arrayStringConcat(arraySort(arrayMap(p -> JSONExtractString(p, 'name'), players)), ',')) AS game_key,
    -- The copy that stands for the game: the longest, then the one with the most events,
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
FROM {{ ref('valid_replays') }} AS r
LEFT JOIN {{ ref('patches') }} AS pt ON pt.build_number = toUInt32(JSONExtractUInt(r.doc, 'buildNumber'))
WINDOW game AS (PARTITION BY game_key
                ORDER BY JSONExtractUInt(r.doc, 'duration') DESC, r.events DESC, r.replay_id)
