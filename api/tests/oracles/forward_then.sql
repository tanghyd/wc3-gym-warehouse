-- Built a Barracks, then 2 or more forward Scout Towers by 5:00, any race: 2 or more Scout Tower placements by 5:00
-- after the first Barracks placement, each under 3,000 from the opponent's start. The opponent's start is the
-- start_locations row at player_games.opp_start_x, _y (forward_towers checks how that start is found).
WITH
bars AS (
    SELECT replay_id, player_id, min(time_ms) AS bar FROM w3g.player_order_events
    WHERE kind = 'building' AND object_code = 'hbar' AND is_repeat = 0 GROUP BY replay_id, player_id
),
-- per player of a game: the opponent's seed start, and the seed starts of the map that are not his
pg AS (
    SELECT g.replay_id AS replay_id, g.player_id AS player_id, g.player AS player, o.x AS ox, o.y AS oy,
           arrayFilter(s -> s != (o.x, o.y), m.starts) AS others
    FROM w3g.player_games AS g
    INNER JOIN w3g.start_locations AS o ON o.map = g.map AND o.x = g.opp_start_x AND o.y = g.opp_start_y
    INNER JOIN (SELECT map, groupArray((x, y)) AS starts FROM w3g.start_locations GROUP BY map) AS m ON m.map = g.map
),
towers AS (
    SELECT pg.replay_id AS replay_id, pg.player_id AS player_id, max(b.replay_id != '') AS has_bar,
           countIf(e.time_ms <= 300000) AS n5,
           countIf(e.time_ms <= 300000 AND hypot(toFloat64(e.x) - pg.ox, toFloat64(e.y) - pg.oy) < 3000) AS fwd5,
           countIf(e.time_ms <= 300000 AND hypot(toFloat64(e.x) - pg.ox, toFloat64(e.y) - pg.oy) < 3000 AND b.replay_id != '' AND e.time_ms > b.bar) AS fwd5_after,
           countIf(hypot(toFloat64(e.x) - pg.ox, toFloat64(e.y) - pg.oy) < 3000 AND b.replay_id != '' AND e.time_ms > b.bar) AS fwd_after,
           countIf(e.time_ms <= 300000 AND arrayExists(s -> hypot(toFloat64(e.x) - s.1, toFloat64(e.y) - s.2) < 1500, pg.others)) AS home5
    FROM w3g.player_order_events AS e INNER JOIN pg ON pg.replay_id = e.replay_id AND pg.player_id = e.player_id
    LEFT JOIN bars AS b ON b.replay_id = e.replay_id AND b.player_id = e.player_id
    WHERE e.kind = 'building' AND e.object_code = 'hwtw' AND e.is_repeat = 0
    GROUP BY pg.replay_id, pg.player_id
),
facts AS (
    SELECT pg.replay_id AS replay_id, pg.player AS player, t.fwd5_after >= 2 AS holds,
           multiIf(holds, 'rush', t.fwd5 >= 2 AND NOT t.has_bar, 'rush, no barracks', t.fwd5 >= 2, 'forward before the barracks',
                   t.fwd5_after = 1, 'one forward', t.fwd_after >= 2, 'forward after 5:00', t.home5 >= 2, 'towers at home', 'other') AS kind
    FROM pg LEFT JOIN towers AS t ON t.replay_id = pg.replay_id AND t.player_id = pg.player_id
),
chosen AS (
    SELECT replay_id FROM (
        SELECT replay_id, kind, row_number() OVER (PARTITION BY kind ORDER BY cityHash64(replay_id)) AS n
        FROM (SELECT DISTINCT replay_id, kind FROM facts))
    WHERE n <= multiIf(kind = 'rush', 3, kind IN ('rush, no barracks', 'one forward', 'forward after 5:00'), 1,
                       kind IN ('forward before the barracks', 'towers at home'), 2, 0)
)
SELECT toJSONString(arraySort(groupUniqArray(replay_id))) AS replay_ids,
       toJSONString(arraySort(groupArrayIf((replay_id, player), holds))) AS matches,
       countIf(holds) AS games, toJSONString(groupArray((left(replay_id, 8), player, kind))) AS kinds
FROM facts WHERE replay_id IN (SELECT replay_id FROM chosen)
