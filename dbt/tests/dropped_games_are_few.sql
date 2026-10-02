-- Returns one row when more than 5% of the loaded replays were dropped because a player gave no
-- order (40 of 1,746 on 2026-10-02). A jump means the parser or the rule changed, not the games.
{{ config(severity='warn') }}
SELECT dropped, loaded
FROM (
    SELECT (SELECT count() FROM {{ ref('raw_replays') }}) AS loaded,
           loaded - (SELECT count() FROM {{ ref('valid_replays') }}) AS dropped
)
WHERE dropped > loaded * 0.05
