-- Games, mirrors, wins and losses by race over three games: a Night Elf mirror, Human against Night
-- Elf and Orc against Undead. A game counts once in a row. The mirror's two players both fall in the
-- NE row: one game there, a mirror, with no win or loss. Each other game counts once in each of its
-- two rows with that player's result. apm_players counts every player of a row.
-- The mirror is picked with its lower player slot losing, so reading either of its players changes the row.
WITH
players AS (
    SELECT p.replay_id AS replay_id, p.player_id AS player_id, p.race AS race, p.random AS random,
           multiIf(r.winning_team_id < 0, 'unknown', p.team_id = r.winning_team_id, 'win', 'loss') AS result
    FROM w3g.replay_players AS p INNER JOIN w3g.replays AS r ON r.replay_id = p.replay_id
),
games AS (
    SELECT replay_id, arraySort(groupArray(race)) AS races, argMin(result, player_id) AS low_result
    FROM players GROUP BY replay_id HAVING count() = 2 AND max(random) = 0 AND countIf(result = 'win') = 1
),
chosen AS (
    SELECT replay_id FROM (
        SELECT replay_id, races, low_result, row_number() OVER (PARTITION BY races ORDER BY cityHash64(replay_id, 'query')) AS k
        FROM games WHERE (races = ['NE', 'NE'] AND low_result = 'loss') OR races IN (['HU', 'NE'], ['OC', 'UD']))
    WHERE k = 1
),
-- per game in a race row: its players there, and the result when it has one player there
seated AS (
    SELECT race, replay_id, count() AS players, if(count() = 1, any(result), '') AS result
    FROM players WHERE replay_id IN (SELECT replay_id FROM chosen) GROUP BY race, replay_id
)
SELECT (SELECT toJSONString(arraySort(groupArray(replay_id))) FROM chosen) AS replay_ids,
       toJSONString(groupArray(map('race', race, 'games', toString(games), 'mirrors', toString(mirrors), 'wins', toString(wins),
                                   'losses', toString(losses), 'apm_players', toString(apm_players)))) AS rows
FROM (
    SELECT race, count() AS games, countIf(players = 2) AS mirrors, countIf(result = 'win') AS wins,
           countIf(result = 'loss') AS losses, sum(players) AS apm_players
    FROM seated GROUP BY race ORDER BY race
)
