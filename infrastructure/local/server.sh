#!/usr/bin/env bash
# Foreground launcher (and stop helper) for a host-native clickhouse-server —
# the no-Docker way to run the warehouse locally.
#
# Usage:
#   bash infrastructure/local/server.sh            # launch, foreground; Ctrl-C to stop
#   bash infrastructure/local/server.sh stop       # signal a running server to shut down
#
# Launch runs in the current terminal with live log output. Engine state
# (data/logs/tmp) lives OUTSIDE the repo, under STATE_DIR (below); only the
# rendered config.xml stays in config/ (gitignored). Full logs go to
# $STATE_DIR/logs/clickhouse-server.{log,err.log}.
#
# The `stop` subcommand sends SIGTERM via `pkill clickhouse-serv` — Linux
# truncates /proc/*/comm to 15 chars, so the literal `clickhouse-server`
# (17 chars) is a silent no-op while `clickhouse-serv` (15) matches. The
# watchdog exits cleanly with its child on SIGTERM, so no respawn.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Engine state lives outside the repo tree so the tracked folder stays pure
# source. Override with W3WAREHOUSE_CH_STATE; defaults to the XDG state dir.
STATE_DIR="${W3WAREHOUSE_CH_STATE:-${XDG_STATE_HOME:-${HOME}/.local/state}/wc3-gym-warehouse/clickhouse-local}"

cmd="${1-start}"

case "${cmd}" in
    stop)
        if ! pgrep -f "clickhouse-server --config-file=${HERE}/config/config.xml" >/dev/null; then
            echo "no clickhouse-server matching ${HERE}/config/config.xml is running"
            exit 0
        fi
        echo "sending SIGTERM to clickhouse-serv (15-char comm match)..."
        pkill clickhouse-serv
        # Brief settle so the watchdog and child both exit before we return.
        for _ in 1 2 3 4 5 6 7 8 9 10; do
            if ! pgrep -f "clickhouse-server --config-file=${HERE}/config/config.xml" >/dev/null; then
                echo "stopped."
                exit 0
            fi
            sleep 0.5
        done
        echo "still running after 5s — check ${STATE_DIR}/logs/clickhouse-server.err.log" >&2
        exit 1
        ;;
    start|"")
        if pgrep -f "clickhouse-server --config-file=${HERE}/config/config.xml" >/dev/null; then
            echo "clickhouse-server is already running for this config. Stop it first: bash infrastructure/local/server.sh stop" >&2
            exit 1
        fi
        # Engine state dirs live outside the repo — create them so a fresh
        # checkout is self-sufficient.
        mkdir -p "${STATE_DIR}/data" "${STATE_DIR}/logs" "${STATE_DIR}/tmp" "${STATE_DIR}/format_schemas"
        # Render runtime config from template with envsubst, substituting the
        # absolute warehouse root (the file() chroot) and the engine state dir.
        # Restricting envsubst to these two names leaves any other ${...} in the
        # XML untouched. config.xml is gitignored (per-machine); the template is
        # the source of truth.
        WAREHOUSE_ROOT="$(cd "${HERE}/../.." && pwd)"   # infrastructure/local/ -> repo root
        # Share the box's memory, merge and log-TTL limits with the container path.
        mkdir -p "${HERE}/config/config.d"
        cp "${HERE}/../docker/clickhouse/tuning.xml" "${HERE}/config/config.d/tuning.xml"
        W3W_WAREHOUSE_ROOT="${WAREHOUSE_ROOT}" W3W_STATE_DIR="${STATE_DIR}" \
            envsubst '${W3W_WAREHOUSE_ROOT} ${W3W_STATE_DIR}' \
            < "${HERE}/config/config.xml.template" > "${HERE}/config/config.xml"
        cd "${HERE}/config"
        exec clickhouse-server --config-file="${HERE}/config/config.xml"
        ;;
    *)
        echo "usage: bash infrastructure/local/server.sh [start|stop]" >&2
        exit 2
        ;;
esac
