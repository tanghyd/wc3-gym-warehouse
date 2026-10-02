-- WC3 object codes and their names: the parser's melee tables (seed regenerated
-- by `just mappings`) plus the hand-kept custom-map names.
-- The parser's tables give ohun and otbk one name, nanb and nanm another, and
-- hmtt and hrtt (the Siege Engine after Barrage) a third; the melee part names them apart.
{{ config(order_by='code') }}

SELECT
    code,
    transform(code, ['ohun', 'otbk', 'nanm', 'hrtt'],
              ['Troll Headhunter', 'Troll Berserker', 'Barbed Arachnathid (mercenary)', 'Siege Engine (Barrage)'], name) AS name,
    toLowCardinality(kind)     AS kind,
    toLowCardinality(race)     AS race,
    toLowCardinality(hero)     AS hero,
    is_supply_building,
    toLowCardinality('')       AS category
FROM {{ ref('mappings_melee') }}
UNION ALL
SELECT
    code,
    name,
    toLowCardinality(kind)     AS kind,
    toLowCardinality('')       AS race,
    toLowCardinality('')       AS hero,
    toUInt8(0)                 AS is_supply_building,
    toLowCardinality(category) AS category
FROM {{ ref('mappings_custom') }}
