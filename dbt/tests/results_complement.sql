-- Returns each 1v1 game whose two player_games rows do not hold one win and one loss, or two
-- unknowns: the result is one game fact seen from two seats, so anything else is a bug in
-- replays.winning_team_id or in the result column.
SELECT replay_id, groupArray(result) AS results
FROM {{ ref('player_games') }}
GROUP BY replay_id
HAVING arraySort(results) NOT IN (['loss', 'win'], ['unknown', 'unknown'])
