-- Built Stronghold and no Barracks before it, picked Orc: some Stronghold order with no Barracks order before it.
WITH
-- player-games of a picked OC in games that arrived as one file and where both players gave orders
ok AS (
    SELECT replay_id, player_id, player FROM w3g.player_games
    WHERE race = 'OC' AND random = 0
      AND replay_id IN (SELECT replay_id FROM w3g.replays WHERE game_key IN (SELECT game_key FROM w3g.replays GROUP BY game_key HAVING count() = 1))
      AND replay_id IN (SELECT replay_id FROM w3g.player_order_events GROUP BY replay_id HAVING uniqExact(player_id) = 2)
),
str AS (SELECT replay_id, player_id, arraySort(groupArray(time_ms)) AS t FROM w3g.player_order_events
       WHERE kind = 'building' AND object_code = 'ostr' GROUP BY replay_id, player_id),
bar AS (SELECT replay_id, player_id, arraySort(groupArray(time_ms)) AS t FROM w3g.player_order_events
       WHERE kind = 'building' AND object_code = 'obar' GROUP BY replay_id, player_id),
facts AS (
    SELECT ok.replay_id AS replay_id, ok.player AS player,
           notEmpty(str.t) AND arrayExists(e -> arrayCount(b -> b < e, bar.t) = 0, str.t) AS holds,
           multiIf(empty(str.t), 'no Stronghold', holds, 'Stronghold first', 'Barracks first') AS kind
    FROM ok LEFT JOIN str USING (replay_id, player_id) LEFT JOIN bar USING (replay_id, player_id)
),
chosen AS (
    SELECT replay_id FROM (
        SELECT replay_id, kind, row_number() OVER (PARTITION BY kind ORDER BY cityHash64(replay_id)) AS n FROM facts)
    WHERE n <= if(kind = 'no Stronghold', 2, 4)
)
SELECT toJSONString(arraySort(groupUniqArray(replay_id))) AS replay_ids,
       toJSONString(arraySort(groupArrayIf((replay_id, player), holds))) AS matches,
       countIf(holds) AS games
FROM facts WHERE replay_id IN (SELECT replay_id FROM chosen)
