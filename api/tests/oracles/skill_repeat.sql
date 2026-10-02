-- Learned skill Blizzard at level 2, picked Human: two real points with no retraining between them,
-- a repeat click under 1000 ms is no point.
WITH
-- each player of a picked HU in games that arrived as one file and where both players gave orders
ok AS (
    SELECT replay_id, player_id, player FROM w3g.player_games
    WHERE race = 'HU' AND random = 0
      AND replay_id IN (SELECT replay_id FROM w3g.replays WHERE game_key IN (SELECT game_key FROM w3g.replays GROUP BY game_key HAVING count() = 1))
      AND replay_id IN (SELECT replay_id FROM w3g.player_order_events GROUP BY replay_id HAVING uniqExact(player_id) = 2)
),
-- the Archmage's Blizzard points and his retrainings, each as (time_ms, seq)
o AS (SELECT replay_id, player_id, hero_slot, arraySort(groupArray((time_ms, seq))) AS t FROM w3g.hero_ability_events
      WHERE event_type = 'ability' AND ability_id = 'AHbz' GROUP BY replay_id, player_id, hero_slot),
r AS (SELECT replay_id, player_id, hero_slot, groupArray((time_ms, seq)) AS r FROM w3g.hero_ability_events
      WHERE event_type = 'retraining' GROUP BY replay_id, player_id, hero_slot),
-- seg: the retrainings at or before each real point
pts AS (
    SELECT replay_id, player_id, length(t) AS n, arrayFilter((x, i) -> i = 1 OR x.1 - t[i - 1].1 >= 1000, t, arrayEnumerate(t)) AS real,
           arrayMap(x -> arrayCount(y -> y <= x, r), real) AS seg
    FROM o LEFT JOIN r USING (replay_id, player_id, hero_slot)
),
facts AS (
    SELECT ok.replay_id AS replay_id, ok.player AS player, arrayExists(s -> arrayCount(x -> x = s, seg) >= 2, seg) AS holds,
           multiIf(length(real) >= 2, 'two points', n >= 2, 'one point and a repeat click', 'one point') AS kind
    FROM ok INNER JOIN pts USING (replay_id, player_id)
),
chosen AS (
    SELECT replay_id FROM (
        SELECT replay_id, kind, row_number() OVER (PARTITION BY kind ORDER BY cityHash64(replay_id)) AS n FROM facts)
    WHERE n <= if(kind = 'one point', 2, 4)
)
SELECT toJSONString(arraySort(groupUniqArray(replay_id))) AS replay_ids,
       toJSONString(arraySort(groupArrayIf((replay_id, player), holds))) AS matches,
       countIf(holds) AS games
FROM facts WHERE replay_id IN (SELECT replay_id FROM chosen)
