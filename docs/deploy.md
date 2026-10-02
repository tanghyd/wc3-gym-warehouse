# Deploy: one Hetzner box

The whole stack runs on one Hetzner Cloud box: ClickHouse, the API, the inspector, Grafana, dbt's docs site, and the
drain and dbt from a cron. Replays stay in R2. Only SSH is open; the inspector, Grafana and the docs are reached over an
ssh port forward. No public domain exists yet, so the `tunnel` profile (cloudflared) stays off.

**Status: no box exists yet.** Nothing here has run against one. `infrastructure/box/bootstrap.sh` is checked with
`bash -n`, and the `just deploy *` recipes with `just -n`. Prices were read 2026-10-02.

## The box

CX33: 4 vCPU (x86), 8 GB, 80 GB NVMe, 20 TB traffic, EU locations only (Germany, Finland). Wait for stock.

| Service | Measured |
|---|---|
| clickhouse | 1.11 GiB resident, 1.68 GiB peak on 1,746 replays (`compose.yaml`); 501 MiB idle |
| grafana | 450 MiB idle (`compose.yaml`); 281 MiB idle |
| api, web, docs | 63, 65, 27 MiB idle |
| **always on** | **937 MiB idle**; the peaks add up to about 2.3 GiB |

Idle figures: `docker stats` on the local stack, 2026-10-02. Not measured (`-`): the peak memory of the Rust drain image
build, of `next build` and of `dbt build` on the box.

Take the CX33. The box compiles the drain image and runs `next build` while ClickHouse is live, and a parser deploy
rebuilds the drain inside an unattended cron pass. Take the 4 GB CX23 only if it is the one in stock: bootstrap adds a
4 GB swapfile when the box has no swap, and deploys run while the cron is paused (`ssh $BOX_SSH crontab -r`, then
`just deploy up`, `just deploy ingest`, `just deploy cron`). The CX23 costs $7.09 a month (see Cost per month).

## Runbook

Before: push the branch (the box clones `https://github.com/tanghyd/wc3-gym-warehouse` and deploys pushed commits
only). In Cloudflare, create an R2 API token scoped to the bucket with **Object Read** only. The uploader (the GNL
backend) keeps the only write key; ClickHouse holds no bucket key at all.

1. **Order.** Hetzner Cloud, CX33, Ubuntu 24.04, your SSH public key, a public IPv4 (GitHub has no IPv6).
2. **Bootstrap.** `just deploy bootstrap <ip>` copies `infrastructure/box/bootstrap.sh` and runs it as root: Docker,
   ufw (OpenSSH only), log rotation, a 4 GB swapfile when the box has no swap, the `warehouse` user with root's SSH
   keys, just, the clone. It finishes an interrupted dpkg install first and retries `apt-get update` three times, 10 s
   apart. Safe to run again.
3. **Env.** Put `BOX_SSH=warehouse@<ip>` in your `.env`. `cp .env.example .env.box`, then in `.env.box`:
   `COMPOSE_PROFILES=` (empty), the four `CLICKHOUSE_*PASSWORD`s (`openssl rand -hex 24` each),
   `W3WAREHOUSE_S3_ENDPOINT=<account id>.r2.cloudflarestorage.com`, `W3WAREHOUSE_S3_SECURE=true`, the read-only
   token's key pair, the bucket, `W3WAREHOUSE_S3_PREFIX=production`. `just deploy env` copies it to the box's `.env`
   (mode 600). `.env.box` is git-ignored and is the only other copy, so keep the secrets in a password manager too.
4. **Deploy.** `just deploy up feature/dbt-prototype` until the branch merges, `just deploy up` after. It checks
   out the branch and runs `docker compose up -d --build --remove-orphans`: clickhouse, api, web, grafana and docs.
   MinIO (`local`) and cloudflared (`tunnel`) stay off. It then touches `data/dbt-build-pending`, so the next cron
   `just ingest` rebuilds the marts, even when no new replay lands. It also runs `docker image prune -f` and
   `docker builder prune -f --filter until=168h`, so old images and build cache do not fill the disk. Run it again after
   every push.
5. **Ingest.** `just deploy ingest` runs `just ingest` once: it builds the drain and dbt images, parses every replay
   under `<prefix>/replays/` and runs `dbt build`.
6. **Cron.** `just deploy cron` installs one line for the `warehouse` user: `just ingest` every 10 minutes under
   `flock -n /tmp/ingest.lock`, so passes never overlap, appending to `~/ingest.log` (not rotated; size per pass `-`).
   `just deploy ingest` and `just deploy up` take the same lock and wait for a running pass.
