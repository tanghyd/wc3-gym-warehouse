-- db/w3g/backfill.sql — pull parsed-JSON objects from the object store into
-- w3g.replays_raw. This is the only load path: s3() reads server-side over the
-- network, so ClickHouse never needs the files on its own disk.
--
-- Stateless: the {url} glob you pass IS the scope, and the replay_id gate makes
-- an overlapping re-run a no-op, so it is safe to repeat and safe to resume.
-- The views.sql cascade fans every new row out to replay_events on its own.
--
-- Invoke:
--   just backfill 'http://localhost:9000/warehouse/parsed/v2/**.json'
--   just backfill 'https://<account>.r2.cloudflarestorage.com/<bucket>/parsed/v2/dt=2026-09-*/**.json'
--
-- ponytail: creds passed as query params (visible in `ps` and query_log) — fine
-- for a single-operator backfill. Move to a server-side named collection if this
-- ever runs somewhere shared.

INSERT INTO w3g.replays_raw (replay_id, doc)
SELECT
    JSONExtractString(doc, 'id') AS replay_id,
    doc
FROM s3({url:String}, {access_key:String}, {secret_key:String}, 'JSONAsString', 'doc String')
WHERE replay_id != ''
  AND replay_id NOT IN (SELECT replay_id FROM w3g.replays_raw);
