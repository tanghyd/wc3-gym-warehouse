#!/usr/bin/env bash
# Stand up a real MinIO on the host from the official release binaries, for
# machines with no Docker. It serves the same S3 API the R2 bucket does, so the
# drain and ClickHouse's s3() need no change beyond the endpoint.
#
#   bash infrastructure/local/minio.sh up      # download (if needed), start, create the bucket
#   bash infrastructure/local/minio.sh status  # health + bucket listing
#   bash infrastructure/local/minio.sh down    # stop the server, keep the data
#   bash infrastructure/local/minio.sh purge   # stop and delete the data dir
#
# Binaries are cached in ~/.local/bin (minio ~100MB, mc ~25MB). Object data lives
# under W3WAREHOUSE_MINIO_DATA, outside the repo.
#
# Reads the same env the drain does: W3WAREHOUSE_S3_ACCESS_KEY /
# W3WAREHOUSE_S3_SECRET_KEY (default minioadmin), W3WAREHOUSE_S3_BUCKET
# (default replays), plus MINIO_API_PORT (9000) and MINIO_CONSOLE_PORT (9001).
set -euo pipefail

DATA_DIR="${W3WAREHOUSE_MINIO_DATA:-${XDG_STATE_HOME:-${HOME}/.local/state}/wc3-gym-warehouse/minio}"
BIN_DIR="${HOME}/.local/bin"
MINIO_BIN="${BIN_DIR}/minio"
MC_BIN="${BIN_DIR}/mc"
PIDFILE="${DATA_DIR}/.minio.pid"
LOGFILE="${DATA_DIR}/.minio.log"

USER_="${W3WAREHOUSE_S3_ACCESS_KEY:-minioadmin}"
PASS_="${W3WAREHOUSE_S3_SECRET_KEY:-minioadmin}"
BUCKET="${W3WAREHOUSE_S3_BUCKET:-warehouse}"
API_PORT="${MINIO_API_PORT:-9000}"
CONSOLE_PORT="${MINIO_CONSOLE_PORT:-9001}"
ENDPOINT="http://localhost:${API_PORT}"
ALIAS="wc3gym"

case "$(uname -m)" in
  x86_64|amd64)   ARCH=amd64 ;;
  aarch64|arm64)  ARCH=arm64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

ensure_binaries() {
  mkdir -p "$BIN_DIR"
  if [ ! -x "$MINIO_BIN" ]; then
    echo "[minio] downloading minio (linux-$ARCH)..."
    curl -fSL "https://dl.min.io/server/minio/release/linux-${ARCH}/minio" -o "$MINIO_BIN"
    chmod +x "$MINIO_BIN"
  fi
  if [ ! -x "$MC_BIN" ]; then
    echo "[minio] downloading mc (linux-$ARCH)..."
    curl -fSL "https://dl.min.io/client/mc/release/linux-${ARCH}/mc" -o "$MC_BIN"
    chmod +x "$MC_BIN"
  fi
}

is_running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

wait_ready() {
  for _ in $(seq 1 60); do
    curl -fsS "${ENDPOINT}/minio/health/live" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "[minio] MinIO did not become ready; see $LOGFILE" >&2
  return 1
}

up() {
  ensure_binaries
  mkdir -p "$DATA_DIR"
  if is_running; then
    echo "[minio] already running (pid $(cat "$PIDFILE")) at $ENDPOINT"
  else
    echo "[minio] starting MinIO at $ENDPOINT (console :$CONSOLE_PORT)"
    MINIO_ROOT_USER="$USER_" MINIO_ROOT_PASSWORD="$PASS_" \
      "$MINIO_BIN" server "$DATA_DIR" \
        --address ":${API_PORT}" --console-address ":${CONSOLE_PORT}" \
        >"$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    wait_ready
  fi
  "$MC_BIN" alias set "$ALIAS" "$ENDPOINT" "$USER_" "$PASS_" >/dev/null
  "$MC_BIN" mb --ignore-existing "${ALIAS}/${BUCKET}" >/dev/null
  echo "[minio] up. endpoint=localhost:${API_PORT} bucket=${BUCKET}"
}

down() {
  if is_running; then
    kill "$(cat "$PIDFILE")" && echo "[minio] stopped"
  else
    echo "[minio] not running"
  fi
  rm -f "$PIDFILE"
}

status() {
  if is_running; then echo "[minio] running (pid $(cat "$PIDFILE")) at $ENDPOINT"
  else echo "[minio] not running"; fi
  curl -fsS "${ENDPOINT}/minio/health/live" >/dev/null 2>&1 && echo "  health: OK" || echo "  health: unreachable"
  [ -x "$MC_BIN" ] && "$MC_BIN" ls --recursive "${ALIAS}/${BUCKET}" 2>/dev/null || true
}

case "${1:-up}" in
  up)     up ;;
  down)   down ;;
  status) status ;;
  purge)  down; rm -rf "$DATA_DIR"; echo "[minio] purged $DATA_DIR" ;;
  *) echo "usage: $0 {up|down|status|purge}" >&2; exit 2 ;;
esac
