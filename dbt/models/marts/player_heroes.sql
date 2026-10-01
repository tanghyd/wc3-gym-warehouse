-- Each hero a player owned at the end, in the order the parser lists them.
{{ config(order_by='(replay_id, player_id, hero_slot)') }}

SELECT
    r.replay_id                                AS replay_id,
    toUInt8(JSONExtractUInt(p, 'id'))          AS player_id,
    toUInt8(h_idx - 1)                         AS hero_slot,
    toLowCardinality(JSONExtractString(h, 'id')) AS hero_id,
    toUInt8(JSONExtractUInt(h, 'level'))       AS final_level
FROM {{ ref('raw_replays') }} AS r
ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
ARRAY JOIN
    JSONExtractArrayRaw(p, 'heroes')                 AS h,
    arrayEnumerate(JSONExtractArrayRaw(p, 'heroes')) AS h_idx
