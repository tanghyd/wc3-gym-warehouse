-- Every order a player gave, one row each: buildings, units, items, upgrades,
-- and the parser's `unknown` bucket (rawcodes in no melee table, such as hero
-- training and custom-map objects). Orders are commands, so a repeat click is a
-- second row. `seq` numbers the orders within one (replay, player, kind).
-- x and y are the map point of a building placement, NULL on every other order.
-- is_repeat is 1 on a tier hall, research (R...) or hero order under 1000 ms after
-- the player's previous order of the same code (docs/design/api.md "Repeat flag").
{{ config(order_by='(replay_id, player_id, time_ms, kind, object_code, seq)') }}

WITH orders AS (
    SELECT
        r.replay_id                                   AS replay_id,
        toUInt8(JSONExtractUInt(p, 'id'))             AS player_id,
        toLowCardinality(k.1)                         AS kind,
        toLowCardinality(JSONExtractString(o, 'id'))  AS object_code,
        toUInt32(JSONExtractUInt(o, 'ms'))            AS time_ms,
        toUInt32(o_idx)                               AS seq,
        JSONExtract(o, 'x', 'Nullable(Float32)')      AS x,
        JSONExtract(o, 'y', 'Nullable(Float32)')      AS y
    FROM {{ ref('valid_replays') }} AS r
    ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
    -- (kind, the player key that holds its orders)
    ARRAY JOIN [('building', 'buildings'), ('unit', 'units'), ('item', 'items'),
                ('upgrade', 'upgrades'), ('unknown', 'unknown')] AS k
    ARRAY JOIN
        JSONExtractArrayRaw(JSONExtractRaw(p, k.2), 'order')                 AS o,
        arrayEnumerate(JSONExtractArrayRaw(JSONExtractRaw(p, k.2), 'order')) AS o_idx
)
SELECT
    *,
    toUInt8(
        (object_code IN ('hkee', 'hcas', 'ostr', 'ofrt', 'unp1', 'unp2', 'etoa', 'etoe')
            OR startsWith(object_code, 'R')
            OR object_code IN (SELECT code FROM {{ ref('mappings') }} WHERE kind = 'hero'))
        -- the first order of a code has no previous one: NULL, so 0
        AND ifNull(time_ms - lagInFrame(toNullable(time_ms)) OVER same_code < 1000, 0)
    ) AS is_repeat
FROM orders
WINDOW same_code AS (PARTITION BY replay_id, player_id, kind, object_code ORDER BY time_ms, seq
                     ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)
