-- One row per player per 1v1 game: who, against whom, where, the result, the heroes
-- and what they opened with. The query API's main semantic model (see the YAML).
--
-- race and opponent_race are played races (replay_players), random and
-- opponent_random say who picked Random, and matchup is built from the played races.
-- heroes lists the player's heroes in pick order (the first skill point), so
-- first_hero to third_hero are heroes[1] to heroes[3], and minutes_5 is the
-- game length in 5-minute bins. opener_1..opener_6 are the first six non-supply buildings
-- in order, back-to-back repeats dropped, '' past the end, so the opener tree is a
-- GROUP BY over them. opp_start_x and opp_start_y are the opponent's start location
-- (player_starts), NULL when no rule names it: a forward step measures from there.
{{ config(order_by='(race, opponent_race, map, replay_id, player_id)') }}

WITH
openers AS (
    SELECT
        e.replay_id AS replay_id,
        e.player_id AS player_id,
        -- order by time then seq, drop back-to-back repeat clicks, cap at 6
        arraySlice(
            arrayCompact(arrayMap(t -> t.3,
                arraySort(t -> (t.1, t.2), groupArray((e.time_ms, e.seq, e.subject_code))))),
            1, 6) AS opener
    FROM {{ ref('replay_events') }} AS e
    INNER JOIN {{ ref('mappings') }} AS m ON m.code = e.subject_code AND m.kind = 'building'
    WHERE e.event_type = 'building' AND m.is_supply_building = 0
    GROUP BY e.replay_id, e.player_id
),
hero_lists AS (
    SELECT replay_id, player_id, arraySort(groupArray((hero_slot, hero_id, final_level))) AS h
    FROM {{ ref('player_heroes') }}
    WHERE hero_id != ''
    GROUP BY replay_id, player_id
)
SELECT
    rp.replay_id                                      AS replay_id,
    rp.player_id                                      AS player_id,
    rp.name                                           AS player,
    rp.race                                           AS race,
    rp.random                                         AS random,
    opp.player_id                                     AS opponent_id,
    opp.name                                          AS opponent,
    opp.race                                          AS opponent_race,
    opp.random                                        AS opponent_random,
    toLowCardinality(arrayStringConcat(arraySort(arrayMap(
        x -> transform(x, ['HU', 'OC', 'NE', 'UD'], ['H', 'O', 'N', 'U'], 'R'), [rp.race, opp.race])), 'v')) AS matchup,
    r.map                                             AS map,
    r.patch                                           AS patch,
    r.added_at                                        AS added_at,
    r.duration_ms                                     AS duration_ms,
    round(r.duration_ms / 60000, 1)                   AS minutes,
    toUInt16(intDiv(r.duration_ms, 300000) * 5)       AS minutes_5,
    toLowCardinality(multiIf(r.winning_team_id < 0, 'unknown',
            r.winning_team_id = rp.team_id, 'win', 'loss')) AS result,
    rp.apm                                            AS apm,
    arrayMap(t -> t.2, hs.h)                          AS heroes,
    arrayMap(t -> t.3, hs.h)                          AS hero_levels,
    toLowCardinality(heroes[1])                       AS first_hero,
    toLowCardinality(heroes[2])                       AS second_hero,
    toLowCardinality(heroes[3])                       AS third_hero,
    o.opener                                          AS opener,
    toLowCardinality(o.opener[1]) AS opener_1, toLowCardinality(o.opener[2]) AS opener_2,
    toLowCardinality(o.opener[3]) AS opener_3, toLowCardinality(o.opener[4]) AS opener_4,
    toLowCardinality(o.opener[5]) AS opener_5, toLowCardinality(o.opener[6]) AS opener_6,
    os.start_x                                        AS opp_start_x,
    os.start_y                                        AS opp_start_y
FROM {{ ref('replay_players') }} AS rp
INNER JOIN {{ ref('replays') }} AS r ON r.replay_id = rp.replay_id
-- Any two distinct teams count as opponents; lobbies allow arbitrary team slots.
INNER JOIN {{ ref('replay_players') }} AS opp
    ON opp.replay_id = rp.replay_id AND opp.team_id != rp.team_id
LEFT JOIN openers AS o ON o.replay_id = rp.replay_id AND o.player_id = rp.player_id
LEFT JOIN hero_lists AS hs ON hs.replay_id = rp.replay_id AND hs.player_id = rp.player_id
LEFT JOIN {{ ref('player_starts') }} AS os ON os.replay_id = opp.replay_id AND os.player_id = opp.player_id
-- A game that arrived as two files counts once, through the copy replays picks.
WHERE r.type = '1on1' AND r.duplicate_of = ''
