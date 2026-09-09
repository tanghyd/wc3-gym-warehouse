# wc3-gym-warehouse: replay analytics on Cloudflare R2 and a Hetzner box

ON ICE since 2026-09-04: Daniel paused analytics to focus on replay upload and download. The first cut is on `feature/initial-stack`, proven against a host ClickHouse and MinIO, no PR.

Written 2026-09-04 by Claude Code after a design conversation with Daniel. Not yet reviewed. Daniel pays for the box. Prices are from memory unless a command is given to check them. Supersedes the phase 2 sections of `../REPLAYS-PLAN.md`.

## Goal

GNL players open a page on the site, pick a build order and see every GNL game that opened that way, with a link to the replay and to the match. Later pages answer hero picks per matchup, APM per player and "A before B within T seconds" questions. The site stays the one client. Supabase carries none of the replay data.

## Why this shape

| Shape | Cost per month | Verdict |
|---|---|---|
| ClickHouse on Daniel's laptop | $0 | a tool for one person, not a service |
| Replay tables in the app's Postgres | $0 | needs a second Search compiler for a dialect without `sequenceMatch`, and every route must page to keep Supabase egress inside 5 GB |
| ClickHouse Cloud Basic | USD 66 and up | ten times the price for the same SQL |
| **w3warehouse's stack on a Hetzner box, data in R2** | **EUR 4** | reuses every query, no egress rule to police, one box to keep alive |

The clone at `~/code/warcraft/w3warehouse` already has everything but the hosting: the Rust parser and drain worker (`pipeline/parse-rs`), the ClickHouse schema and loaders (`db/w3g/tables.sql`, `views.sql`, `backfill.sql`, `stream.sql`), the API with Openers, Search and Stats (`services/api/src/api/`, the Search compiler in `compiler.py`), single-node tuning (`infrastructure/docker/clickhouse/tuning.xml`), a Caddy proxy and provisioned Grafana dashboards. Its deploy notes say the running stack idles at 1.2 GB and only the Rust compile wants 4 GB. Daniel allows refactoring it for GNL.

## Components

```
browser ──▶ Vercel: GNL SPA + FastAPI ──HTTPS + password──▶ Cloudflare edge ──tunnel──▶ Hetzner box
                      │                                                                  ├─ clickhouse (HTTP 8123, native 9000, localhost only)
                      │ put raw .w3g                                                     ├─ drain (parse worker, on a timer)
                      ▼                                                                  ├─ api (Openers, Search, Stats; optional)
               Cloudflare R2 bucket ◀──S3 API: list raw, put parsed, s3() load──────────┤─ grafana (optional)
               replays/<series id>/game<n>.w3g                                           └─ cloudflared
               parsed/v2/dt=<date>/<replay id>.json.zst
               status/<file hash>.json
browser ◀──public download, Cloudflare cached, free egress── R2 custom domain
```

| Part | Runs where | Job |
|---|---|---|
| GNL backend, `app/services/blob.py` | Vercel | `put_replay` writes the raw file to R2 instead of Vercel Blob and answers its public URL. One boto3 dependency, an R2 key pair in the Vercel env. Icons may stay in Vercel Blob. |
| GNL backend, `GET /replays/search` | Vercel | one HTTPS call to the warehouse with the filters, answers rows joined to series and match. Open read like every GET. The browser never talks to ClickHouse. |
| GNL frontend, `ReplaySearchView.vue` | Vercel | opener picker that adds buildings in order, filters for season, player, race, opponent race and first hero, a GroupedTable of games with links to the `.w3g` and the match page |
| R2 bucket | Cloudflare | the record. `replays/` is the only irreplaceable prefix. Public read on a custom domain for downloads. |
| `drain` | box | lists `replays/`, parses each new file in memory, writes the parsed document under `parsed/v2/` and a breadcrumb under `status/`. Refactor: read the series id and game number from the object key and write them as a `gnl` field in the document. |
| ClickHouse | box | `backfill.sql` on a cron reads the `parsed/` prefix with `s3()` into `replays_raw`; the materialized views fan out to `replays`, `replay_players` and `replay_events`; the Openers rollup refreshes every 10 minutes. Dedupes on replay id, so every run is a no-op over old data. |
| dims loader | box | reads the GNL API's open routes (seasons, series, players with battle tags) into small ClickHouse dimension tables, so a replay row finds its season, week, team and GNL user. Nightly. |
| `cloudflared` | box | holds outbound connections to Cloudflare and forwards to localhost. No inbound port is open on the box. |

## Data flow for one reported result

