# infrastructure/local — running without Docker

Two scripts that stand up the same pieces `compose.yaml` does, straight on the
host, for machines with no Docker.

- `server.sh` — a foreground clickhouse-server on `127.0.0.1` (HTTP 8123, native
  9000). It renders `config/config.xml` from the template and copies
  `../docker/clickhouse/tuning.xml` into `config/config.d/`.
- `minio.sh` — a MinIO from the official release binaries, serving the same S3
  API as the R2 bucket.

Both keep their state outside the repo, under
`${XDG_STATE_HOME:-~/.local/state}/wc3-gym-warehouse/`. This folder holds tracked
source only; the rendered `config/config.xml` and `config/config.d/` are ignored.
