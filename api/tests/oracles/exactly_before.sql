-- Built Tree of Ages and exactly one Ancient of War before it, picked Night Elf: some real Tree of Ages order with one Ancient of War order before it.
WITH
-- each player of a picked NE in games that arrived as one file and where both players gave orders
ok AS (
    SELECT replay_id, player_id, player FROM w3g.player_games
    WHERE race = 'NE' AND random = 0
      AND replay_id IN (SELECT replay_id FROM w3g.replays WHERE game_key IN (SELECT game_key FROM w3g.replays GROUP BY game_key HAVING count() = 1))
      AND replay_id IN (SELECT replay_id FROM w3g.player_order_events GROUP BY replay_id HAVING uniqExact(player_id) = 2)
),
toa AS (SELECT replay_id, player_id, arraySort(groupArray(time_ms)) AS t FROM w3g.player_order_events
       WHERE kind = 'building' AND object_code = 'etoa' GROUP BY replay_id, player_id),
aow AS (SELECT replay_id, player_id, arraySort(groupArray(time_ms)) AS t FROM w3g.player_order_events
       WHERE kind = 'building' AND object_code = 'eaom' GROUP BY replay_id, player_id),
facts AS (
    SELECT ok.replay_id AS replay_id, ok.player AS player,
           -- real Tree of Ages orders: the first click, then each click 1000 ms or more after the one before
           arrayExists(e -> arrayCount(a -> a < e, aow.t) = 1,
                       arrayFilter((x, i) -> i = 1 OR x - toa.t[i - 1] >= 1000, toa.t, arrayEnumerate(toa.t))) AS holds,
           multiIf(holds, 'one before', arrayCount(a -> a < toa.t[1], aow.t) >= 2, 'two or more before', 'none before') AS kind
    FROM ok INNER JOIN toa USING (replay_id, player_id) LEFT JOIN aow USING (replay_id, player_id)
),
chosen AS (
    SELECT replay_id FROM (
        SELECT replay_id, kind, row_number() OVER (PARTITION BY kind ORDER BY cityHash64(replay_id)) AS n FROM facts)
    WHERE n <= if(kind = 'none before', 2, 4)
)
SELECT toJSONString(arraySort(groupUniqArray(replay_id))) AS replay_ids,
       toJSONString(arraySort(groupArrayIf((replay_id, player), holds))) AS matches,
       countIf(holds) AS games
FROM facts WHERE replay_id IN (SELECT replay_id FROM chosen)
