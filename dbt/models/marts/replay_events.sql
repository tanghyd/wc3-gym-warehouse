-- Every ordered object and hero skill as one time-ordered stream per player, the
-- table build-order sequences match against. event_type is the order kind
-- (building, unit, item, upgrade, unknown), hero_skill, or hero_trained: the
-- first skill point of a hero, which lands within a second of its summon.
-- The sort key leads with what a sequence filter names (race, type, object).
{{ config(order_by='(race, event_type, subject_code, replay_id, player_id, time_ms, seq)') }}

SELECT
    o.race                                        AS race,
    o.matchup                                     AS matchup,
    o.replay_id                                   AS replay_id,
    o.player_id                                   AS player_id,
    o.time_ms                                     AS time_ms,
    o.kind                                        AS event_type,
    o.object_code                                 AS subject_code,
    coalesce(nullIf(m.name, ''), o.object_code)   AS subject_name,
    ''                                            AS detail,
    o.seq                                         AS seq
FROM {{ ref('player_order_events') }} AS o
-- Join on (code, kind) so a code listed under two kinds cannot double a row.
LEFT JOIN {{ ref('mappings') }} AS m ON m.code = o.object_code AND m.kind = o.kind

UNION ALL

SELECT
    h.race, h.matchup, h.replay_id, h.player_id, h.time_ms,
    'hero_skill'                                  AS event_type,
    h.ability_id                                  AS subject_code,
    coalesce(nullIf(ma.name, ''), h.ability_id)   AS subject_name,
    coalesce(nullIf(mh.name, ''), h.hero_id)      AS detail,
    h.seq                                         AS seq
FROM {{ ref('hero_ability_events') }} AS h
LEFT JOIN {{ ref('mappings') }} AS ma ON ma.code = h.ability_id AND ma.kind = 'hero_skill'
LEFT JOIN {{ ref('mappings') }} AS mh ON mh.code = h.hero_id AND mh.kind = 'hero'

UNION ALL

SELECT
    f.race, f.matchup, f.replay_id, f.player_id, f.time_ms,
    'hero_trained'                                AS event_type,
    f.hero_id                                     AS subject_code,
    coalesce(nullIf(mh.name, ''), f.hero_id)      AS subject_name,
    ''                                            AS detail,
    toUInt32(0)                                   AS seq
FROM (
    SELECT replay_id, player_id, hero_id, race, matchup, min(time_ms) AS time_ms
    FROM {{ ref('hero_ability_events') }}
    GROUP BY replay_id, player_id, hero_id, race, matchup
) AS f
LEFT JOIN {{ ref('mappings') }} AS mh ON mh.code = f.hero_id AND mh.kind = 'hero'
