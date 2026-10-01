# The local compose project: ClickHouse on 127.0.0.1:8123, MinIO with the goldens,
# the drain, the API, the page on http://localhost:8080 and the replay inspector
# on http://localhost:3000.
set working-directory := '..'

# build and start every long-running service
up:
    docker compose up -d --build

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
    docker compose run --rm --build dbt "$@"

# parse every new or changed replay in the bucket once, with the drain image
drain-once:
    docker compose run --rm --build drain drain --once

# the parser's melee object tables as JSONEachRow on stdout
export-mappings:
    @docker compose run --rm --no-deps -T drain export-mappings /dev/stdout

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

# eslint over web/, in the lint stage of the web image
web-lint:
    docker build --target lint --output type=cacheonly --progress plain -f infrastructure/docker/Dockerfile.web .

# a full-page screenshot of an inspector page, such as `just local::web-shot /replays/<id> "$PWD/shot.png" 390 dark`
[positional-arguments]
web-shot path out width='1280' theme='light':
    docker run --rm --network wc3-gym-warehouse_default --user "$(id -u):$(id -g)" -e HOME=/tmp \
      -v "$(dirname "$2"):/out" mcr.microsoft.com/playwright:v1.55.0-noble \
      npx -y playwright@1.55.0 screenshot --browser chromium --full-page --color-scheme "$4" \
      --viewport-size "$3,900" --wait-for-timeout 2000 "http://web:3000$1" "/out/$(basename "$2")"
