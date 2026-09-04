# wc3-gym-warehouse — ClickHouse, the parse drain, and the S3 bucket they share.
# Secrets come from .env (see .env.example), never from a recipe.
set dotenv-load

# clickhouse-client against CLICKHOUSE_HOST, with the password only if one is set
client := 'clickhouse-client --host "${CLICKHOUSE_HOST:-127.0.0.1}" ${CLICKHOUSE_PASSWORD:+--password=$CLICKHOUSE_PASSWORD}'
manifest := 'pipeline/parse-rs/Cargo.toml'

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
    {{client}} --queries-file db/w3g/tables.sql
    {{client}} --queries-file db/w3g/views.sql

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
    {{client}} --queries-file db/w3g/backfill.sql \
      --param_url='{{url}}' \
      --param_access_key="$W3WAREHOUSE_S3_ACCESS_KEY" \
      --param_secret_key="$W3WAREHOUSE_S3_SECRET_KEY"
    {{client}} --query 'SYSTEM REFRESH VIEW w3g.refresh__opener_rollup'

# parser unit tests and the parity goldens
test:
    cargo test --manifest-path {{manifest}}

# an interactive clickhouse-client
ch:
    {{client}}
