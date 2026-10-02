-- Returns each 1on1 replay whose two players were given the same start location.
SELECT a.replay_id AS replay_id
FROM {{ ref('player_starts') }} AS a
INNER JOIN {{ ref('player_starts') }} AS b ON b.replay_id = a.replay_id AND b.player_id > a.player_id
WHERE a.start_x = b.start_x AND a.start_y = b.start_y
