-- Returns each replay with winner names but no winning team, or a winning team with no names:
-- the two columns are one fact and must agree.
SELECT replay_id, winning_team_id, winner_names
FROM {{ ref('replays') }}
WHERE (winning_team_id >= 0) != (winner_names != '')
