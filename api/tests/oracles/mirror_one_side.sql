-- Ordered an Ancient of Wonders by 6:00 against a player who did not, picked Night Elf against picked
-- Night Elf: the sides differ, so only one seating of a game can fit. A game matches when exactly one
-- player ordered one, shown from that player, and is never marked both.
WITH
ok AS (
    SELECT replay_id, player_id, player FROM w3g.player_games
    WHERE race = 'NE' AND random = 0 AND opponent_race = 'NE' AND opponent_random = 0
),
facts AS (
    SELECT ok.replay_id AS replay_id, ok.player_id AS player_id, ok.player AS player,
           countIf(e.kind = 'building' AND e.object_code = 'eden' AND e.time_ms <= 360000) > 0 AS holds
    FROM ok INNER JOIN w3g.player_order_events AS e ON e.replay_id = ok.replay_id AND e.player_id = ok.player_id
    GROUP BY ok.replay_id, ok.player_id, ok.player
),
-- per game: how many of its players hold, and the one who does
per_game AS (
    SELECT replay_id, countIf(holds) AS n, argMinIf(player, player_id, holds) AS shown, minIf(player_id, holds) AS slot
    FROM facts GROUP BY replay_id
),
chosen AS (
    SELECT replay_id FROM (
        SELECT replay_id, n, slot, row_number() OVER (PARTITION BY n, slot ORDER BY cityHash64(replay_id, 'one side')) AS k FROM per_game)
    WHERE k <= multiIf(n = 1, 3, 2)
)
SELECT toJSONString(arraySort(groupArray(replay_id))) AS replay_ids,
       toJSONString(arraySort(groupArrayIf((replay_id, shown), n = 1))) AS matches,
       countIf(n = 1) AS games
FROM per_game WHERE replay_id IN (SELECT replay_id FROM chosen)
