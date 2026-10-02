-- Built Ancient of War x2 exactly, picked Night Elf: two orders and no third.
WITH
-- player-games of a picked NE in games that arrived as one file and where both players gave orders
ok AS (
    SELECT replay_id, player_id, player FROM w3g.player_games
    WHERE race = 'NE' AND random = 0
      AND replay_id IN (SELECT replay_id FROM w3g.replays WHERE game_key IN (SELECT game_key FROM w3g.replays GROUP BY game_key HAVING count() = 1))
      AND replay_id IN (SELECT replay_id FROM w3g.player_order_events GROUP BY replay_id HAVING uniqExact(player_id) = 2)
),
aow AS (SELECT replay_id, player_id, arraySort(groupArray(time_ms)) AS t FROM w3g.player_order_events
       WHERE kind = 'building' AND object_code = 'eaom' GROUP BY replay_id, player_id),
facts AS (
    SELECT ok.replay_id AS replay_id, ok.player AS player, length(aow.t) = 2 AS holds,
           multiIf(holds, 'two', length(aow.t) > 2, 'three or more', 'one') AS kind
    FROM ok INNER JOIN aow USING (replay_id, player_id)
),
chosen AS (
    SELECT replay_id FROM (
        SELECT replay_id, kind, row_number() OVER (PARTITION BY kind ORDER BY cityHash64(replay_id)) AS n FROM facts)
    WHERE n <= if(kind = 'two', 4, 3)
)
SELECT toJSONString(arraySort(groupUniqArray(replay_id))) AS replay_ids,
       toJSONString(arraySort(groupArrayIf((replay_id, player), holds))) AS matches,
       countIf(holds) AS games
FROM facts WHERE replay_id IN (SELECT replay_id FROM chosen)
