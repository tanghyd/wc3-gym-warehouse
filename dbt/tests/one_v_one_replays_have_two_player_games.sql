-- Returns each 1on1 replay that stands for its game without exactly two player_games
-- rows, each duplicate replay with any row, and any replay with a count other than two.
SELECT replay_id, 'missing' AS problem
FROM {{ ref('replays') }}
WHERE type = '1on1' AND duplicate_of = ''
  AND replay_id NOT IN (
      SELECT replay_id FROM {{ ref('player_games') }} GROUP BY replay_id HAVING count() = 2)
UNION ALL
SELECT replay_id, 'duplicate has rows' AS problem
FROM {{ ref('replays') }}
WHERE duplicate_of != ''
  AND replay_id IN (SELECT replay_id FROM {{ ref('player_games') }})
UNION ALL
SELECT replay_id, concat(toString(count()), ' rows') AS problem
FROM {{ ref('player_games') }}
GROUP BY replay_id
HAVING count() != 2
