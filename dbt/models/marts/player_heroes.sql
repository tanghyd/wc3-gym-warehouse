-- Each hero a player owned at the end, in the order the parser lists them.
-- trained_ms is the hero's training order: the player's last order of its code at
-- or before its first skill point, so a cancelled order leaves no mark. A hero
-- with no such order (no hero code) takes its first skill point.
{{ config(order_by='(replay_id, player_id, hero_slot)') }}

WITH
heroes AS (
    SELECT
        r.replay_id                                AS replay_id,
        toUInt8(JSONExtractUInt(p, 'id'))          AS player_id,
        toUInt8(h_idx - 1)                         AS hero_slot,
        toLowCardinality(JSONExtractString(h, 'id')) AS hero_id,
        toUInt8(JSONExtractUInt(h, 'level'))       AS final_level
    FROM {{ ref('valid_replays') }} AS r
    ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
    ARRAY JOIN
        JSONExtractArrayRaw(p, 'heroes')                 AS h,
        arrayEnumerate(JSONExtractArrayRaw(p, 'heroes')) AS h_idx
),
first_skill AS (
    SELECT replay_id, player_id, hero_slot, min(time_ms) AS time_ms
    FROM {{ ref('hero_ability_events') }}
    GROUP BY replay_id, player_id, hero_slot
),
-- hero orders sit in the parser's unknown list under the hero's code
orders AS (
    SELECT replay_id, player_id, object_code, groupArray(time_ms) AS times
    FROM {{ ref('player_order_events') }}
    WHERE kind = 'unknown' AND is_repeat = 0
    GROUP BY replay_id, player_id, object_code
)
SELECT
    h.replay_id                                    AS replay_id,
    h.player_id                                    AS player_id,
    h.hero_slot                                    AS hero_slot,
    h.hero_id                                      AS hero_id,
    h.final_level                                  AS final_level,
    toUInt32(if(empty(arrayFilter(t -> t <= f.time_ms, o.times)), f.time_ms,
                arrayMax(arrayFilter(t -> t <= f.time_ms, o.times)))) AS trained_ms
FROM heroes AS h
LEFT JOIN first_skill AS f ON f.replay_id = h.replay_id AND f.player_id = h.player_id AND f.hero_slot = h.hero_slot
LEFT JOIN orders AS o ON o.replay_id = h.replay_id AND o.player_id = h.player_id AND o.object_code = h.hero_id
