-- db/w3g/load_mappings.sql — (re)load the w3g.mappings dim from a
-- JSONEachRow file produced by the pipeline/parse-rs export-mappings binary.
--
-- Invoke:
--   clickhouse-client --host 127.0.0.1 --queries-file db/w3g/load_mappings.sql \
--     --param_path='data/json/mappings.json'
-- Path is relative to user_files_path.

TRUNCATE TABLE w3g.mappings;

-- Explicit column list: the table also carries the custom-map `category`
-- facet, which the melee export doesn't know (defaults to '').
INSERT INTO w3g.mappings (code, name, kind, race, hero, is_supply_building)
SELECT code, name, kind, race, hero, is_supply_building
FROM file({path:String}, JSONEachRow,
          'code String, name String, kind String, race String, hero String, is_supply_building UInt8');
