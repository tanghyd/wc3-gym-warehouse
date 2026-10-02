-- Returns each map of the start_locations seed with a row count other than 2 or 4.
SELECT map, count() AS starts
FROM {{ ref('start_locations') }}
GROUP BY map
HAVING starts NOT IN (2, 4)
