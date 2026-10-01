-- One row per player per replay. Observers are not players and never appear.
{{ config(order_by='(replay_id, player_id)') }}

SELECT
    r.replay_id                                                  AS replay_id,
    toUInt8(JSONExtractUInt(p, 'id'))                            AS player_id,
    JSONExtractString(p, 'name')                                 AS name,
    JSONExtractString(p, 'color')                                AS color,
    coalesce(JSONExtract(p, 'teamid', 'Nullable(Int8)'), -1)     AS team_id,
    {{ gnl_race("JSONExtractString(p, 'race')") }}           AS race,
    JSONExtractString(p, 'raceDetected')                         AS race_detected,
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
    JSONExtract(p, 'actions', 'timed', 'Array(UInt32)')          AS apm_timed
FROM {{ ref('raw_replays') }} AS r
ARRAY JOIN JSONExtractArrayRaw(r.doc, 'players') AS p
