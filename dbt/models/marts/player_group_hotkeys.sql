-- How often each control group (0-9) was assigned and used.
{{ config(order_by='(replay_id, player_id, group_key)') }}

SELECT
    r.replay_id                                AS replay_id,
    toUInt8(JSONExtractUInt(p, 'id'))          AS player_id,
    toUInt8(kv.1)                              AS group_key,
    toUInt32(JSONExtractUInt(kv.2, 'assigned')) AS assigned,
    toUInt32(JSONExtractUInt(kv.2, 'used'))    AS used
FROM {{ ref('raw_replays') }} AS r
ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
ARRAY JOIN JSONExtractKeysAndValuesRaw(JSONExtractRaw(p, 'groupHotkeys')) AS kv
-- raw_replays keeps a replaced document until a merge, so read it deduplicated.
SETTINGS final = 1
