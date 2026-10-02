---
type: Pitfall
title: The subnet lives in two files
description: "The compose network's fixed subnet is named in compose.yaml and again in the ClickHouse users file; changing one locks the drain out."
tags: [deploy]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: compose
    resource: ../../../compose.yaml
    title: The network
  - id: users
    resource: ../../../infrastructure/docker/clickhouse/users.xml
    title: The users
---

# What happened

The compose network has a fixed subnet so the ClickHouse users file can allow the `default` and `ingest` users from compose containers only. A changed subnet in `compose.yaml` left the users file naming the old one, and every drain insert was refused.

# The rule

Change the subnet in both files in one commit. `docker compose up` keeps an old network across a subnet change, so run `just local::down` first.
