-- WC3 object codes and their names: the parser's melee tables (seed regenerated
-- by `just mappings`) plus the hand-kept custom-map names.
{{ config(order_by='code') }}

SELECT
    code,
    name,
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
