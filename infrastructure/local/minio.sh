#!/usr/bin/env bash
# Stand up a real MinIO locally WITHOUT Docker, from the official release
# binaries — for environments where Docker isn't available (e.g. WSL without
# Docker Desktop integration). It provides the same S3 endpoint the
# docker-compose path does; the acquisition seam only needs a reachable S3 API.
#
# Binaries are cached in ~/.local/bin (minio ~100MB, mc ~25MB). Object data
# lives under acquire/.minio-data (gitignored, ephemeral, re-seeded from
# acquire/fixtures/1v1).
#
#   bash scripts/minio_host.sh up           # download (if needed) + start + seed
#   bash scripts/minio_host.sh status       # health + bucket listing
#   bash scripts/minio_host.sh seed-parsed  # push data/json/replays/ → landing/parsed/
#   bash scripts/minio_host.sh down         # stop the server (keep binaries)
#   bash scripts/minio_host.sh purge        # stop + delete the data dir
#
# Honors the same env as the rest of the proof:
#   MINIO_ROOT_USER/PASSWORD (default minioadmin), S3_BUCKET_NAME (w3c-replays),
#   MINIO_API_PORT (9000), MINIO_CONSOLE_PORT (9001).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACQUIRE_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "${ACQUIRE_DIR}/../.." && pwd)"
DATA_DIR="${ACQUIRE_DIR}/.minio-data"
FIXTURES="${ACQUIRE_DIR}/fixtures/1v1"
BIN_DIR="${HOME}/.local/bin"
MINIO_BIN="${BIN_DIR}/minio"
MC_BIN="${BIN_DIR}/mc"
PIDFILE="${DATA_DIR}/.minio.pid"
LOGFILE="${DATA_DIR}/.minio.log"

USER_="${MINIO_ROOT_USER:-minioadmin}"
PASS_="${MINIO_ROOT_PASSWORD:-minioadmin}"
BUCKET="${S3_BUCKET_NAME:-w3c-replays}"
API_PORT="${MINIO_API_PORT:-9000}"
CONSOLE_PORT="${MINIO_CONSOLE_PORT:-9001}"
ENDPOINT="http://localhost:${API_PORT}"
ALIAS="w3proof"

# seed-parsed: bulk-push the locally-parsed corpus into the parsed-JSON landing
# prefix, so the s3() backfill (db/w3g/backfill.sql) and S3Queue stream can
# ingest it — the local mirror of the production object-store path. Bucket is
# `landing` (what stream.sql / backfill expect), NOT $BUCKET (the acquire S3
# source's). The s3()/queue gate reads `id` from the doc, so the object key is
# irrelevant — a flat parsed/bulk/ mirror is enough.
PARSED_BUCKET="${PARSED_BUCKET:-landing}"
PARSED_PREFIX="${PARSED_PREFIX:-parsed/bulk/}"
# Default to this repo's parsed corpus; override PARSED_SRC to push another tree
# (e.g. a sibling checkout's data/json/replays).
PARSED_SRC="${PARSED_SRC:-${REPO_ROOT}/data/json/replays}"

case "$(uname -m)" in
  x86_64|amd64)   ARCH=amd64 ;;
  aarch64|arm64)  ARCH=arm64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

ensure_binaries() {
  mkdir -p "$BIN_DIR"
  if [ ! -x "$MINIO_BIN" ]; then
    echo "[minio-host] downloading minio (linux-$ARCH)..."
    curl -fSL "https://dl.min.io/server/minio/release/linux-${ARCH}/minio" -o "$MINIO_BIN"
    chmod +x "$MINIO_BIN"
  fi
  if [ ! -x "$MC_BIN" ]; then
    echo "[minio-host] downloading mc (linux-$ARCH)..."
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
  echo "[minio-host] MinIO did not become ready; see $LOGFILE" >&2
  return 1
}

