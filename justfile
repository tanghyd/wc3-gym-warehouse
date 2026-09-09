# wc3-gym-warehouse — ClickHouse, the parse drain, and the S3 bucket they share.
# Secrets come from .env (see .env.example), never from a recipe.
set dotenv-load

# clickhouse-client against CLICKHOUSE_HOST, with the password only if one is set.
# A Docker-only machine has no host binary, so fall back to the compose container.
# Recipes pipe SQL on stdin, so the .sql path is resolved by the shell and the
# container needs no mount of db/.
client := """sh -c 'if command -v clickhouse-client >/dev/null 2>&1; then exec clickhouse-client --host "${CLICKHOUSE_HOST:-127.0.0.1}" ${CLICKHOUSE_PASSWORD:+--password=$CLICKHOUSE_PASSWORD} "$@"; else exec docker compose exec -T clickhouse clickhouse-client ${CLICKHOUSE_PASSWORD:+--password=$CLICKHOUSE_PASSWORD} "$@"; fi' --"""
manifest := 'pipeline/parse-rs/Cargo.toml'
# Must match PARSE_VERSION in pipeline/parse-rs/src/lib.rs.
parse_version := '2'

_default:
    @just --list

# start clickhouse, apply the schema and run the drain
up:
    docker compose up -d --build

# stop everything, keeping the ClickHouse volume
down:
    docker compose down

# apply tables.sql then views.sql to CLICKHOUSE_HOST
schema:
    {{client}} --multiquery < db/w3g/tables.sql
    {{client}} --multiquery < db/w3g/views.sql

# rebuild w3g.mappings: the parser's melee tables, then the custom-map seed
mappings:
    cargo run --manifest-path {{manifest}} --release --bin export-mappings -- /tmp/mappings.json
    {{client}} --query 'TRUNCATE TABLE w3g.mappings'
    {{client}} --query 'INSERT INTO w3g.mappings (code, name, kind, race, hero, is_supply_building) FORMAT JSONEachRow' < /tmp/mappings.json
    {{client}} --query 'INSERT INTO w3g.mappings (code, name, kind, category) FORMAT JSONEachRow' < db/w3g/seed/custom_object_names.ndjson

# parse every new or changed replay in the bucket once, then exit
drain-once:
    cargo run --manifest-path {{manifest}} --release --bin drain -- --once

# load parsed documents from an s3 glob into w3g.replays_raw, then refresh the rollup
backfill url:
    {{client}} --multiquery \
      --param_url='{{url}}' \
      --param_access_key="$W3WAREHOUSE_S3_ACCESS_KEY" \
      --param_secret_key="$W3WAREHOUSE_S3_SECRET_KEY" < db/w3g/backfill.sql
    {{client}} --query 'SYSTEM REFRESH VIEW w3g.refresh__opener_rollup'

# load every parsed document in the configured bucket, so no URL is typed by hand
backfill-bucket:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "${W3WAREHOUSE_S3_SECURE:-false}" = "true" ]; then scheme=https; else scheme=http; fi
    # W3WAREHOUSE_S3_PREFIX is the Vercel environment segment, empty for a flat bucket.
    prefix="${W3WAREHOUSE_S3_PREFIX:-}"; prefix="${prefix#/}"; prefix="${prefix%/}"
    url="$scheme://${W3WAREHOUSE_S3_ENDPOINT}/${W3WAREHOUSE_S3_BUCKET}/${prefix:+$prefix/}parsed/v{{parse_version}}/**.json"
    echo "loading $url"
    {{just_executable()}} backfill "$url"

# parser unit tests and the parity goldens
test:
    cargo test --manifest-path {{manifest}}

# an interactive clickhouse-client
ch:
    @if command -v clickhouse-client >/dev/null 2>&1; then \
      clickhouse-client --host "${CLICKHOUSE_HOST:-127.0.0.1}" ${CLICKHOUSE_PASSWORD:+--password=$CLICKHOUSE_PASSWORD}; \
    else docker compose exec clickhouse clickhouse-client ${CLICKHOUSE_PASSWORD:+--password=$CLICKHOUSE_PASSWORD}; fi
