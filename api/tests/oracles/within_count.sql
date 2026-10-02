-- Built Barracks, then within 1:00 Trained Footman x3, picked Human: all three Footmen inside the minute after one Barracks order.
WITH
-- each player of a picked HU in games that arrived as one file and where both players gave orders
ok AS (
    SELECT replay_id, player_id, player FROM w3g.player_games
    WHERE race = 'HU' AND random = 0
      AND replay_id IN (SELECT replay_id FROM w3g.replays WHERE game_key IN (SELECT game_key FROM w3g.replays GROUP BY game_key HAVING count() = 1))
      AND replay_id IN (SELECT replay_id FROM w3g.player_order_events GROUP BY replay_id HAVING uniqExact(player_id) = 2)
),
bar AS (SELECT replay_id, player_id, arraySort(groupArray(time_ms)) AS t FROM w3g.player_order_events
       WHERE kind = 'building' AND object_code = 'hbar' GROUP BY replay_id, player_id),
foo AS (SELECT replay_id, player_id, arraySort(groupArray(time_ms)) AS t FROM w3g.player_order_events
        WHERE kind = 'unit' AND object_code = 'hfoo' GROUP BY replay_id, player_id),
facts AS (
    SELECT ok.replay_id AS replay_id, ok.player AS player,
           arrayExists(b -> arrayCount(f -> f > b AND f <= b + 60000, foo.t) >= 3, bar.t) AS holds,
           multiIf(holds, 'three in the minute',
                   arrayExists(b -> arrayExists(f -> f > b AND f <= b + 60000, foo.t) AND arrayCount(f -> f > b, foo.t) >= 3, bar.t),
                   'the first in the minute, three later', 'neither') AS kind
    FROM ok INNER JOIN bar USING (replay_id, player_id) INNER JOIN foo USING (replay_id, player_id)
),
chosen AS (
    SELECT replay_id FROM (
        SELECT replay_id, kind, row_number() OVER (PARTITION BY kind ORDER BY cityHash64(replay_id)) AS n FROM facts)
    WHERE n <= if(kind = 'neither', 2, 4)
)
SELECT toJSONString(arraySort(groupUniqArray(replay_id))) AS replay_ids,
       toJSONString(arraySort(groupArrayIf((replay_id, player), holds))) AS matches,
       countIf(holds) AS games
FROM facts WHERE replay_id IN (SELECT replay_id FROM chosen)
