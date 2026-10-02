---
type: Decision
title: The bucket is the record
description: "The raw replays in the bucket are the only irreplaceable data; ClickHouse is rebuilt from them and is not backed up."
tags: [deploy, data]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: deploy
    resource: ../../deploy.md
    title: Backups
---

# Decision

Made 2026-10-02. The raw `.w3g` objects are the record. ClickHouse holds only what a drain pass and a dbt build derive from them, so the box keeps no database backup; a lost box is a new box plus one ingest pass.

# Why

Every table is a function of the raw files and the code. A backup of the derived data would protect nothing the bucket does not, and would need its own schedule, storage and restore test.

# What it means for new code

Nothing may be written only to ClickHouse. A hand-kept fact goes in a seed in git; a derived fact goes in a model. The drain never deletes or moves an object.