1. A player reports a result with up to three `.w3g` files. The backend checks the header and size, puts each file at `replays/<series id>/game<n>.w3g` in R2, and stores the URL on `series_replay` (backend #145, with `blob.py` pointed at R2).
2. Within the drain's interval the box lists `replays/`, sees a key with no breadcrumb, parses it, writes `parsed/v2/dt=<date>/<replay id>.json.zst` with the `gnl` field, and writes the breadcrumb.
3. Within the cron interval `backfill.sql` loads the new document. The views fan it out. The Openers rollup refreshes.
4. The search page shows the game.

Latency from report to searchable is the two intervals, minutes. A webhook from the backend to the box can cut it to seconds when someone asks.

## Network

- One new hop: the Vercel function calls `https://warehouse.<domain>` with a password header. Cloudflare terminates TLS, the tunnel carries it to the box, `cloudflared` forwards to ClickHouse or the API on localhost. ClickHouse gets a read-only user for this route.
- Loads never cross the tunnel: ClickHouse reads R2 over the S3 API directly.
- Downloads never touch the box or Supabase: the browser fetches from the R2 custom domain, cached by Cloudflare.
- Location: Hetzner's EU locations sell the CX line at EUR 4 with about 100 ms per hop to Vercel's us-east region. Ashburn sells only CPX from about EUR 8 with a few ms. A search is one hop, so start in the EU.

## Limits against GNL scale

A replay is about 250 bytes per game second. A season is 400 replays, 100 MB raw, 1 MB parsed. 800 player-game rows.

| Limit | Free tier or box | GNL per season |
|---|---|---|
| R2 storage | 10 GB | 101 MB, a hundred seasons |
| R2 writes, Class A | 1 million a month | about 1,200 |
| R2 reads, Class B | 10 million a month | one per replay per load, plus downloads |
| R2 egress | free | every download and every load |
| Hetzner traffic | 20 TB a month | negligible |
| Box memory | 4 GB | the stack idles at 1.2 GB |
| Vercel function body | 4.5 MB | a three-replay report is under 3 MB even for hour-long games |

## Cost

| Item | Per month |
|---|---|
| Hetzner CX22, 2 vCPU, 4 GB, 40 GB, or CAX11 on ARM | about EUR 4, plus about EUR 0.5 for IPv4 |
| Cloudflare: DNS, tunnel, R2 inside the free tier, custom domain | EUR 0 |
| GitHub Actions for the image build | EUR 0 on a public repo |

Next tier when ClickHouse crash-loops on out-of-memory, exit code 210: CX32 with 8 GB at about EUR 7, CAX21 at EUR 6.5, CPX21 in Ashburn at EUR 8. A rescale is stop, resize, start, and the disk keeps its data. Check live prices with `hcloud server-type list`.

## Repo: Warcraft-Gym/wc3-gym-warehouse

Derived from w3warehouse, cut to what GNL runs.

```
compose.yaml          clickhouse, drain, api, grafana, cloudflared
db/w3g/               tables, views, backfill, stream unchanged; plus gnl_dims.sql
pipeline/parse-rs/    parse + drain, drain reads the gnl fields from the object key
services/api/         Openers, Search, Stats as they are
loader/               the dims loader against the GNL API, one small Python module
infrastructure/       clickhouse tuning.xml, cloudflared config, the cron lines
.github/workflows/    build the images to GHCR on main, then ssh to the box: docker compose pull && up -d
```

Same rules as the other org repos: branch and PR to main, squash merge, Daniel merges. Secrets on the box are the R2 key pair, the ClickHouse passwords and the tunnel token, in an env file that is never committed.

## Operations

- **Rebuild from nothing**: new box, `docker compose up`, run `backfill.sql` over the whole `parsed/` prefix. Minutes. ClickHouse is derived state.
- **Schema change**: bump `parsed/v3`, rerun the drain over `replays/` with the breadcrumbs cleared, rebuild.
- **Backup**: the `replays/` prefix is the only record. `rclone sync` it to a second bucket or a laptop once a month. Nothing else needs a backup.
- **Down**: the search route answers an "offline" error and the rest of the site is unaffected. w3warehouse's `WarehouseOfflineGate` pattern applies.

## Transferability

The design is an S3 bucket, a Compose file and ClickHouse SQL. R2, S3, GCS and MinIO are interchangeable behind the S3 API, and w3warehouse already runs MinIO locally and S3 in production. Any Linux VM runs the Compose file. The SQL moves to ClickHouse Cloud untouched. The only edge-specific pieces are the tunnel, which swaps for Caddy with Let's Encrypt on a public IP, and the warehouse URL and password in the Vercel env.

## Build order

1. R2 bucket and custom domain; amend backend #145 so `put_replay` writes to R2. The `series_replay` rows and the download links then never move.
2. The repo: Compose file, the drain with the `gnl` field, the dims loader. Prove it locally against MinIO with the eight measured replays.
3. The box, the tunnel, the CI deploy. Prove `backfill.sql` loads from R2 on the box.
4. `GET /replays/search` in the backend and `ReplaySearchView.vue`. One PR each.
5. The S18 backfill from the Discord scrape (`scratch/discord-replays/scrape.py`), uploaded through the admin route into `replays/`, once the GNL bot token is available.

## Open

- The site's domain is on GoDaddy nameservers (checked 2026-09-04). The tunnel and the R2 custom domain need the full zone on Cloudflare; the partial setup that keeps GoDaddy is Business plan only. Fallback: a public IP with Caddy on the box and presigned R2 URLs for downloads.
- Matching replay player names to GNL users by battle tag: the profile field exists from the W3C sync, the loader does the join.
- Whether Grafana and the w3warehouse API are exposed at all, or only ClickHouse for the one route. Start with ClickHouse only.
- Whether the checksum-zeroed replay plays in game. If yes, the raw file shrinks to a third. That is a storage question, and this plan does not depend on it.
