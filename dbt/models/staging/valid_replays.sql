-- One row per loaded replay of a valid game: raw_replays read FINAL (merged by version), without any
-- game in which a player gave no order. Every mart reads replays from here, so no mart,
-- count or search sees such a game. Grafana still counts every loaded replay.
-- events counts the orders and skill points of all players; replays ranks the copies of
-- one game by it.
{{ config(materialized='view') }}

WITH
    JSONExtractArrayRaw(doc, 'players') AS players,
    -- each player's orders: the lists player_order_events flattens
    arrayMap(p -> length(JSONExtractArrayRaw(p, 'buildings', 'order')) + length(JSONExtractArrayRaw(p, 'units', 'order'))
                  + length(JSONExtractArrayRaw(p, 'items', 'order')) + length(JSONExtractArrayRaw(p, 'upgrades', 'order'))
                  + length(JSONExtractArrayRaw(p, 'unknown', 'order')), players) AS player_orders
SELECT
    replay_id,
    doc,
    toUInt32(arraySum(player_orders)
        + arraySum(p -> arraySum(h -> length(JSONExtractArrayRaw(h, 'abilityOrder')), JSONExtractArrayRaw(p, 'heroes')), players)) AS events
FROM {{ ref('raw_replays') }} FINAL
WHERE arrayAll(n -> n > 0, player_orders)
