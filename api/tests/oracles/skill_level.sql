-- Learned Sleep at level 3 or more, or Learned Shadow Strike at exactly level 3: a skill count is the
-- skill level. A retraining starts every skill again at 0, a repeat click under 1000 ms gives no level,
-- and a normal skill stops at level 3, so a 4th point is no level. Read from the raw points, not `level`.
WITH
-- player-games in games that arrived as one file and where both players gave orders
ok AS (
    SELECT replay_id, player_id, player FROM w3g.player_games
    WHERE replay_id IN (SELECT replay_id FROM w3g.replays WHERE game_key IN (SELECT game_key FROM w3g.replays GROUP BY game_key HAVING count() = 1))
      AND replay_id IN (SELECT replay_id FROM w3g.player_order_events GROUP BY replay_id HAVING uniqExact(player_id) = 2)
),
points AS (
    SELECT replay_id, player_id, hero_slot, ability_id, arraySort(groupArray((time_ms, seq))) AS p
    FROM w3g.hero_ability_events WHERE event_type = 'ability' AND ability_id IN ('AUsl', 'AEsh')
    GROUP BY replay_id, player_id, hero_slot, ability_id
),
retrains AS (
    SELECT replay_id, player_id, hero_slot, groupArray((time_ms, seq)) AS r
    FROM w3g.hero_ability_events WHERE event_type = 'retraining' GROUP BY replay_id, player_id, hero_slot
),
skills AS (
    SELECT replay_id, player_id, ability_id,
           -- a click: under 1000 ms after the skill's previous point
           arrayMap((x, i) -> i > 1 AND x.1 - p[i - 1].1 < 1000, p, arrayEnumerate(p)) AS click,
           -- the hero's retrainings at or before each point
           arrayMap(x -> arrayCount(y -> y <= x, r), p) AS seg,
           arrayMap(i -> arrayCount((c, s, j) -> NOT c AND s = seg[i] AND j <= i, click, seg, arrayEnumerate(p)), arrayEnumerate(p)) AS lv,
           arrayMax(arrayMap((l, c) -> if(c, 0, least(l, 3)), lv, click)) AS top,
           arrayCount(c -> NOT c, click) AS points
    FROM points AS s LEFT JOIN retrains AS t USING (replay_id, player_id, hero_slot)
),
facts AS (
    SELECT ok.replay_id AS replay_id, ok.player AS player,
           maxIf(top, ability_id = 'AUsl') AS sleep, maxIf(points, ability_id = 'AUsl') AS sleep_points,
           maxIf(top, ability_id = 'AEsh') AS strike, maxIf(points, ability_id = 'AEsh') AS strike_points,
           sleep >= 3 OR strike = 3 AS holds,
           multiIf(startsWith(replay_id, '00541507') OR startsWith(replay_id, '3da49f4b'), 'named',
                   sleep_points >= 3 AND sleep < 3, 'Sleep points across a retrain', sleep >= 3, 'Sleep level 3', sleep > 0, 'Sleep below 3',
                   strike_points > 3, 'Shadow Strike past level 3', strike = 3, 'Shadow Strike level 3', strike > 0, 'Shadow Strike below 3',
                   'neither') AS kind
    FROM ok LEFT JOIN skills USING (replay_id, player_id)
    GROUP BY ok.replay_id, ok.player
),
chosen AS (
    SELECT replay_id FROM (
        SELECT replay_id, kind, row_number() OVER (PARTITION BY kind ORDER BY cityHash64(replay_id)) AS n FROM facts)
    WHERE kind = 'named' OR n <= multiIf(kind = 'neither', 0, endsWith(kind, 'below 3'), 1, 2)
)
SELECT toJSONString(arraySort(groupUniqArray(replay_id))) AS replay_ids,
       toJSONString(arraySort(groupArrayIf((replay_id, player), holds))) AS matches,
       countIf(holds) AS games
FROM facts WHERE replay_id IN (SELECT replay_id FROM chosen)
