-- Every ordered object and hero skill as one time-ordered stream per player, the
-- table build-order sequences match against. event_type is the order kind
-- (building, unit, item, upgrade, unknown), hero_skill, or hero_trained: the
-- first skill point of a hero, which lands within a second of its summon.
-- race is the player's played race from replay_players.
-- The sort key leads with what a sequence filter names (race, type, object).
{{ config(order_by='(race, event_type, subject_code, replay_id, player_id, time_ms, seq)') }}

SELECT
    p.race          AS race,
    e.replay_id     AS replay_id,
    e.player_id     AS player_id,
    e.time_ms       AS time_ms,
    e.event_type    AS event_type,
    e.subject_code  AS subject_code,
    e.subject_name  AS subject_name,
    e.detail        AS detail,
    e.seq           AS seq
FROM (
    SELECT
        o.replay_id                                   AS replay_id,
        o.player_id                                   AS player_id,
        o.time_ms                                     AS time_ms,
        o.kind                                        AS event_type,
        o.object_code                                 AS subject_code,
        toLowCardinality(coalesce(nullIf(m.name, ''), o.object_code)) AS subject_name,
        toLowCardinality('')                          AS detail,
        o.seq                                         AS seq
    FROM {{ ref('player_order_events') }} AS o
    -- Join on (code, kind) so a code listed under two kinds cannot double a row.
    LEFT JOIN {{ ref('mappings') }} AS m ON m.code = o.object_code AND m.kind = o.kind

    UNION ALL

    SELECT
        h.replay_id, h.player_id, h.time_ms,
        toLowCardinality('hero_skill')                AS event_type,
        h.ability_id                                  AS subject_code,
        toLowCardinality(coalesce(nullIf(ma.name, ''), h.ability_id)) AS subject_name,
        toLowCardinality(coalesce(nullIf(mh.name, ''), h.hero_id)) AS detail,
        h.seq                                         AS seq
    FROM {{ ref('hero_ability_events') }} AS h
    LEFT JOIN {{ ref('mappings') }} AS ma ON ma.code = h.ability_id AND ma.kind = 'hero_skill'
    LEFT JOIN {{ ref('mappings') }} AS mh ON mh.code = h.hero_id AND mh.kind = 'hero'

    UNION ALL

    SELECT
        f.replay_id, f.player_id, f.time_ms,
        toLowCardinality('hero_trained')              AS event_type,
        f.hero_id                                     AS subject_code,
        toLowCardinality(coalesce(nullIf(mh.name, ''), f.hero_id)) AS subject_name,
        toLowCardinality('')                          AS detail,
        toUInt32(0)                                   AS seq
    FROM (
        SELECT replay_id, player_id, hero_id, min(time_ms) AS time_ms
        FROM {{ ref('hero_ability_events') }}
        GROUP BY replay_id, player_id, hero_id
    ) AS f
    LEFT JOIN {{ ref('mappings') }} AS mh ON mh.code = f.hero_id AND mh.kind = 'hero'
) AS e
INNER JOIN {{ ref('replay_players') }} AS p ON p.replay_id = e.replay_id AND p.player_id = e.player_id
