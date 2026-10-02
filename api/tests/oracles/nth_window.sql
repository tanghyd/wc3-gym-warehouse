-- 1st hero any Tavern hero, from 2:30, any race picked: the window is on the 1st hero's own training order.
WITH
-- player-games of a picked race in games that arrived as one file and where both players gave orders
ok AS (
    SELECT replay_id, player_id, player FROM w3g.player_games
    WHERE random = 0
      AND replay_id IN (SELECT replay_id FROM w3g.replays WHERE game_key IN (SELECT game_key FROM w3g.replays GROUP BY game_key HAVING count() = 1))
      AND replay_id IN (SELECT replay_id FROM w3g.player_order_events GROUP BY replay_id HAVING uniqExact(player_id) = 2)
),
first_skill AS (SELECT replay_id, player_id, hero_id, min(time_ms) AS first_ms FROM w3g.hero_ability_events GROUP BY replay_id, player_id, hero_id),
hero_orders AS (SELECT replay_id, player_id, object_code AS hero_id, arraySort(groupArray(time_ms)) AS t FROM w3g.player_order_events
                WHERE kind = 'unknown' GROUP BY replay_id, player_id, object_code),
-- a hero's training order: its last real order at or before its first skill point
trained AS (
    SELECT s.replay_id AS replay_id, s.player_id AS player_id, s.hero_id AS hero_id, s.first_ms AS first_ms,
           arrayMax(arrayFilter(x -> x <= s.first_ms, arrayFilter((x, i) -> i = 1 OR x - t[i - 1] >= 1000, t, arrayEnumerate(t)))) AS order_ms, arrayMin(t) AS first_order_ms
    FROM first_skill AS s INNER JOIN hero_orders AS o USING (replay_id, player_id, hero_id)
),
facts AS (
    SELECT g.replay_id AS replay_id, g.player AS player, h1.order_ms >= 150000 AS holds,
           multiIf(holds, '1st Tavern hero ordered from 2:30', h2.order_ms >= 150000, '1st earlier, a later Tavern hero from 2:30', '1st earlier') AS kind
    FROM ok INNER JOIN w3g.player_games AS g USING (replay_id, player_id)
    INNER JOIN trained AS h1 ON h1.replay_id = g.replay_id AND h1.player_id = g.player_id AND h1.hero_id = g.heroes[1]
    LEFT JOIN (SELECT replay_id, player_id, max(order_ms) AS order_ms FROM trained
               WHERE has(['Nalc', 'Nbrn', 'Nbst', 'Nfir', 'Nngs', 'Npbm', 'Nplh', 'Ntin'], hero_id) GROUP BY replay_id, player_id) AS h2
        ON h2.replay_id = g.replay_id AND h2.player_id = g.player_id
    WHERE has(['Nalc', 'Nbrn', 'Nbst', 'Nfir', 'Nngs', 'Npbm', 'Nplh', 'Ntin'], g.heroes[1])
),
chosen AS (
    SELECT replay_id FROM (
        SELECT replay_id, kind, row_number() OVER (PARTITION BY kind ORDER BY cityHash64(replay_id)) AS n FROM facts)
    WHERE n <= if(kind = '1st earlier', 2, 4)
)
SELECT toJSONString(arraySort(groupUniqArray(replay_id))) AS replay_ids,
       toJSONString(arraySort(groupArrayIf((replay_id, player), holds))) AS matches,
       countIf(holds) AS games
FROM facts WHERE replay_id IN (SELECT replay_id FROM chosen)
