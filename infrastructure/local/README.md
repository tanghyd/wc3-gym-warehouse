# infrastructure/local — host-native dev runtime

The no-container way to stand up the warehouse for local development: a
clickhouse-server running directly on the host, on `127.0.0.1` (HTTP 8123 /
TCP 9000). It is the default target of `scripts/pipeline.sh`, the refresh cron, and the
API in dev. The containerised alternative — the full reproducible/deploy stack —
is `compose.yaml` + [`../docker/`](../docker/). "local" here means *host-native*,
not "runs on your machine": Docker runs locally too.

## What's here

- `server.sh` — foreground launcher + stop helper (`just ch` / `just ch-stop`).
- `config/config.xml.template` — rendered to `config/config.xml` at launch;
  `@@WAREHOUSE_ROOT@@` → the `file()` chroot, `@@STATE_DIR@@` → the engine state dir.
- `config/users.xml` — loopback, passwordless (local only).

## Minimal footprint — the rule for this folder

This directory holds **tracked source only**. Engine state (`data/ logs/ tmp/
format_schemas/`) lives **outside the repo** under
`${W3WAREHOUSE_CH_STATE:-${XDG_STATE_HOME:-~/.local/state}/w3warehouse/clickhouse-local}`;
the sole gitignored artifact left inside is the rendered `config/config.xml`.

If something you want to add here can't keep that shape — if it needs runtime
state in the tree, a heavier config, or its own services — it belongs in
[`../docker/`](../docker/), or it shouldn't exist. The host-native path earns its
keep by being the smallest thing that gives a working warehouse with no
container overhead. Keep it that way.
