# Deploy: one Hetzner box

The whole stack runs on one Hetzner Cloud box: ClickHouse, the API, the inspector, Grafana, dbt's docs site, and the
drain and dbt from a cron. Replays stay in R2. Only SSH is open; the inspector, Grafana and the docs are reached over an
ssh port forward. No public domain exists yet, so the `tunnel` profile (cloudflared) stays off.

**Status: no box exists yet.** Nothing here has run against one. `infrastructure/box/bootstrap.sh` is checked with
`bash -n`, and the `just box::*` recipes with `just -n`. Prices were read 2026-10-02.

## The box

CX33: 4 vCPU (x86), 8 GB, 80 GB NVMe, 20 TB traffic, EU locations only (Germany, Finland). Wait for stock.

The 4 GB CX23 is too small for the caps in `compose.yaml`:

| Service | mem_limit | Measured |
|---|---|---|
| clickhouse | 3g | 1.11 GiB resident, 1.68 GiB peak on 1,746 replays (`compose.yaml`); 501 MiB idle |
| grafana | 768m | 450 MiB idle (`compose.yaml`); 281 MiB idle |
| api, web, docs | 512m each | 63, 65, 27 MiB idle |
| **always on** | **5,376 MiB (5.25 GiB)** | 937 MiB idle |
| dbt, then the drain (one at a time) | 1g, 512m | - |
| **with a one-shot** | **6.25 GiB** | - |

Idle figures: `docker stats` on the local stack, 2026-10-02. ClickHouse at 2g still sums to 4.25 GiB always on, 5.25 GiB
with dbt. The measured peaks add up to about 2.3 GiB, but on a 4 GB box the caps would no longer stop one service from
starving the rest, and the box also builds the drain's Rust image (memory `-`).

## Runbook

Before: push the branch (the box clones `https://github.com/tanghyd/wc3-gym-warehouse` and deploys pushed commits
only). In Cloudflare, create an R2 API token scoped to the bucket with **Object Read** only. The uploader (the GNL
backend) keeps the only write key; ClickHouse holds no bucket key at all.

1. **Order.** Hetzner Cloud, CX33, Ubuntu 24.04, your SSH public key, a public IPv4 (GitHub has no IPv6).
2. **Bootstrap.** `just box::bootstrap <ip>` copies `infrastructure/box/bootstrap.sh` and runs it as root: Docker,
   ufw (OpenSSH only), log rotation, the `warehouse` user with root's SSH keys, just, the clone. Safe to run again,
   such as after an apt lock error on first boot.
3. **Env.** Put `BOX_SSH=warehouse@<ip>` in your `.env`. `cp .env.example .env.box`, then in `.env.box`:
   `COMPOSE_PROFILES=` (empty), the four `CLICKHOUSE_*PASSWORD`s (`openssl rand -hex 24` each),
   `W3WAREHOUSE_S3_ENDPOINT=<account id>.r2.cloudflarestorage.com`, `W3WAREHOUSE_S3_SECURE=true`, the read-only
   token's key pair, the bucket, `W3WAREHOUSE_S3_PREFIX=production`. `just box::env` copies it to the box's `.env`
   (mode 600). `.env.box` is git-ignored and is the only other copy, so keep the secrets in a password manager too.
4. **Deploy.** `just box::deploy feature/dbt-prototype` until the branch merges, `just box::deploy` after. It checks
   out the branch and runs `docker compose up -d --build --remove-orphans`: clickhouse, api, web, grafana and docs.
   MinIO (`local`) and cloudflared (`tunnel`) stay off. Run it again after every push.
5. **Ingest.** `just box::ingest` runs `just ingest` once: it builds the drain and dbt images, parses every replay
   under `<prefix>/replays/` and runs `dbt build`.
6. **Cron.** `just box::cron` installs one line for the `warehouse` user: `just ingest` every 10 minutes under
   `flock -n`, so passes never overlap, appending to `~/ingest.log` (not rotated; size per pass `-`).
7. **Open.** `just box::open` holds an ssh forward until Ctrl-C. Stop the local stack first: the ports are the same,
   and the forward exits rather than show the local stack.

