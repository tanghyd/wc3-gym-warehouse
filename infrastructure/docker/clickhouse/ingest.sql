-- The drain's tables (pipeline/parse-rs/src/bin/drain.rs), written by the `ingest` user
-- (users.xml) and read by dbt's source ingest.docs. The image runs this file on an empty
-- volume only; on a running server apply it with `just local::sql --multiquery < infrastructure/docker/clickhouse/ingest.sql`.
-- files and docs are ReplacingMergeTrees on (source, key): a re-read object adds a row, a
-- merge keeps the one with the highest version (parse_version, then source_last_modified),
-- so a reader reads them FINAL. runs is a plain log of passes, one row per source per pass.
CREATE DATABASE IF NOT EXISTS ingest
COMMENT 'What the drain read from the source buckets: one row per object, one parsed document per object.';

CREATE TABLE IF NOT EXISTS ingest.files
(
    source String COMMENT 'The bucket the drain listed the object in.',
    key String COMMENT 'The object key.',
    etag String COMMENT 'The ETag the listing gave, quotes stripped.',
    source_last_modified DateTime64(3, 'UTC') COMMENT 'When the bucket last wrote the object.',
    size UInt64 COMMENT 'The object size in bytes.',
    parse_version UInt32 COMMENT 'The PARSE_VERSION of the drain that read the object.',
    replay_id String COMMENT 'The parsed replay id, empty when the parse failed.',
    error String COMMENT 'Why the parse gave no document, empty when it gave one.',
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3) COMMENT 'When the drain inserted the row.',
    version UInt64 MATERIALIZED toUInt64(parse_version) * 4294967296 + toUnixTimestamp(source_last_modified)
        COMMENT 'The row a merge keeps: parse_version, then source_last_modified in seconds.'
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (source, key)
COMMENT 'One row per object the drain read, with the error when the parse failed. The drain skips an object whose ETag, size and parse_version match its row.';

CREATE TABLE IF NOT EXISTS ingest.docs
(
    source String COMMENT 'The bucket the drain listed the object in.',
    key String COMMENT 'The object key.',
    etag String COMMENT 'The ETag the listing gave, quotes stripped.',
    source_last_modified DateTime64(3, 'UTC') COMMENT 'When the bucket last wrote the object.',
    parse_version UInt32 COMMENT 'The PARSE_VERSION of the drain that parsed the object.',
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3) COMMENT 'When the drain inserted the document.',
    doc String COMMENT 'The parsed replay document as JSON text: w3grs output plus source_key, source_last_modified and parse_version.',
    version UInt64 MATERIALIZED toUInt64(parse_version) * 4294967296 + toUnixTimestamp(source_last_modified)
        COMMENT 'The row a merge keeps: parse_version, then source_last_modified in seconds.'
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (source, key)
COMMENT 'One parsed replay document per object that parsed. dbt reads it as the source ingest.docs.';

CREATE TABLE IF NOT EXISTS ingest.runs
(
    source String COMMENT 'The bucket the pass listed.',
    started_at DateTime64(3, 'UTC') COMMENT 'When the pass started on this source.',
    finished_at DateTime64(3, 'UTC') COMMENT 'When the pass finished this source, with or without an error.',
    parse_version UInt32 COMMENT 'The PARSE_VERSION of the drain.',
    listed UInt32 COMMENT 'Objects the listing returned.',
    todo UInt32 COMMENT 'Objects that were new or changed.',
    inserted UInt32 COMMENT 'Documents inserted.',
    failed UInt32 COMMENT 'Objects whose parse failed.',
    retry UInt32 COMMENT 'Objects whose GET or INSERT failed; the next pass retries them.',
    error String COMMENT 'Why the pass stopped early, empty when it finished.'
)
ENGINE = MergeTree
ORDER BY (source, started_at)
TTL toDateTime(started_at) + INTERVAL 90 DAY
COMMENT 'One row per source per drain pass. Grafana reads the age of the last pass and the failure counts from it.';
