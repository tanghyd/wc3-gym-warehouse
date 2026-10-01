-- Returns each event more than 5 s after the replay header's duration.
{{ config(severity='warn') }}

SELECT e.replay_id, e.player_id, e.event_type, e.subject_code, e.time_ms, r.duration_ms
FROM {{ ref('replay_events') }} AS e
INNER JOIN {{ ref('replays') }} AS r ON r.replay_id = e.replay_id
WHERE e.time_ms > r.duration_ms + 5000
