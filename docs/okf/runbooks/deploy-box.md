---
type: Runbook
title: Deploy the box
description: "Set up one Linux box, give it the environment, start the stack, schedule the ingest, open the pages over an ssh forward."
resource: ../../../just/deploy.just
tags: [deploy]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
stale_after: "2027-04-02"
sources:
  - id: deploy
    resource: ../../../just/deploy.just
    title: The recipes
  - id: doc
    resource: ../../deploy.md
    title: The runbook
---

The `just deploy *` recipes act on one box named by `BOX_SSH` (`user@host`, in `.env` or the shell). `docs/deploy.md` is the full runbook.

1. `just deploy bootstrap <host>` runs `infrastructure/box/bootstrap.sh` as root once: a `warehouse` user, Docker, `just`, a firewall that allows only ssh, unattended upgrades, container log rotation, swap, and the clone. It is safe to run again.
2. Copy `.env.example` to `.env.box`, set every ClickHouse password, the bucket's read-only key pair, the prefix, `COMPOSE_PROFILES=` (empty: no MinIO), and turn anonymous Grafana off with an admin password. `just deploy env` copies it to the box and refuses it when a password is empty or anonymous admin is on.
3. `just deploy up <branch>` checks out the branch on the box, builds and starts the services, applies the ingest tables, and runs one ingest pass with a build.
4. `just deploy cron` runs `just ingest` every ten minutes under a lock, each pass killed after thirty minutes, logging to `~/ingest.log`.
5. `just deploy open` forwards the inspector, the API, Grafana and the docs to localhost until Ctrl-C; `just deploy urls` prints them. `just deploy status` shows the containers, the disk and the last passes.
6. `just deploy down` stops every container and drops the cron line; the ClickHouse volume and the clone stay.

A new box needs no restore: the bucket is [the record](../decisions/bucket-is-the-record.md), and one ingest pass rebuilds every mart.
