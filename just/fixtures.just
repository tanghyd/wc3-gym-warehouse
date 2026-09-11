# The fixtures project: an empty ClickHouse on 127.0.0.1:8124 with the 3 parser goldens.
# It reuses the local recipes; compose reads these two values from the environment.
set working-directory := '..'

export COMPOSE_PROJECT_NAME := 'wh-fixtures'
export CLICKHOUSE_HTTP_PORT := '8124'

# drop the project and rebuild it from nothing: schema, mappings, the 3 fixtures
up: down
    {{ just_executable() }} local::schema local::mappings local::fixtures

# remove the project and its volumes
down:
    docker compose --profile local down -v

# an interactive clickhouse-client on this project
ch:
    {{ just_executable() }} local::ch
