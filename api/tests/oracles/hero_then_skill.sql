-- Hero Demon Hunter, then Learned Mana Burn, picked Night Elf: every point of his skill comes after his training order.
WITH
-- player-games of a picked NE in games that arrived as one file and where both players gave orders
ok AS (
    SELECT replay_id, player_id, player FROM w3g.player_games
    WHERE race = 'NE' AND random = 0
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
mb AS (SELECT replay_id, player_id, arraySort(groupArray(time_ms)) AS t FROM w3g.hero_ability_events
       WHERE event_type = 'ability' AND ability_id = 'AEmb' GROUP BY replay_id, player_id),
facts AS (
    SELECT ok.replay_id AS replay_id, ok.player AS player,
           h.hero_id != '' AND arrayExists(x -> x > h.order_ms, mb.t) AS holds,
           multiIf(h.hero_id = '', 'no Demon Hunter', empty(mb.t), 'no Mana Burn', mb.t[1] = h.first_ms, 'Mana Burn first', 'Mana Burn later') AS kind
    FROM ok LEFT JOIN (SELECT * FROM trained WHERE hero_id = 'Edem') AS h USING (replay_id, player_id)
    LEFT JOIN mb USING (replay_id, player_id)
),
chosen AS (
    SELECT replay_id FROM (
        SELECT replay_id, kind, row_number() OVER (PARTITION BY kind ORDER BY cityHash64(replay_id)) AS n FROM facts)
    WHERE n <= if(kind = 'Mana Burn first', 4, 2)
)
SELECT toJSONString(arraySort(groupUniqArray(replay_id))) AS replay_ids,
       toJSONString(arraySort(groupArrayIf((replay_id, player), holds))) AS matches,
       countIf(holds) AS games
FROM facts WHERE replay_id IN (SELECT replay_id FROM chosen)