seed() {
  "$MC_BIN" alias set "$ALIAS" "$ENDPOINT" "$USER_" "$PASS_" >/dev/null
  "$MC_BIN" mb --ignore-existing "${ALIAS}/${BUCKET}" >/dev/null
  "$MC_BIN" cp --recursive "${FIXTURES}/" "${ALIAS}/${BUCKET}/1v1/" >/dev/null
  echo "[minio-host] seeded ${BUCKET}/1v1:"
  "$MC_BIN" ls --recursive "${ALIAS}/${BUCKET}"
}

seed_parsed() {
  # Probe the endpoint, not our PID file — MinIO may be the compose service
  # (published on the same port) rather than one this script launched.
  curl -fsS "${ENDPOINT}/minio/health/live" >/dev/null 2>&1 \
    || { echo "[minio-host] no MinIO at ${ENDPOINT} — start one first ('up' or compose 'stream')" >&2; exit 1; }
  [ -d "$PARSED_SRC" ] || { echo "[minio-host] no parsed corpus at $PARSED_SRC — run scripts/pipeline.sh first" >&2; exit 1; }
  ensure_binaries
  "$MC_BIN" alias set "$ALIAS" "$ENDPOINT" "$USER_" "$PASS_" >/dev/null
  "$MC_BIN" mb --ignore-existing "${ALIAS}/${PARSED_BUCKET}" >/dev/null
  echo "[minio-host] mirroring ${PARSED_SRC}/ → ${PARSED_BUCKET}/${PARSED_PREFIX}"
  "$MC_BIN" mirror --overwrite "${PARSED_SRC}/" "${ALIAS}/${PARSED_BUCKET}/${PARSED_PREFIX}"
  echo "[minio-host] $("$MC_BIN" ls --recursive "${ALIAS}/${PARSED_BUCKET}/${PARSED_PREFIX}" | wc -l) object(s) under ${PARSED_BUCKET}/${PARSED_PREFIX}"
}

up() {
  ensure_binaries
  mkdir -p "$DATA_DIR"
  if is_running; then
    echo "[minio-host] already running (pid $(cat "$PIDFILE")) at $ENDPOINT"
  else
    echo "[minio-host] starting MinIO at $ENDPOINT (console :$CONSOLE_PORT)"
    MINIO_ROOT_USER="$USER_" MINIO_ROOT_PASSWORD="$PASS_" \
      "$MINIO_BIN" server "$DATA_DIR" \
        --address ":${API_PORT}" --console-address ":${CONSOLE_PORT}" \
        >"$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    wait_ready
  fi
  seed
  echo "[minio-host] up. S3_ENDPOINT=$ENDPOINT  S3_BUCKET_NAME=$BUCKET  creds=$USER_/<password>"
}

down() {
  if is_running; then
    kill "$(cat "$PIDFILE")" && echo "[minio-host] stopped"
  else
    echo "[minio-host] not running"
  fi
  rm -f "$PIDFILE"
}

status() {
  if is_running; then echo "[minio-host] running (pid $(cat "$PIDFILE")) at $ENDPOINT"
  else echo "[minio-host] not running"; fi
  curl -fsS "${ENDPOINT}/minio/health/live" >/dev/null 2>&1 && echo "  health: OK" || echo "  health: unreachable"
  [ -x "$MC_BIN" ] && "$MC_BIN" alias set "$ALIAS" "$ENDPOINT" "$USER_" "$PASS_" >/dev/null 2>&1 \
    && "$MC_BIN" ls --recursive "${ALIAS}/${BUCKET}" 2>/dev/null || true
}

case "${1:-up}" in
  up)          up ;;
  down)        down ;;
  status)      status ;;
  seed-parsed) seed_parsed ;;
  purge)       down; rm -rf "$DATA_DIR"; echo "[minio-host] purged $DATA_DIR" ;;
  *) echo "usage: $0 {up|down|status|seed-parsed|purge}" >&2; exit 2 ;;
esac
