-- One row per replay, read from the drain's ingest.docs (source ingest.docs), which holds
-- one parsed document per object key. Per replay_id it keeps the document at the highest
-- parse_version, then the newest source_last_modified, then the lowest (source, key), so a
-- parser bump or a re-upload replaces the older document on the next run.
-- A table rebuilt on every run: one row per replay_id, so FINAL, which every reader uses
-- (valid_replays and Grafana), changes nothing. It stays a ReplacingMergeTree so FINAL is valid.
-- ponytail: the run reads every document (14 MB at 1,746 replays); switch to incremental
-- on ingested_at when a build takes minutes.
{{ config(
    engine='ReplacingMergeTree(parse_version)',
    order_by='replay_id'
) }}

SELECT
    JSONExtractString(doc, 'id') AS replay_id,
    doc,
    toDateTime(ingested_at) AS ingested_at,
    parse_version
FROM {{ source('ingest', 'docs') }} FINAL
WHERE replay_id != ''
ORDER BY replay_id, parse_version DESC, source_last_modified DESC, source, key
LIMIT 1 BY replay_id