| Local URL | On the box |
|---|---|
| http://localhost:3000 | the inspector, 127.0.0.1:3000 |
| http://localhost:3001 | Grafana, 127.0.0.1:3001 (anonymous admin; only an SSH key reaches it) |
| http://localhost:8080 | dbt's docs, 127.0.0.1:8080, after `ssh $BOX_SSH 'cd wc3-gym-warehouse && just local::docs'` |

The API (127.0.0.1:8000) and ClickHouse (127.0.0.1:8123) are not forwarded; the inspector reads the API inside the
box. `just box::status` prints the containers, `df -h /`, the tail of `ingest.log` and the last dbt build summary.

## Cost per month

| Item | Requests per month | $ per month |
|---|---|---|
| Hetzner CX33 | - | 9.99 (EUR 8.49), excl. VAT and IPv4 (docs.hetzner.com price adjustment, from 2026-06-15) |
| Hetzner primary IPv4 | - | billed apart; price not read on a Hetzner page, budget 1.00 |
| R2 class A: LIST `replays/`, 1,000 keys a call, 4,320 passes | 8,640 at 1,746 replays; 86,400 at 20,000 | 0 (1 M free) |
| R2 class B: 1 GET per new or changed replay | new replays `-`; 1,746 or 20,000 once to rebuild | 0 (10 M free) |
| R2 storage, `replays/` | - | 0 (390.9 MB now, 4.48 GB at 20,000; 10 GB free) |
| Cloudflare tunnel | - | 0, off until a domain exists |
| Domain | - | 0 until one is bought |
| **Total** | | **10.99 at most**; 13.74 with 25% VAT |

R2 prices: developers.cloudflare.com/r2/pricing ($4.50 per million class A, $0.36 per million class B, egress free).
LIST stays free up to 231,000 replays at this cadence. The free tier is per Cloudflare account, shared with GNL's
other R2 use (not checked). dbt and ClickHouse read no bucket.

## Egress

| Path | Bytes | Per month |
|---|---|---|
| R2 to box, LIST pages | `-` per page | 8,640 or 86,400 pages, bytes `-` |
| R2 to box, a new replay | 223,888 B average (390,908,511 B / 1,746) | new replays `-` |
| R2 to box, a rebuild | 390.9 MB at 1,746; 4.48 GB at 20,000 | once |
| box to browser, `GET /` (search list) | 80,556 B gzip (771,416 plain) | page loads `-` |
| box to browser, `/openers`; `/replays/{id}` median, largest | 38,815; 10,213; 19,012 B gzip | `-` |
| box to browser, JS and CSS on a first load | `-` | `-` |

Zero: box to R2 (the drain never writes), API to browser (the API stays inside the box), Supabase (nothing reads it).
Page bytes: `measure-1.tsv` (threads/warehouse-dbt-prototype/deploy). R2 egress is free; the box includes 20 TB.

## Not backed up

R2 is the record; the warehouse keeps no copy of a replay. The rest is derived from R2 and the repo: the ClickHouse
volume (`ingest.*`, the `w3g` marts, system logs) by a re-parse, `dbt_target` and `dbt_cache` by `dbt build` and
`just local::docs`, and `grafana_data` by provisioning (edits made in Grafana's UI are lost); `~/ingest.log` is lost.
The box's `.env` is the one thing not derived: its copy is `.env.box` on your machine.

## Rebuilding a lost box

Order a new box, then `just box::bootstrap <ip>`, set `BOX_SSH`, `just box::env`, `just box::deploy`,
`just box::ingest`, `just box::cron`. The ingest re-reads every replay from R2 (1 class B GET each, 390.9 MB today).
The ingest design measured a re-parse of 1,743 replays at about 4 s, locally; the image builds and `dbt build` on the
box are `-`.

## Later: the inspector on Vercel

Not built. On Vercel the inspector's server side would call the API over the internet instead of `http://api:8000`, so
the API needs a public route (a hostname for `api:8000` under the `tunnel` profile, which needs the domain) and a
shared secret that Vercel sends on every request. Build these two first:

1. A rate limit on the public API, per client, before a query reaches ClickHouse. The per-query caps in `users.xml`
   (10 s, 2 GB) bound one query, not how many arrive.
2. Token rotation: the API accepts two secrets at once, so a new one goes into Vercel before the old one is dropped.

The API's JSON then leaves the box: 9,296 B gzip per home search (51,834 B plain, `measure-1.tsv`).
