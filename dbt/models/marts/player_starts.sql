-- One row per player of every 1on1 replay: the start location he began at, from the
-- start_locations seed. A replay names no start, so it is read from where the player builds:
--   1. the start within 1,500 of his earliest building placement that lies within 1,500 of any start
--      (start_source 'first building' when that is his first placement, else 'later building'),
--   2. else, on a two-start map, the start his opponent holds by rule 1 does not ('opponent'),
--   3. else none: start_x and start_y are NULL ('none').
{{ config(order_by='(replay_id, player_id)') }}

WITH
-- each map's starts sorted by slot, so an index into the array names one start every time
maps AS (
    SELECT map, arraySort(groupArray((slot, x, y))) AS starts
    FROM {{ ref('start_locations') }}
    GROUP BY map
),
players AS (
    SELECT rp.replay_id AS replay_id, rp.player_id AS player_id, rp.team_id AS team_id, r.map AS map
    FROM {{ ref('replay_players') }} AS rp
    INNER JOIN {{ ref('replays') }} AS r ON r.replay_id = rp.replay_id
    WHERE r.type = '1on1'
),
-- every building placement, with the index of the start within 1,500 of it (0 when none)
placed AS (
    SELECT o.replay_id AS replay_id, o.player_id AS player_id, (o.time_ms, o.seq) AS at,
           arrayFirstIndex(s -> hypot(o.x - s.2, o.y - s.3) <= 1500, m.starts) AS near
    FROM {{ ref('player_order_events') }} AS o
    INNER JOIN players AS p ON p.replay_id = o.replay_id AND p.player_id = o.player_id
    INNER JOIN maps AS m ON m.map = p.map
    WHERE o.kind = 'building' AND o.x IS NOT NULL
),
-- rule 1: the start of the earliest placement near a start, and whether it is the first placement
own AS (
    SELECT replay_id, player_id, argMinIf(near, at, near > 0) AS start_i,
           toUInt8(minIf(at, near > 0) = min(at)) AS on_first
    FROM placed
    GROUP BY replay_id, player_id
    HAVING countIf(near > 0) > 0
)
SELECT
    replay_id,
    player_id,
    if(i > 0, starts[i].2, NULL)                       AS start_x,
    if(i > 0, starts[i].3, NULL)                       AS start_y,
    toLowCardinality(multiIf(own_i > 0 AND on_first = 1, 'first building', own_i > 0, 'later building',
                             i > 0, 'opponent', 'none')) AS start_source
FROM (
    SELECT p.replay_id AS replay_id, p.player_id AS player_id, m.starts AS starts,
           -- a player with no own row reads start_i 0
           o.start_i AS own_i, o.on_first AS on_first,
           multiIf(o.start_i > 0, o.start_i, length(m.starts) = 2 AND q.start_i > 0, 3 - q.start_i, 0) AS i
    FROM players AS p
    INNER JOIN players AS opp ON opp.replay_id = p.replay_id AND opp.team_id != p.team_id
    LEFT JOIN maps AS m ON m.map = p.map
    LEFT JOIN own AS o ON o.replay_id = p.replay_id AND o.player_id = p.player_id
    LEFT JOIN own AS q ON q.replay_id = opp.replay_id AND q.player_id = opp.player_id
)
