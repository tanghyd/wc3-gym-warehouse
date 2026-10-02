# The local compose project: ClickHouse on 127.0.0.1:8123, MinIO with the goldens, the drain (run once),
# the API on http://localhost:8000, the replay inspector on http://localhost:3000 and Grafana on http://localhost:3001.
set working-directory := '..'

# build and start every long-running service, then apply the ingest tables an existing volume may lack
up:
    docker compose up -d --build --remove-orphans
    @{{ just_executable() }} local::schema

# apply infrastructure/docker/clickhouse/ingest.sql (every statement is IF NOT EXISTS) once ClickHouse answers
schema:
    #!/usr/bin/env bash
    set -uo pipefail
    for i in $(seq 1 60); do
      docker compose exec -T clickhouse clickhouse-client ${CLICKHOUSE_PASSWORD:+--password="$CLICKHOUSE_PASSWORD"} -q 'SELECT 1' >/dev/null 2>&1 && break
      sleep 1
    done
    docker compose exec -T clickhouse clickhouse-client ${CLICKHOUSE_PASSWORD:+--password="$CLICKHOUSE_PASSWORD"} --multiquery < infrastructure/docker/clickhouse/ingest.sql

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

# one drain pass: parse every new or changed replay of each source into ingest.docs
drain-once:
    docker compose run --rm --build drain drain --once

# one drain pass, then `dbt build` when ingest.docs holds a document the marts have not seen or a past build failed; the host cron runs this
ingest:
    #!/usr/bin/env bash
    set -uo pipefail
    pending=data/dbt-build-pending  # git-ignored; set before a build, removed when it succeeds
    docker compose run --rm --build -T drain drain --once; status=$?
    # Decided from the tables, not the drain's output, so a pass that inserted and then died still builds.
    # A missing w3g.raw_replays (no build yet) errors, which the fallback reads as "build".
    behind=$(docker compose exec -T clickhouse clickhouse-client ${CLICKHOUSE_PASSWORD:+--password="$CLICKHOUSE_PASSWORD"} \
      -q 'SELECT (SELECT max(ingested_at) FROM ingest.docs) > (SELECT max(ingested_at) FROM w3g.raw_replays)' 2>/dev/null || echo 1)
    if [ "$behind" = 1 ] || [ -e "$pending" ]; then
      mkdir -p data && touch "$pending"
      {{ just_executable() }} local::dbt build || exit
      rm -f "$pending"
    fi
    exit $status

# the parser's melee object tables as JSONEachRow on stdout
export-mappings:
    @docker compose run --rm --no-deps -T drain export-mappings /dev/stdout

# the drain's unit tests and parser goldens, in the test stage of the drain image
drain-test:
    docker build --target test --progress plain -f infrastructure/docker/Dockerfile.drain .

# rewrite pipeline/parse-rs/tests/goldens from the fixtures with the drain image's parse, as
# sorted-key JSON; the git diff is the parser-change review
goldens:
    #!/usr/bin/env bash
    set -euo pipefail
    out=$(mktemp -d); trap 'rm -rf "$out"' EXIT
    docker compose run --rm --no-deps --build --user "$(id -u):$(id -g)" --entrypoint sh \
      -v "$PWD/pipeline/parse-rs/fixtures:/in:ro" -v "$out:/out" drain -c 'parse /out /in/*.w3g'
    docker run --rm --user "$(id -u):$(id -g)" -v "$out:/out:ro" -v "$PWD/pipeline/parse-rs/tests/goldens:/goldens" \
      node:22-slim node -e '
        const fs = require("fs");
        const sort = (v) => Array.isArray(v) ? v.map(sort) : v && typeof v === "object"
          ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
        for (const f of fs.readdirSync("/out").filter((f) => f.endsWith(".json")))
          fs.writeFileSync("/goldens/" + f, JSON.stringify(sort(JSON.parse(fs.readFileSync("/out/" + f, "utf8"))), null, 1));'

