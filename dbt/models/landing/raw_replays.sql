-- One row per parsed replay document, read from the bucket's parsed/ prefix through
-- the bucket.parsed_docs source: an S3 table over the `parsed_docs` named collection
-- (infrastructure/docker/clickhouse/named-collections.xml), which the on-run-start
-- hook in dbt_project.yml creates. The URL glob and the keys come from the server's
-- env, so no secret lands in compiled SQL or the query log.
-- A re-run loads only new documents: the drain names each file <replay_id>.json, so
-- the _file gate skips a loaded document before ClickHouse reads it, and the
-- replay_id gate catches a document under any other name.
-- ponytail: every run lists the whole parsed/ prefix; narrow the glob by dt= when
-- the prefix holds enough documents for the LIST to cost.
{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='MergeTree()',
    order_by='replay_id'
) }}

SELECT
    JSONExtractString(doc, 'id') AS replay_id,
    doc,
    now() AS ingested_at
FROM {{ source('bucket', 'parsed_docs') }}
WHERE replay_id != ''
{% if is_incremental() %}
  AND _file NOT IN (SELECT replay_id || '.json' FROM {{ this }})
  AND replay_id NOT IN (SELECT replay_id FROM {{ this }})
{% endif %}
LIMIT 1 BY replay_id
