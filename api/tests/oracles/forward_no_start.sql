-- Built a forward Barracks or Scout Tower, picked Human: one placement under 3,000 from the opponent's
-- start location. A player whose opponent has no start (6361c666: the Undead gave no building order on
-- a four-start map) has no forward placement. Starts and rule as in forward_towers.sql.
WITH
map('Autumn Leaves 2.0',[(-2176.,-4672.),(2176.,4672.)], 'Echo Isles 2.2',[(-5184.,4480.),(4672.,4480.)], 'Fading Autumn 1.3',[(-3584.,-3776.),(3584.,3264.)],
    'Hammerfall',[(-3904.,3328.),(3904.,-3840.)], 'Last Refuge 1.5',[(-3904.,-3968.),(3840.,3328.)], 'Northern Isles 1.3',[(-2752.,-3328.),(6848.,3328.)],
    'Scrimmage 1.1',[(-5184.,-2944.),(5184.,2944.)], 'Shallow Grave 1.5',[(6528.,-1344.),(-384.,6464.)], 'Springtime 1.4',[(-4224.,2496.),(4224.,-2496.)],
    'Tidehunters 1.2',[(-3904.,2880.),(2880.,-3904.)], 'Turtle Rock 2.0',[(5376.,-2112.),(2624.,-5248.),(-5248.,1600.),(-2112.,4608.)],
    'Twisted Meadows 1.9',[(-4672.,-3840.),(-3584.,4480.),(4672.,3456.),(3712.,-5056.)],
    'Boulder Vale 1.7',[(-3640.,-3240.),(3848.,2960.)], 'Concealed Hill',[(2271.,3799.),(-2416.,-4378.)], 'Northern Isles',[(-2604.,-3114.),(6740.,3081.)],
    'Springtime 1.3',[(-3948.,2623.),(3831.,-2587.)]) AS S,
-- per player: the index in S of the start his earliest placement near a start stands at
near AS (
    SELECT e.replay_id AS replay_id, e.player_id AS player_id,
           argMin(indexOf(ds, arrayMin(ds)), (e.time_ms, e.seq)) AS si
    FROM w3g.player_order_events AS e INNER JOIN w3g.replays AS r ON r.replay_id = e.replay_id
    ARRAY JOIN [arrayMap(s -> hypot(toFloat64(e.x) - s.1, toFloat64(e.y) - s.2), S[r.map])] AS ds
    WHERE e.kind = 'building' AND e.x IS NOT NULL AND arrayMin(ds) <= 1500
    GROUP BY e.replay_id, e.player_id
),
-- per player of a game: the opponent's start (0 when none), by his own placements, else the start the player does not hold
pg AS (
    SELECT g.replay_id AS replay_id, g.player_id AS player_id, g.player AS player, g.map AS mp,
           multiIf(o.si > 0, o.si, length(S[mp]) = 2 AND p.si > 0, 3 - p.si, 0) AS opp_si
    FROM w3g.player_games AS g
    LEFT JOIN near AS p ON p.replay_id = g.replay_id AND p.player_id = g.player_id
    LEFT JOIN near AS o ON o.replay_id = g.replay_id AND o.player_id = g.opponent_id
),
facts AS (
    SELECT pg.replay_id AS replay_id, pg.player AS player,
           countIf(pg.opp_si > 0 AND hypot(toFloat64(e.x) - S[pg.mp][pg.opp_si].1, toFloat64(e.y) - S[pg.mp][pg.opp_si].2) < 3000) >= 1 AS holds,
           multiIf(any(pg.opp_si) = 0, 'no opponent start', holds, 'forward', 'at home') AS kind
    FROM w3g.player_order_events AS e INNER JOIN pg ON pg.replay_id = e.replay_id AND pg.player_id = e.player_id
    WHERE e.kind = 'building' AND e.object_code IN ('hbar', 'hwtw') AND e.x IS NOT NULL
      AND (pg.replay_id, pg.player_id) IN (SELECT replay_id, player_id FROM w3g.player_games WHERE race = 'HU' AND random = 0)
    GROUP BY pg.replay_id, pg.player
),
chosen AS (
    SELECT replay_id FROM (
        SELECT replay_id, kind, row_number() OVER (PARTITION BY kind ORDER BY cityHash64(replay_id)) AS n
        FROM (SELECT DISTINCT replay_id, kind FROM facts))
    WHERE n <= multiIf(kind = 'no opponent start', 1, kind = 'forward', 4, 5)
)
SELECT toJSONString(arraySort(groupUniqArray(replay_id))) AS replay_ids,
       toJSONString(arraySort(groupArrayIf((replay_id, player), holds))) AS matches,
       countIf(holds) AS games, toJSONString(groupArray((left(replay_id, 8), player, kind))) AS kinds
FROM facts WHERE replay_id IN (SELECT replay_id FROM chosen)
