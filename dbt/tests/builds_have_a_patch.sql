-- Returns each build number with replays but no row in the patches seed.
{{ config(severity='warn') }}

SELECT build_number, count() AS replays
FROM {{ ref('replays') }}
WHERE patch = ''
GROUP BY build_number
