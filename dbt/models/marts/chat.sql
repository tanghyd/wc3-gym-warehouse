-- In-game chat. Two players can talk on the same ms tick, so `seq` keeps order.
{{ config(order_by='(replay_id, time_ms, seq)') }}

SELECT
    r.replay_id                                  AS replay_id,
    toUInt8(JSONExtractUInt(c, 'playerId'))      AS player_id,
    JSONExtractString(c, 'playerName')           AS player_name,
    toLowCardinality(JSONExtractString(c, 'mode')) AS mode,
    JSONExtractString(c, 'message')              AS message,
    toUInt32(JSONExtractUInt(c, 'timeMS'))       AS time_ms,
    toUInt32(c_idx)                              AS seq
FROM {{ ref('valid_replays') }} AS r
ARRAY JOIN
    JSONExtractArrayRaw(r.doc, 'chat')                 AS c,
    arrayEnumerate(JSONExtractArrayRaw(r.doc, 'chat')) AS c_idx
