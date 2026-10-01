-- Returns each replay whose winning_team_id does not follow its result_source: replay
-- keeps the recorded winner, last_actor names the 1on1 player whose last command came
-- strictly later (both players gave one), unknown is -1.
WITH last AS (
    SELECT replay_id,
           argMax(team_id, last_action_ms) AS latest_team,
           max(last_action_ms)             AS latest_ms,
           min(last_action_ms)             AS earliest_ms,
           count()                         AS players
    FROM {{ ref('replay_players') }}
    GROUP BY replay_id
)
SELECT r.replay_id, r.type, r.result_source, r.recorded_winning_team_id, r.winning_team_id,
       l.latest_team, l.latest_ms, l.earliest_ms
FROM {{ ref('replays') }} AS r
INNER JOIN last AS l ON l.replay_id = r.replay_id
WHERE multiIf(
    r.result_source = 'replay', r.recorded_winning_team_id < 0 OR r.winning_team_id != r.recorded_winning_team_id,
    r.result_source = 'last_actor', r.recorded_winning_team_id >= 0 OR r.type != '1on1' OR l.players != 2
        OR l.earliest_ms = 0 OR l.latest_ms = l.earliest_ms OR r.winning_team_id != l.latest_team,
    r.winning_team_id != -1)
