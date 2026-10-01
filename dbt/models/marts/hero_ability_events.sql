-- Every hero skill point spent. `value` is sometimes a string (the ability code)
-- and sometimes a number, so the raw JSON is unquoted to flatten both.
-- event_type is `ability`, or `retraining` with an empty ability_id.
{{ config(order_by='(replay_id, player_id, hero_slot, time_ms, seq)') }}

SELECT
    r.replay_id                                       AS replay_id,
    toUInt8(JSONExtractUInt(p, 'id'))                 AS player_id,
    toUInt8(h_idx - 1)                                AS hero_slot,
    JSONExtractString(h, 'id')                        AS hero_id,
    JSONExtractString(ev, 'type')                     AS event_type,
    trim(BOTH '"' FROM JSONExtractRaw(ev, 'value'))   AS ability_id,
    toUInt32(JSONExtractUInt(ev, 'time'))             AS time_ms,
    toUInt32(ev_idx)                                  AS seq,
    {{ gnl_race("JSONExtractString(p, 'race')") }} AS race,
    JSONExtractString(r.doc, 'matchup')               AS matchup
FROM {{ ref('raw_replays') }} AS r
ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
ARRAY JOIN
    JSONExtractArrayRaw(p, 'heroes')                 AS h,
    arrayEnumerate(JSONExtractArrayRaw(p, 'heroes')) AS h_idx
ARRAY JOIN
    JSONExtractArrayRaw(h, 'abilityOrder')                 AS ev,
    arrayEnumerate(JSONExtractArrayRaw(h, 'abilityOrder')) AS ev_idx
