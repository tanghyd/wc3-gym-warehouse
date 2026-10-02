-- Returns each game_key without exactly one replay that stands for it, and each
-- duplicate whose duplicate_of is not that replay.
SELECT game_key, '' AS replay_id, concat(toString(countIf(duplicate_of = '')), ' copies stand for it') AS problem
FROM {{ ref('replays') }}
GROUP BY game_key
HAVING countIf(duplicate_of = '') != 1
UNION ALL
SELECT d.game_key, d.replay_id, 'points elsewhere' AS problem
FROM {{ ref('replays') }} AS d
LEFT JOIN (SELECT game_key, replay_id FROM {{ ref('replays') }} WHERE duplicate_of = '') AS g
    ON g.game_key = d.game_key
WHERE d.duplicate_of != '' AND d.duplicate_of != g.replay_id