# copy every .w3g under a folder changed since a date into the bucket's replays/<dest>/, keeping
# subfolders and skipping LastReplay.w3g (the client rewrites it after each game), such as
# `just local::upload-replays /home/daniel/warcraft/w3warehouse/data/w3g/replay_service 2000-01-01 w3warehouse-ladder`
[positional-arguments]
upload-replays dir since dest='local':
    #!/usr/bin/env bash
    set -euo pipefail
    stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
    (cd "$1" && find . -type f -name '*.w3g' ! -name 'LastReplay.w3g' -newermt "$2" -exec cp --parents -p {} "$stage/" \;)
    echo "uploading $(find "$stage" -type f | wc -l) replays"
    docker compose run --rm --no-deps -v "$stage:/upload:ro" -e KEY="$W3WAREHOUSE_S3_ACCESS_KEY" \
      -e SECRET="$W3WAREHOUSE_S3_SECRET_KEY" --entrypoint sh minio-setup -c \
      "mc alias set local http://minio:9000 \"\$KEY\" \"\$SECRET\" >/dev/null && mc cp -q -r /upload/ \"local/\$BUCKET/\${PREFIX:+\$PREFIX/}replays/$3/\""

# the MinIO client against the local bucket, aliased `local`, such as
# `just local::mc ls -r local/warehouse/preview/replays/goldens`
[positional-arguments]
mc *args:
    docker compose run --rm --no-deps -e KEY="$W3WAREHOUSE_S3_ACCESS_KEY" -e SECRET="$W3WAREHOUSE_S3_SECRET_KEY" \
      --entrypoint sh minio-setup -c 'mc alias set local http://minio:9000 "$KEY" "$SECRET" >/dev/null && mc "$@"' mc "$@"

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
    docker compose run --rm --no-deps --build -v "$PWD/api:/api" api uv run --frozen pytest "$@"

# rewrite the answers in api/tests/cases/ from the live stack; review the git diff
api-cases-update:
    docker compose run --rm --no-deps --build -v "$PWD/api:/api" -e UPDATE_CASES=1 api uv run --frozen pytest tests/test_cases.py

# rewrite api/uv.lock from api/pyproject.toml, in the API image as you
api-lock:
    docker compose run --rm --no-deps --user "$(id -u):$(id -g)" -e UV_CACHE_DIR=/tmp/uv -v "$PWD/api:/api" api uv lock

# rewrite web/pnpm-lock.yaml from web/package.json, in a node container as you
web-lock:
    docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
      -v "$PWD/web:/web" -w /web node:22-slim corepack pnpm install --lockfile-only --store-dir /tmp/pnpm-store

# a node script from an absolute folder, mounted read-only, such as the dataviz palette check
# `just local::node /tmp/vp validate_palette.js "#02927B,#C061D6" --mode light --surface "#F4F5F1"`
[positional-arguments]
node dir *args:
    d="$1"; shift; docker run --rm --user "$(id -u):$(id -g)" -v "$d:/work:ro" -w /work node:22-slim node "$@"

# cargo on a crate from an absolute folder, mounted read-only, in a rust container as you,
# such as the w3grs fork's tests `just local::cargo /home/daniel/warcraft/w3grs test --all-features`
[positional-arguments]
cargo dir *args:
    d="$1"; shift; docker run --rm --user "$(id -u):$(id -g)" -e CARGO_HOME=/tmp/cargo -e CARGO_TARGET_DIR=/tmp/target \
      -v "$d:/work:ro" -w /work rust:1-slim-bookworm cargo "$@"

# eslint over web/, in the lint stage of the web image
web-lint:
    docker build --target lint --output type=cacheonly --progress plain -f infrastructure/docker/Dockerfile.web .

# the Playwright tests in web/e2e against the running stack, such as `just local::e2e --grep chat`; screenshots go to web/e2e/shots/
[positional-arguments]
e2e *args:
    docker compose run --rm --no-deps --user "$(id -u):$(id -g)" e2e "$@"
