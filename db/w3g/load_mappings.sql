-- db/w3g/load_mappings.sql — (re)load the w3g.mappings dim from a JSONEachRow
-- file produced by the pipeline/parse-rs export-mappings binary.
--
-- This is the file() path, for a server that can see the file. `just local::mappings`
-- pipes the same rows over stdin instead, which works against a remote server.
--
-- Invoke:
--   clickhouse-client --queries-file db/w3g/load_mappings.sql \
--     --param_path='mappings.json'
-- Path is relative to user_files_path.

TRUNCATE TABLE w3g.mappings;

-- Explicit column list: the table also carries the custom-map `category` facet,
-- which the melee export doesn't know (defaults to '').
INSERT INTO w3g.mappings (code, name, kind, race, hero, is_supply_building)
SELECT code, name, kind, race, hero, is_supply_building
FROM file({path:String}, JSONEachRow,
          'code String, name String, kind String, race String, hero String, is_supply_building UInt8');
