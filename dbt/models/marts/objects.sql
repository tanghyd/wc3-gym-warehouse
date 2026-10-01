-- One row per object a step picker lists: its picker kind, its name, the source it comes
-- from and that source's race. Units, mercenaries, upgrades, heroes and items come from the
-- object_sources seed; a skill comes under the hero that learns it, a building under its race.
-- race is '' for a neutral source (Tavern, camp, neutral shop, neutral hero), which every race uses.
{{ config(order_by='(kind, source_code, code)') }}

SELECT
    toLowCardinality(s.kind)                                    AS kind,
    s.code                                                      AS code,
    m.name                                                      AS name,
    s.source_code                                               AS source_code,
    s.source_name                                               AS source_name,
    toLowCardinality(transform(substring(s.source_code, 1, 1), ['h', 'o', 'e', 'u'], ['HU', 'OC', 'NE', 'UD'], '')) AS race
FROM {{ ref('object_sources') }} AS s
LEFT JOIN {{ ref('mappings') }} AS m ON m.code = s.code AND m.kind = if(s.kind = 'hired', 'unit', s.kind)

UNION ALL

SELECT
    toLowCardinality('skill'), sk.code, sk.name, h.code, h.name,
    toLowCardinality(transform(substring(h.code, 1, 1), ['H', 'O', 'E', 'U'], ['HU', 'OC', 'NE', 'UD'], ''))
FROM {{ ref('mappings') }} AS sk
INNER JOIN {{ ref('mappings') }} AS h ON h.kind = 'hero' AND h.name = sk.hero
WHERE sk.kind = 'hero_skill'

UNION ALL

SELECT
    toLowCardinality('building'), b.code, b.name,
    transform(b.race, ['human', 'orc', 'night_elf', 'undead'], ['HU', 'OC', 'NE', 'UD'], '') AS race_code,
    transform(b.race, ['human', 'orc', 'night_elf', 'undead'], ['Human', 'Orc', 'Night Elf', 'Undead'], ''),
    toLowCardinality(race_code)
FROM {{ ref('mappings') }} AS b
WHERE b.kind = 'building' AND b.race IN ('human', 'orc', 'night_elf', 'undead')