7. **Open.** `just deploy open` prints the URLs (`just deploy urls` prints them alone) and holds an ssh forward until Ctrl-C: the inspector on http://localhost:3000, the API on 8000, Grafana on 3001, dbt docs on 8080. Stop the local stack first: the ports are the same,
8. **Down.** `just deploy down` stops every container and drops the cron line; the ClickHouse volume and the clone stay on the disk. `just deploy up` then `just deploy cron` brings it back. Deleting the server in the Hetzner console is the only way to stop paying.
   and the forward exits rather than show the local stack.

| Local URL | On the box |
|---|---|
| http://localhost:3000 | the inspector, 127.0.0.1:3000 |
| http://localhost:3001 | Grafana, 127.0.0.1:3001 (anonymous admin; only an SSH key reaches it) |
| http://localhost:8080 | dbt's docs, 127.0.0.1:8080, after `ssh $BOX_SSH 'cd wc3-gym-warehouse && just local::docs'` |

The API (127.0.0.1:8000) and ClickHouse (127.0.0.1:8123) are not forwarded; the inspector reads the API inside the
box. `just deploy status` prints the containers, `df -h /`, the tail of `ingest.log` and the last dbt build summary.

## Cost per month

| Item | Requests per month | $ per month |
|---|---|---|
| Hetzner CX33 | - | 9.99 (EUR 8.49), excl. VAT and IPv4 (docs.hetzner.com price adjustment, from 2026-06-15) |
| Hetzner Cloud Primary IPv4 | - | 0.60 (EUR 0.50; docs.hetzner.com/cloud/servers/primary-ips/ pricing, read 2026-10-02) |
| R2 class A: LIST `replays/`, 1,000 keys a call, 4,320 passes | 8,640 at 1,746 replays; 86,400 at 20,000 | 0 (1 M free) |
| R2 class B: 1 GET per new or changed replay | new replays `-`; 1,746 or 20,000 once to rebuild | 0 (10 M free) |
| R2 storage, `replays/` | - | 0 (390.9 MB now, 4.48 GB at 20,000; 10 GB free) |
| Cloudflare tunnel | - | 0, off until a domain exists |
| Domain | - | 0 until one is bought |
| VAT | - | `-`, depends on the buyer's country |
| **Total** | | **10.59** excl. VAT (CX33 + IPv4); 7.09 with a CX23 |

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
Page bytes: measured 2026-10-01; the raw table `measure-1.tsv` is outside this repo
(threads/warehouse-dbt-prototype/deploy). R2 egress is free; the box includes 20 TB.

## Not backed up

R2 is the record; the warehouse keeps no copy of a replay. The rest is derived from R2 and the repo: the ClickHouse
volume (`ingest.*`, the `w3g` marts, system logs) by a re-parse, `dbt_target` and `dbt_cache` by `dbt build` and
`just local::docs`, and `grafana_data` by provisioning (edits made in Grafana's UI are lost); `~/ingest.log` is lost.
The box's `.env` is the one thing not derived: its copy is `.env.box` on your machine.

## Rebuilding a lost box

Order a new box, then `ssh-keygen -R <ip>` when the IP is reused (the old host key would fail the connection), then
`just deploy bootstrap <ip>`, set `BOX_SSH`, `just deploy env`, `just deploy up`, `just deploy ingest`, `just deploy cron`. The ingest re-reads every replay from R2 (1 class B GET each, 390.9 MB today).
The ingest design measured a re-parse of 1,743 replays at about 4 s, locally; the image builds and `dbt build` on the
box are `-`.

## Later: the inspector on Vercel

Not built. On Vercel the inspector's server side would call the API over the internet instead of `http://api:8000`, so
the API needs a public route (a hostname for `api:8000` under the `tunnel` profile, which needs the domain) and a
shared secret that Vercel sends on every request. Build these two first:

1. A rate limit on the public API, per client, before a query reaches ClickHouse. The per-query caps in `users.xml`
   (10 s, 2 GB) bound one query, not how many arrive.
2. Token rotation: the API accepts two secrets at once, so a new one goes into Vercel before the old one is dropped.

The API's JSON then leaves the box: 9,296 B gzip per home search (51,834 B plain)
and 1,341 B gzip per median `/replays/{id}` (11,307 B plain), measured 2026-10-01 (`measure-1.tsv`).
