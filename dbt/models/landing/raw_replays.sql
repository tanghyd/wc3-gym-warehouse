-- One row per parsed replay document, read from the bucket's parsed/ prefix.
-- `parsed_docs` is a ClickHouse named collection (infrastructure/docker/clickhouse/
-- named-collections.xml): the URL glob and the keys come from the server's env, so
-- no secret lands in compiled SQL or the query log.
-- The replay_id gate makes a re-run load only new documents.
-- ponytail: every run lists and reads the whole parsed/ prefix; narrow the glob by
-- dt= when the prefix holds enough documents for that to cost.
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
FROM s3(parsed_docs, format = 'JSONAsString', structure = 'doc String')
WHERE replay_id != ''
{% if is_incremental() %}
  AND replay_id NOT IN (SELECT replay_id FROM {{ this }})
{% endif %}
LIMIT 1 BY replay_id
