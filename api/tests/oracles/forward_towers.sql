-- Built 2 or more forward Scout Towers, Watch Towers or Ancient Protectors by 5:00, any race: a forward
-- tower is under 3,000 from the opponent's start location. Labelled without player_starts or the
-- compiler: the starts are those of threads/warehouse-dbt-prototype/review/a3-towers.sql (map file
-- starts, cluster centres on the 4 maps with no file), and a player's start is the one within 1,500
-- of his earliest building placement within 1,500 of any start (a3-off-start.sql), else on a
-- two-start map the start his opponent does not hold.
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
-- per player-game: the opponent's start (0 when none), by his own placements, else the start the player does not hold
pg AS (
    SELECT g.replay_id AS replay_id, g.player_id AS player_id, g.player AS player, g.map AS mp,
           multiIf(o.si > 0, o.si, length(S[mp]) = 2 AND p.si > 0, 3 - p.si, 0) AS opp_si
    FROM w3g.player_games AS g
    LEFT JOIN near AS p ON p.replay_id = g.replay_id AND p.player_id = g.player_id
    LEFT JOIN near AS o ON o.replay_id = g.replay_id AND o.player_id = g.opponent_id
),
towers AS (
    SELECT pg.replay_id AS replay_id, pg.player_id AS player_id, any(e.object_code) AS code, count() AS n,
           countIf(pg.opp_si > 0 AND hypot(toFloat64(e.x) - S[pg.mp][pg.opp_si].1, toFloat64(e.y) - S[pg.mp][pg.opp_si].2) < 3000) AS fwd
    FROM w3g.player_order_events AS e INNER JOIN pg ON pg.replay_id = e.replay_id AND pg.player_id = e.player_id
    WHERE e.kind = 'building' AND e.object_code IN ('hwtw', 'owtw', 'etrp') AND e.x IS NOT NULL AND e.time_ms <= 300000
    GROUP BY pg.replay_id, pg.player_id
),
facts AS (
    SELECT pg.replay_id AS replay_id, pg.player AS player, t.fwd >= 2 AS holds,
           multiIf(startsWith(pg.replay_id, '8aac280e'), 'rush at the empty start', startsWith(pg.replay_id, '8b93e408'), 'expansion towers',
                   holds, concat('rush ', t.code), t.fwd = 1, 'one forward', t.n >= 2, 'towers at home', 'other') AS kind
    FROM pg LEFT JOIN towers AS t ON t.replay_id = pg.replay_id AND t.player_id = pg.player_id
),
chosen AS (
    SELECT replay_id FROM (
        SELECT replay_id, kind, row_number() OVER (PARTITION BY kind ORDER BY cityHash64(replay_id)) AS n
        FROM (SELECT DISTINCT replay_id, kind FROM facts))
    WHERE n <= multiIf(kind IN ('rush at the empty start', 'expansion towers', 'one forward', 'rush owtw', 'rush etrp'), 1,
                       kind = 'rush hwtw', 2, kind = 'towers at home', 3, 0)
)
SELECT toJSONString(arraySort(groupUniqArray(replay_id))) AS replay_ids,
       toJSONString(arraySort(groupArrayIf((replay_id, player), holds))) AS matches,
       countIf(holds) AS games, toJSONString(groupArray((left(replay_id, 8), player, kind))) AS kinds
FROM facts WHERE replay_id IN (SELECT replay_id FROM chosen)
