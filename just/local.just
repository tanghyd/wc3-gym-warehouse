# The local compose project: ClickHouse on 127.0.0.1:8123, MinIO with the goldens, the drain,
# the API on http://localhost:8000, the replay inspector on http://localhost:3000 and Grafana on http://localhost:3001.
set working-directory := '..'

# build and start every long-running service
up:
    docker compose up -d --build --remove-orphans

# stop the project; its volumes and the data they hold stay
down:
    docker compose down

# stop the project and delete its volumes: ClickHouse, MinIO and the dbt cache
reset:
    docker compose down -v

# every container and its state
ps:
    docker compose ps -a --format 'table {{{{.Service}}\t{{{{.Status}}'

# the last lines one service logged
logs service lines='40':
    docker compose logs --no-log-prefix --tail {{lines}} {{service}}

# an interactive clickhouse-client
ch:
    docker compose exec clickhouse sh -c 'exec clickhouse-client ${CLICKHOUSE_PASSWORD:+--password="$CLICKHOUSE_PASSWORD"}'

# run SQL from stdin, such as `just local::sql < query.sql` or `echo 'SELECT 1' | just local::sql`
[positional-arguments]
sql *args:
    docker compose exec -T clickhouse sh -c 'exec clickhouse-client ${CLICKHOUSE_PASSWORD:+--password="$CLICKHOUSE_PASSWORD"} "$@"' client "$@"

# dbt in its container, such as `just dbt build` or `just dbt test`
[positional-arguments]
dbt *args:
    # --no-deps: never start or recreate clickhouse; `just up` runs it
    docker compose run --rm --no-deps --build dbt "$@"

# write dbt's docs site (models, columns, tests, lineage) for http://127.0.0.1:8080
docs:
    # --no-deps: never start or recreate clickhouse; `just up` runs it
    docker compose run --rm --no-deps --build dbt docs generate

# parse every new or changed replay in the bucket once, with the drain image
drain-once:
    docker compose run --rm --build drain drain --once

# the parser's melee object tables as JSONEachRow on stdout
export-mappings:
    @docker compose run --rm --no-deps -T drain export-mappings /dev/stdout

# the drain's unit tests and parser goldens, in the test stage of the drain image
drain-test:
    docker build --target test --progress plain -f infrastructure/docker/Dockerfile.drain .

# copy every .w3g under a folder changed since a date into the bucket's replays/local/, keeping
# subfolders, such as `just local::upload-replays "/mnt/c/Users/Daniel/Documents/Warcraft III/BattleNet/51230813/Replays" 2026-09-01`
[positional-arguments]
upload-replays dir since:
    #!/usr/bin/env bash
    set -euo pipefail
    stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
    (cd "$1" && find . -type f -name '*.w3g' -newermt "$2" -exec cp --parents -p {} "$stage/" \;)
    echo "uploading $(find "$stage" -type f | wc -l) replays"
    docker compose run --rm --no-deps -v "$stage:/upload:ro" -e KEY="$W3WAREHOUSE_S3_ACCESS_KEY" \
      -e SECRET="$W3WAREHOUSE_S3_SECRET_KEY" --entrypoint sh minio-setup -c \
      'mc alias set local http://minio:9000 "$KEY" "$SECRET" >/dev/null && mc cp -q -r /upload/ "local/$BUCKET/${PREFIX:+$PREFIX/}replays/local/"'

# rewrite the melee mappings seed from the parser's tables (after a w3grs bump)
mappings:
    #!/usr/bin/env bash
    set -euo pipefail
    tmp=$(mktemp)
    {{ just_executable() }} local::export-mappings \
      | docker compose exec -T clickhouse clickhouse local --input-format JSONEachRow --output-format CSVWithNames \
          --query 'SELECT code, name, kind, race, hero, is_supply_building FROM table ORDER BY code, kind' > "$tmp"
    mv "$tmp" dbt/seeds/mappings_melee.csv

# the API tests in the API image: the compiler goldens, then the live cases
[positional-arguments]
api-test *args:
    docker compose run --rm --build -v "$PWD/api:/api" api uv run --frozen pytest "$@"

# rewrite the answers in api/tests/cases/ from the live stack; review the git diff
api-cases-update:
    docker compose run --rm --build -v "$PWD/api:/api" -e UPDATE_CASES=1 api uv run --frozen pytest tests/test_cases.py

# rewrite web/pnpm-lock.yaml from web/package.json, in a node container as you
web-lock:
    docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
      -v "$PWD/web:/web" -w /web node:22-slim corepack pnpm install --lockfile-only --store-dir /tmp/pnpm-store

# a node script from an absolute folder, mounted read-only, such as the dataviz palette check
# `just local::node /tmp/vp validate_palette.js "#02927B,#C061D6" --mode light --surface "#F4F5F1"`
[positional-arguments]
node dir *args:
    d="$1"; shift; docker run --rm --user "$(id -u):$(id -g)" -v "$d:/work:ro" -w /work node:22-slim node "$@"

# eslint over web/, in the lint stage of the web image
web-lint:
    docker build --target lint --output type=cacheonly --progress plain -f infrastructure/docker/Dockerfile.web .

# the Playwright tests in web/e2e against the running stack, such as `just local::e2e --grep chat`; screenshots go to web/e2e/shots/
[positional-arguments]
e2e *args:
    docker compose run --rm --user "$(id -u):$(id -g)" e2e "$@"
