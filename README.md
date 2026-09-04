# wc3-gym-warehouse

Replay analytics for the GNL site. ClickHouse on one Hetzner box, replays in a Cloudflare R2 bucket, reached from the GNL backend through a Cloudflare Tunnel.

The design and build order are in [PLAN.md](PLAN.md).

Same rules as the other Warcraft-Gym repos: branch, PR to `main`, squash merge.

## Run it

Copy `.env.example` to `.env` and fill in the bucket credentials, then:

```
just up                 # clickhouse, the schema, and the drain
just mappings           # load the WC3 name mappings once
just drain-once         # parse everything new in replays/
just backfill 'http://localhost:9000/warehouse/parsed/v2/**.json'
just ch                 # a clickhouse-client shell
```

`docker compose --profile local up -d` adds a MinIO to stand in for the R2
bucket; `--profile prod` adds the Cloudflare Tunnel.

On a machine with no Docker, `infrastructure/local/` starts the same ClickHouse
and MinIO straight on the host.

## How it fits together

The GNL backend writes a reported replay to `replays/<series id>/game<n>.w3g` in
the bucket and keeps the public download URL. The drain lists that prefix, parses
each new or changed file, and writes the parsed document to
`parsed/v2/dt=<date>/<replay id>.json` with the series and game number in a `gnl`
field. It never moves or deletes the raw file. `backfill.sql` loads the parsed
prefix into ClickHouse, where the materialized views in `db/w3g/views.sql` fan it
out to per-player and per-event tables and the opener rollup.
