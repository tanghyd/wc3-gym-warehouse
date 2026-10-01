-- One row per player per 1v1 replay: who, against whom, where, the result, and
-- what they opened with. The query API's main semantic model (see the YAML).
--
-- opener_1..opener_6 are the first six non-supply buildings in order, back-to-back
-- repeats dropped, '' past the end, so the opener tree is a GROUP BY over them.
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
first_heroes AS (
    SELECT replay_id, player_id, argMin(subject_code, time_ms) AS first_hero
    FROM {{ ref('replay_events') }}
    WHERE event_type = 'hero_trained'
    GROUP BY replay_id, player_id
)
SELECT
    rp.replay_id                                      AS replay_id,
    rp.player_id                                      AS player_id,
    rp.name                                           AS player,
    rp.race                                           AS race,
    opp.name                                          AS opponent,
    opp.race                                          AS opponent_race,
    r.matchup                                         AS matchup,
    r.map                                             AS map,
    r.duration_ms                                     AS duration_ms,
    round(r.duration_ms / 60000, 1)                   AS minutes,
    multiIf(r.winning_team_id < 0, 'unknown',
            r.winning_team_id = rp.team_id, 'win', 'loss') AS result,
    rp.apm                                            AS apm,
    fh.first_hero                                     AS first_hero,
    o.opener                                          AS opener,
    o.opener[1] AS opener_1, o.opener[2] AS opener_2, o.opener[3] AS opener_3,
    o.opener[4] AS opener_4, o.opener[5] AS opener_5, o.opener[6] AS opener_6,
    r.gnl_series_id                                   AS gnl_series_id,
    r.gnl_game_no                                     AS gnl_game_no
FROM {{ ref('replay_players') }} AS rp
INNER JOIN {{ ref('replays') }} AS r ON r.replay_id = rp.replay_id
-- Any two distinct teams count as opponents; lobbies allow arbitrary team slots.
INNER JOIN {{ ref('replay_players') }} AS opp
    ON opp.replay_id = rp.replay_id AND opp.team_id != rp.team_id
LEFT JOIN openers AS o ON o.replay_id = rp.replay_id AND o.player_id = rp.player_id
LEFT JOIN first_heroes AS fh ON fh.replay_id = rp.replay_id AND fh.player_id = rp.player_id
WHERE r.type = '1on1'
