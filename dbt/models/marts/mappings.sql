-- WC3 object codes and their names: the parser's melee tables (seed regenerated
-- by `just mappings`) plus the hand-kept custom-map names.
{{ config(order_by='code') }}

SELECT code, name, kind, race, hero, is_supply_building, '' AS category
FROM {{ ref('mappings_melee') }}
UNION ALL
SELECT code, name, kind, '' AS race, '' AS hero, toUInt8(0) AS is_supply_building, category
FROM {{ ref('mappings_custom') }}
