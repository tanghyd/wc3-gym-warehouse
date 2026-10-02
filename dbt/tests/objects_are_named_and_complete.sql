-- Returns each picker object with no name, and each melee skill no hero lists.
SELECT kind, code, 'no name' AS problem
FROM {{ ref('objects') }}
WHERE name = ''
UNION ALL
SELECT 'skill', code, 'no hero' AS problem
FROM {{ ref('mappings') }}
WHERE kind = 'hero_skill' AND code NOT IN (SELECT code FROM {{ ref('objects') }} WHERE kind = 'skill')
