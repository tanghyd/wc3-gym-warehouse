-- One row per player per replay. Observers are not players and never appear.
-- race is the played race. A player who picked a race played it. A player who picked
-- Random played the race the parser detected (from his first train or research order),
-- else the race letter of his first building or unit order code (h o e u). The parser
-- detects no race from a building placement, so a random player who only built has
-- none. A random player with neither order has no played race: RANDOM.
{{ config(order_by='(replay_id, player_id)') }}

WITH
    -- actions per 60 s slot from the parser; the last slot holds the rest of the game
    JSONExtract(p, 'actions', 'timed', 'Array(UInt32)') AS timed,
    toInt64(JSONExtractUInt(r.doc, 'duration')) - 60000 * (toInt64(length(timed)) - 1) AS last_ms,
    JSONExtractString(p, 'race') AS picked,
    JSONExtractString(p, 'raceDetected') AS detected,
    -- the earliest building or unit order whose code names a race
    arraySort(o -> JSONExtractUInt(o, 'ms'), arrayFilter(o -> has(['h', 'o', 'e', 'u'], substring(JSONExtractString(o, 'id'), 1, 1)),
        arrayConcat(JSONExtractArrayRaw(p, 'buildings', 'order'), JSONExtractArrayRaw(p, 'units', 'order'))))[1] AS first_raced
SELECT
    r.replay_id                                                  AS replay_id,
    toUInt8(JSONExtractUInt(p, 'id'))                            AS player_id,
    JSONExtractString(p, 'name')                                 AS name,
    toLowCardinality(JSONExtractString(p, 'color'))              AS color,
    coalesce(JSONExtract(p, 'teamid', 'Nullable(Int8)'), -1)     AS team_id,
    {{ race_code("multiIf(picked != 'R', picked, detected != '', detected,
        transform(substring(JSONExtractString(first_raced, 'id'), 1, 1), ['h', 'o', 'e', 'u'], ['H', 'O', 'N', 'U'], 'R'))") }} AS race,
    toUInt8(picked = 'R')                                        AS random,
    toLowCardinality(detected)                                   AS race_detected,
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
