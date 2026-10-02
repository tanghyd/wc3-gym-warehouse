-- Every hero skill point spent. `value` is sometimes a string (the ability code)
-- and sometimes a number, so the raw JSON is unquoted to flatten both.
-- event_type is `ability`, or `retraining` with an empty ability_id.
-- is_repeat is 1 on a skill point under 1000 ms after the hero's previous point in that skill.
{{ config(order_by='(replay_id, player_id, hero_slot, time_ms, seq)') }}

WITH skills AS (
    SELECT
        r.replay_id                                       AS replay_id,
        toUInt8(JSONExtractUInt(p, 'id'))                 AS player_id,
        toUInt8(h_idx - 1)                                AS hero_slot,
        toLowCardinality(JSONExtractString(h, 'id'))      AS hero_id,
        toLowCardinality(JSONExtractString(ev, 'type'))   AS event_type,
        toLowCardinality(trim(BOTH '"' FROM JSONExtractRaw(ev, 'value'))) AS ability_id,
        toUInt32(JSONExtractUInt(ev, 'time'))             AS time_ms,
        toUInt32(ev_idx)                                  AS seq
    FROM {{ ref('raw_replays') }} AS r
    ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
    ARRAY JOIN
        JSONExtractArrayRaw(p, 'heroes')                 AS h,
        arrayEnumerate(JSONExtractArrayRaw(p, 'heroes')) AS h_idx
    ARRAY JOIN
        JSONExtractArrayRaw(h, 'abilityOrder')                 AS ev,
        arrayEnumerate(JSONExtractArrayRaw(h, 'abilityOrder')) AS ev_idx
)
SELECT
    *,
    toUInt8(event_type = 'ability'
        -- the first point of a skill has no previous one: NULL, so 0
        AND ifNull(time_ms - lagInFrame(toNullable(time_ms)) OVER same_skill < 1000, 0)) AS is_repeat
FROM skills
WINDOW same_skill AS (PARTITION BY replay_id, player_id, hero_slot, event_type, ability_id ORDER BY time_ms, seq
                      ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)
-- raw_replays keeps a replaced document until a merge, so read it deduplicated.
SETTINGS final = 1
