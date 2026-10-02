# decisions

What was decided, when, why, and what it means for new code.

* [ClickHouse on one box, data in the bucket](clickhouse-on-one-box.md) - The warehouse runs as one compose project on one small box, reads replays from the bucket, and holds no data the bucket cannot rebuild.
* [dbt over hand-written SQL](dbt-over-hand-written-sql.md) - The marts are dbt models rebuilt in full on each run, not a chain of materialized views; incremental models wait until a build takes minutes.
* [The drain inserts into ClickHouse](drain-inserts-into-clickhouse.md) - The drain writes parsed documents straight into ClickHouse over HTTP and keeps no parsed copy in the bucket.
* [The bucket is the record](bucket-is-the-record.md) - The raw replays in the bucket are the only irreplaceable data; ClickHouse is rebuilt from them and is not backed up.
* [The inspector reads the API server-side](inspector-reads-the-api-server-side.md) - The browser never calls the API or ClickHouse; the Next.js server does, and only the page is public.
