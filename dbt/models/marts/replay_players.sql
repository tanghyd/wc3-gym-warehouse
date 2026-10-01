-- One row per player per replay. Observers are not players and never appear.
{{ config(order_by='(replay_id, player_id)') }}

WITH
    -- actions per 60 s slot from the parser; the last slot holds the rest of the game
    JSONExtract(p, 'actions', 'timed', 'Array(UInt32)') AS timed,
    toInt64(JSONExtractUInt(r.doc, 'duration')) - 60000 * (toInt64(length(timed)) - 1) AS last_ms
SELECT
    r.replay_id                                                  AS replay_id,
    toUInt8(JSONExtractUInt(p, 'id'))                            AS player_id,
    JSONExtractString(p, 'name')                                 AS name,
    toLowCardinality(JSONExtractString(p, 'color'))              AS color,
    coalesce(JSONExtract(p, 'teamid', 'Nullable(Int8)'), -1)     AS team_id,
    {{ race_code("JSONExtractString(p, 'race')") }}           AS race,
    toLowCardinality(JSONExtractString(p, 'raceDetected'))       AS race_detected,
    toUInt32(JSONExtractUInt(p, 'apm'))                          AS apm,
    toUInt32(JSONExtractUInt(p, 'actions', 'rightclick'))        AS actions_rightclick,
    toUInt32(JSONExtractUInt(p, 'actions', 'basic'))             AS actions_basic,
    toUInt32(JSONExtractUInt(p, 'actions', 'buildtrain'))        AS actions_buildtrain,
    toUInt32(JSONExtractUInt(p, 'actions', 'ability'))           AS actions_ability,
    toUInt32(JSONExtractUInt(p, 'actions', 'item'))              AS actions_item,
    toUInt32(JSONExtractUInt(p, 'actions', 'select'))            AS actions_select,
    toUInt32(JSONExtractUInt(p, 'actions', 'removeunit'))        AS actions_removeunit,
    toUInt32(JSONExtractUInt(p, 'actions', 'subgroup'))          AS actions_subgroup,
    toUInt32(JSONExtractUInt(p, 'actions', 'selecthotkey'))      AS actions_selecthotkey,
    toUInt32(JSONExtractUInt(p, 'actions', 'assigngroup'))       AS actions_assigngroup,
    toUInt32(JSONExtractUInt(p, 'actions', 'esc'))               AS actions_esc,
    -- APM per game minute: the last, partial slot is scaled to a full minute, or dropped under 30 s
    if(empty(timed) OR last_ms < 30000, arrayPopBack(timed),
       arrayPushBack(arrayPopBack(timed), toUInt32(round(timed[-1] * 60000 / last_ms)))) AS apm_timed
FROM {{ ref('raw_replays') }} AS r
ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
-- raw_replays keeps a replaced document until a merge, so read it deduplicated.
SETTINGS final = 1
