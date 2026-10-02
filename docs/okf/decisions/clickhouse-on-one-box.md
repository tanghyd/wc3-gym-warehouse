---
type: Decision
title: ClickHouse on one box, data in the bucket
description: "The warehouse runs as one compose project on one small box, reads replays from the bucket, and holds no data the bucket cannot rebuild."
tags: [deploy]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: plan
    resource: Maintainers' decision, 2026-09-04, held 2026-10-02
    title: Hosting
---

# Decision

The whole stack is one compose project: ClickHouse, the drain, dbt, the API, the inspector and Grafana, on one box, with the replays in an object store bucket. Made 2026-09, held 2026-10.

# Why

A replay warehouse is a tool for a league of hundreds of players, not a service with its own operations team. One box keeps every query available with no egress rule to police; a managed ClickHouse would cost many times more for the same SQL; the league app's Postgres would need a second search compiler for a dialect without sequence matching. The bucket is the record, so the box carries no backup duty.

# What it means for new code

Memory and CPU are shared. A query cap lives in the ClickHouse profiles; a new service names its memory limit in `compose.yaml`; a heavy build step runs under the ingest lock, never beside a pass.
