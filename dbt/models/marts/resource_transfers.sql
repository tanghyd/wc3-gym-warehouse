-- Gold and lumber sent between allies. Field names vary across parser output
-- shapes: prefer toPlayerId/ms, fall back to recipient/time.
{{ config(order_by='(replay_id, time_ms, seq, from_player_id)') }}

SELECT
    r.replay_id                                              AS replay_id,
    toUInt8(JSONExtractUInt(p, 'id'))                        AS from_player_id,
    toUInt8(coalesce(JSONExtract(t, 'toPlayerId', 'Nullable(UInt8)'),
                     JSONExtractUInt(t, 'recipient')))       AS to_player_id,
    toInt32(JSONExtractInt(t, 'gold'))                       AS gold,
    toInt32(JSONExtractInt(t, 'lumber'))                     AS lumber,
    toUInt32(coalesce(JSONExtract(t, 'ms', 'Nullable(UInt32)'),
                      JSONExtractUInt(t, 'time')))           AS time_ms,
    toUInt32(t_idx)                                          AS seq
FROM {{ ref('raw_replays') }} AS r
ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
ARRAY JOIN
    JSONExtractArrayRaw(p, 'resourceTransfers')                 AS t,
    arrayEnumerate(JSONExtractArrayRaw(p, 'resourceTransfers')) AS t_idx
