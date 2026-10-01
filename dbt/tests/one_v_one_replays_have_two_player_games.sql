-- Returns each 1on1 replay without exactly two player_games rows, and any
-- player_games replay with a row count other than two.
SELECT replay_id, 'missing' AS problem
FROM {{ ref('replays') }}
WHERE type = '1on1'
  AND replay_id NOT IN (
      SELECT replay_id FROM {{ ref('player_games') }} GROUP BY replay_id HAVING count() = 2)
UNION ALL
SELECT replay_id, concat(toString(count()), ' rows') AS problem
FROM {{ ref('player_games') }}
GROUP BY replay_id
HAVING count() != 2
