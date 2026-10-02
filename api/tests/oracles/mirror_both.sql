-- Ordered an Ancient of Wonders by 6:00, picked Night Elf against picked Night Elf, the Opponent with no
-- step: a game counts once. When both players ordered one, either can sit on the Player side, so the
-- game is one row, shown from the lower player slot and marked both, and adds no win or loss.
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
-- each player's result from his team and the replay's winning team, read apart from player_games
results AS (
    SELECT p.replay_id AS replay_id, p.player_id AS player_id,
           multiIf(r.winning_team_id < 0, 'unknown', p.team_id = r.winning_team_id, 'win', 'loss') AS result
    FROM w3g.replay_players AS p INNER JOIN w3g.replays AS r ON r.replay_id = p.replay_id
),
-- per game: how many of its players hold, and the lower player slot of those who do (one sample a slot)
per_game AS (
    SELECT replay_id, countIf(holds) AS n, argMinIf(player, player_id, holds) AS shown, minIf(player_id, holds) AS slot,
           argMinIf(result, player_id, holds) AS shown_result
    FROM facts LEFT JOIN results USING (replay_id, player_id) GROUP BY replay_id
),
chosen AS (
    SELECT replay_id FROM (
        SELECT replay_id, n, slot, row_number() OVER (PARTITION BY n, slot ORDER BY cityHash64(replay_id)) AS k FROM per_game)
    WHERE k <= multiIf(n = 2, 4, n = 1, 2, 3)
)
SELECT toJSONString(arraySort(groupArray(replay_id))) AS replay_ids,
       toJSONString(arraySort(groupArrayIf((replay_id, shown), n > 0))) AS matches,
       toJSONString(arraySort(groupArrayIf(replay_id, n = 2))) AS both,
       countIf(n > 0) AS games,
       toJSONString(arraySort(groupArrayIf(replay_id, n > 0 AND shown_result = 'win'))) AS won,
       -- a game where both players hold adds no win or loss: either can sit on the Player side
       countIf(n = 1 AND shown_result = 'win') AS wins, countIf(n = 1 AND shown_result = 'loss') AS losses,
       -- the scope: the picked games with a Night Elf against a Night Elf, and those that seat one player only (a record needs one)
       (SELECT uniqExact(replay_id) FROM ok WHERE replay_id IN (SELECT replay_id FROM chosen)) AS scope_games,
       (SELECT countIf(c = 1) FROM (SELECT replay_id, count() AS c FROM ok WHERE replay_id IN (SELECT replay_id FROM chosen) GROUP BY replay_id)) AS scope_one_way
FROM per_game WHERE replay_id IN (SELECT replay_id FROM chosen)
