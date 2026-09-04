-- db/w3g/backfill.sql — bulk pull parsed-JSON objects from an object store into
-- w3g.replays_raw. The production backfill path: the third writer of replays_raw
-- (batch file() in load.sql, stream S3Queue in stream.sql), and the only one that
-- works against a REMOTE warehouse — s3() reads server-side over the network, so
-- there is no co-located-disk / user_files_path chroot the way file() has.
--
-- Same self-deduping sink, same 1v1 filter, same replay_id gate as the other two
-- writers — so the views.sql MV cascade fans it out to replay_events with zero new
-- wiring, and a backfill is safe to run concurrently with the live stream.
--
-- Stream vs backfill (see docs/plan-ingestion-architecture.md):
--   stream  = S3Queue, continuous, state = consumed keys in Keeper.
--   backfill = this file, one-shot, STATELESS — the {url} glob you pass IS the
--              scope. Pass a date-bounded prefix to load a slice; re-running an
--              overlapping prefix is a no-op (the gate), so it's resumable.
--
-- Invoke (local, against the compose `stream` profile — s3() must resolve minio
-- inside the compose network, so run it from the clickhouse container):
--   docker compose exec -T clickhouse clickhouse-client \
--     --param_url='http://minio:9000/landing/parsed/v2/**.json' \
--     --param_access_key=minioadmin --param_secret_key=minioadmin \
--     < db/w3g/backfill.sql
--   (or: just backfill <url> [access_key] [secret_key] against host CH + minio_host)
--
-- Invoke (production, against the deployed VM's CH over the IAP tunnel or via
-- `docker compose exec` on the box):
--   clickhouse-client --queries-file db/w3g/backfill.sql \
--     --param_url='https://<bucket>.s3.<region>.amazonaws.com/parsed/v2/dt=2026-06-*/**.json' \
--     --param_access_key=$AWS_ACCESS_KEY_ID --param_secret_key=$AWS_SECRET_ACCESS_KEY
--
-- ponytail: creds passed as query params (visible in `ps`/query_log) — fine for a
-- single-operator backfill. Upgrade to a server-side named collection or instance
-- IAM (no creds in the statement at all) if backfill ever runs unattended/shared.

INSERT INTO w3g.replays_raw (replay_id, doc)
SELECT
    JSONExtractString(doc, 'id') AS replay_id,
    doc
FROM s3({url:String}, {access_key:String}, {secret_key:String}, 'JSONAsString', 'doc String')
WHERE replay_id != ''
  AND replay_id NOT IN (SELECT replay_id FROM w3g.replays_raw);
