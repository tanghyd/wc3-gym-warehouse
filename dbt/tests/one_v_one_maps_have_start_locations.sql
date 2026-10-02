-- Returns each map of a 1on1 replay with no row in the start_locations seed: player_starts
-- joins the seed, so every player on such a map gets start 'none' without an error.
{{ config(severity='warn') }}
SELECT map, count() AS replays
FROM {{ ref('replays') }}
WHERE type = '1on1' AND map NOT IN (SELECT map FROM {{ ref('start_locations') }})
GROUP BY map
