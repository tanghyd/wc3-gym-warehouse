# The local compose project: ClickHouse on 127.0.0.1:8123, the drain and the ui.
set working-directory := '..'

manifest := 'pipeline/parse-rs/Cargo.toml'
# Must match PARSE_VERSION in pipeline/parse-rs/src/lib.rs.
parse_version := '2'
# clickhouse-client in the container, SQL on stdin. $CLICKHOUSE_PASSWORD expands in the container.
client := "docker compose exec -T clickhouse sh -c 'exec clickhouse-client ${CLICKHOUSE_PASSWORD:+--password=\"$CLICKHOUSE_PASSWORD\"} \"$@\"' client"

# build and start clickhouse, the schema one-shot, the drain and the ui
up:
    docker compose up -d --build

# stop the project; its volumes and the data they hold stay
down:
    docker compose down

# an interactive clickhouse-client
ch:
    docker compose exec clickhouse sh -c 'exec clickhouse-client ${CLICKHOUSE_PASSWORD:+--password="$CLICKHOUSE_PASSWORD"}'

# apply tables.sql then views.sql: the compose one-shot, which starts clickhouse
schema:
    docker compose run --rm schema

# rebuild w3g.mappings: the parser's melee tables, then the custom-map seed
mappings:
    cargo run --manifest-path {{manifest}} --release --bin export-mappings -- /tmp/mappings.json
    {{client}} --query 'TRUNCATE TABLE w3g.mappings'
    {{client}} --query 'INSERT INTO w3g.mappings (code, name, kind, race, hero, is_supply_building) FORMAT JSONEachRow' < /tmp/mappings.json
    {{client}} --query 'INSERT INTO w3g.mappings (code, name, kind, category) FORMAT JSONEachRow' < db/w3g/seed/custom_object_names.ndjson

# load the 3 parser goldens into w3g.replays_raw, no bucket needed (run mappings first)
fixtures:
    for f in pipeline/parse-rs/tests/goldens/*.json; do {{client}} --query "INSERT INTO w3g.replays_raw (replay_id, doc) SELECT JSONExtractString(doc, 'id'), doc FROM input('doc String') WHERE JSONExtractString(doc, 'id') NOT IN (SELECT replay_id FROM w3g.replays_raw) FORMAT JSONAsString" < "$f"; done
    {{client}} --query 'SYSTEM REFRESH VIEW w3g.refresh__opener_rollup'
    {{client}} --query 'SYSTEM WAIT VIEW w3g.refresh__opener_rollup'

# load parsed docs from the mounted data/ in one INSERT … FROM file(), then refresh
load glob='data/parsed/gnl/*.json':
    {{client}} --param_glob='{{glob}}' --query "INSERT INTO w3g.replays_raw (replay_id, doc) SELECT JSONExtractString(doc, 'id') AS replay_id, doc FROM file({glob:String}, 'JSONAsString', 'doc String') WHERE replay_id != '' AND replay_id NOT IN (SELECT replay_id FROM w3g.replays_raw) LIMIT 1 BY replay_id"
    {{client}} --query 'SYSTEM REFRESH VIEW w3g.refresh__opener_rollup'
    {{client}} --query 'SYSTEM WAIT VIEW w3g.refresh__opener_rollup'

# parse every new or changed replay in the bucket once, with the drain image
drain-once:
    docker compose run --rm --build drain drain --once

# load parsed documents from an s3 glob into w3g.replays_raw, then refresh the rollup
backfill url:
    {{client}} --multiquery \
      --param_url='{{url}}' \
      --param_access_key="$W3WAREHOUSE_S3_ACCESS_KEY" \
      --param_secret_key="$W3WAREHOUSE_S3_SECRET_KEY" < db/w3g/backfill.sql
    {{client}} --query 'SYSTEM REFRESH VIEW w3g.refresh__opener_rollup'
    {{client}} --query 'SYSTEM WAIT VIEW w3g.refresh__opener_rollup'

# load every parsed document in the configured bucket, so no URL is typed by hand
backfill-bucket:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "${W3WAREHOUSE_S3_SECURE:-false}" = "true" ]; then scheme=https; else scheme=http; fi
    # W3WAREHOUSE_S3_PREFIX is the Vercel environment segment, empty for a flat bucket.
    prefix="${W3WAREHOUSE_S3_PREFIX:-}"; prefix="${prefix#/}"; prefix="${prefix%/}"
    url="$scheme://${W3WAREHOUSE_S3_ENDPOINT}/${W3WAREHOUSE_S3_BUCKET}/${prefix:+$prefix/}parsed/v{{parse_version}}/**.json"
    echo "loading $url"
    {{ just_executable() }} local::backfill "$url"
