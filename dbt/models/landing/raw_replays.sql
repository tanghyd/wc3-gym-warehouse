-- One row per parsed replay document, read from the bucket's parsed/ prefix through
-- the bucket.parsed_docs source: an S3 table over the `parsed_docs` named collection
-- (infrastructure/docker/clickhouse/named-collections.xml), which the on-run-start
-- hook in dbt_project.yml creates. The URL glob and the keys come from the server's
-- env, so no secret lands in compiled SQL or the query log. The glob takes every parse
-- version (parsed/v*/), and the version column keeps the newest copy of a replay.
-- A ReplacingMergeTree on replay_id with parse_version as its version: a second copy
-- of a document collapses into one row, and a document at a newer parse version
-- replaces the older one. Both happen at a merge, so every reader reads the table
-- FINAL: valid_replays, which every mart reads, and Grafana.
-- A re-run loads a document only when its replay is not loaded at the same or a newer
-- parse version. The drain writes parsed/v<N>/dt=<date>/<replay_id>.json, so the path
-- gate skips a loaded document before ClickHouse fetches it, and the document gate
-- catches one under any other name.
-- ponytail: every run lists the whole parsed/ prefix; narrow the glob by dt= when
-- the prefix holds enough documents for the LIST to cost.
{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(parse_version)',
    order_by='replay_id'
) }}

{% if is_incremental() %}
-- replay_id -> the parse version loaded for it, 0 for a replay not loaded
WITH (SELECT mapFromArrays(groupArray(replay_id), groupArray(parse_version)) FROM {{ this }} FINAL) AS loaded
{% endif %}
SELECT
    JSONExtractString(doc, 'id') AS replay_id,
    doc,
    now() AS ingested_at,
    toUInt32(JSONExtractUInt(doc, 'parse_version')) AS parse_version
FROM {{ source('bucket', 'parsed_docs') }}
WHERE replay_id != ''
{% if is_incremental() %}
  AND toUInt32OrZero(extract(_path, '/parsed/v([0-9]+)/')) > loaded[replaceOne(_file, '.json', '')]
  AND parse_version > loaded[replay_id]
{% endif %}
