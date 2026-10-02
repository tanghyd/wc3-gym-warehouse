-- Returns each loaded document missing a key the marts read. JSONExtract answers '' or 0 for
-- a renamed key, so without this a parser change would empty a column in silence.
SELECT replay_id,
       arrayFilter(k -> NOT JSONHas(doc, k),
                   ['id', 'type', 'map', 'duration', 'players', 'leaves', 'randomseed', 'saverPlayerId',
                    'buildNumber', 'settings', 'source_key', 'source_last_modified', 'parse_version']) AS missing
FROM {{ ref('raw_replays') }}
WHERE notEmpty(missing)
