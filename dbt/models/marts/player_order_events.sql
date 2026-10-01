-- Every order a player gave, one row each: buildings, units, items, upgrades,
-- and the parser's `unknown` bucket (rawcodes in no melee table, such as hero
-- training and custom-map objects). Orders are commands, so a repeat click is a
-- second row. `seq` numbers the orders within one (replay, player, kind).
{{ config(order_by='(replay_id, player_id, time_ms, kind, object_code, seq)') }}

SELECT
    r.replay_id                                   AS replay_id,
    toUInt8(JSONExtractUInt(p, 'id'))             AS player_id,
    k.1                                           AS kind,
    JSONExtractString(o, 'id')                    AS object_code,
    toUInt32(JSONExtractUInt(o, 'ms'))            AS time_ms,
    toUInt32(o_idx)                               AS seq,
    {{ gnl_race("JSONExtractString(p, 'race')") }} AS race,
    JSONExtractString(r.doc, 'matchup')           AS matchup
FROM {{ ref('raw_replays') }} AS r
ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
-- (kind, the player key that holds its orders)
ARRAY JOIN [('building', 'buildings'), ('unit', 'units'), ('item', 'items'),
            ('upgrade', 'upgrades'), ('unknown', 'unknown')] AS k
ARRAY JOIN
    JSONExtractArrayRaw(JSONExtractRaw(p, k.2), 'order')                 AS o,
    arrayEnumerate(JSONExtractArrayRaw(JSONExtractRaw(p, k.2), 'order')) AS o_idx
