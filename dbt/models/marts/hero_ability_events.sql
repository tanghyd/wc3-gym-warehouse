-- Every hero skill point spent. `value` is sometimes a string (the ability code)
-- and sometimes a number, so the raw JSON is unquoted to flatten both.
-- event_type is `ability`, or `retraining` with an empty ability_id.
-- level is the skill's level after the point: the hero's points in that skill since his last retraining, repeat clicks left out (0 on a retraining).
-- is_repeat is 1 on a point the game did not take: under 1000 ms after the hero's previous point in that skill, or past level 3.
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
    FROM {{ ref('valid_replays') }} AS r
    ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
    ARRAY JOIN
        JSONExtractArrayRaw(p, 'heroes')                 AS h,
        arrayEnumerate(JSONExtractArrayRaw(p, 'heroes')) AS h_idx
    ARRAY JOIN
        JSONExtractArrayRaw(h, 'abilityOrder')                 AS ev,
        arrayEnumerate(JSONExtractArrayRaw(h, 'abilityOrder')) AS ev_idx
),
clicks AS (
    SELECT
        *,
        toUInt8(event_type = 'ability'
            -- the first point of a skill has no previous one: NULL, so 0
            AND ifNull(time_ms - lagInFrame(toNullable(time_ms)) OVER same_skill < 1000, 0)) AS is_click,
        -- a retraining resets every skill, so the hero's retrainings so far name the count a point joins
        countIf(event_type = 'retraining') OVER same_hero AS retrains
    FROM skills
    WINDOW same_skill AS (PARTITION BY replay_id, player_id, hero_slot, event_type, ability_id ORDER BY time_ms, seq
                          ROWS BETWEEN 1 PRECEDING AND CURRENT ROW),
           same_hero AS (PARTITION BY replay_id, player_id, hero_slot ORDER BY time_ms, seq
                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
),
levels AS (
    SELECT
        * EXCEPT (retrains),
        toUInt8(if(event_type = 'ability', countIf(is_click = 0) OVER same_count, 0)) AS level
    FROM clicks
    WINDOW same_count AS (PARTITION BY replay_id, player_id, hero_slot, retrains, event_type, ability_id ORDER BY time_ms, seq
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
)
SELECT
    * EXCEPT (is_click),
    -- a normal skill stops at level 3, so a 4th point is a click the game refused
    toUInt8(is_click OR level > 3) AS is_repeat
FROM levels
