---
type: Convention
title: How this bundle is written
description: "The rules for every file under docs/okf, and the one rule for talking about the other repositories."
resource: https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md
tags: [tooling]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: okf-spec
    resource: https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md
    title: Open Knowledge Format v0.2 specification
---

# What this bundle is

`docs/okf/` is an Open Knowledge Format (OKF) bundle: a directory of markdown files with YAML frontmatter, readable by a person and by an AI agent. Each file is one concept. The file path is the concept id. `index.md` lists a directory and `log.md` records changes; every other `.md` file is a concept.

# Frontmatter

Every concept starts with a YAML block. `type` is required: Repository, Guide, Convention, Domain Concept, Data Model, API Area, Integration, Runbook, Decision or Pitfall. The other fields: `title`, `description` (one sentence, repeated word for word in the directory index), `tags` from the fixed list below, `generated: { by, at }` (who wrote the current text and when), `verified` (who read it against the code), `status`, `stale_after` on a runbook, and `sources` (what the text was written from, as relative paths into the repository or URLs). A value that holds `: ` is written in double quotes.

`tags` name the areas a concept belongs to: pipeline, data, api, web, deploy, observability, testing, tooling. The bundle test refuses a tag outside the list; add to the list in the same pull request when an area is new.

# Links

Links between concepts are relative markdown links, so GitHub renders them. A source inside the repository is a relative path from the concept file, for example `../../../dbt/models/marts/replays.sql`.

# The one rule about other repositories

The league app lives in other repositories with their own bundles. This bundle describes only what this repository proves. Another repository is named through its contract: an object key layout, an environment variable name, an HTTP route. Never a file path into it. The root `index.md` has one "Neighbouring bundles" section with the GitHub root of each neighbour, and nothing else points across.

# Writing

Short sentences, one fact each, present tense, active voice. Say what is, not what used to be. A decision says when it was made and why. Never name a person and never quote one.

The bundle is public. What never goes in, and the check to run before a commit, is [`AGENTS.md`](../../../AGENTS.md) at the repository root.

# Keeping it true

- A pull request that changes a fact this bundle states changes the concept in the same pull request and updates `generated.at`.
- A concept that no longer holds gets `status: deprecated` and one line naming what replaced it.
- `log.md` gets one line per change that alters the state of things, newest first.
- `api/tests/test_okf.py` checks every concept's frontmatter, that each index lists its directory with the concepts' own descriptions, that every relative link and source resolves, that no file holds an id-shaped number, an email, a connection string, a token, a hostname or an IP address, and that every dbt model is named in a Data Model concept under `data/`.
