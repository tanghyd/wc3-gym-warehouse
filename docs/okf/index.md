---
okf_version: "0.2"
---

# wc3-gym-warehouse knowledge bundle

This directory is an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format) bundle for the Warcraft III replay warehouse. Start with [the repository overview](overview.md), then the directory that fits your question. Every file is one concept with YAML frontmatter; [how this bundle is written](conventions/okf-bundle.md) explains the fields, the links and the rule for other repositories.

# Sections

* [wc3-gym-warehouse](overview.md) - Warcraft III replays in a bucket, parsed by a Rust drain into ClickHouse, modelled by dbt, served by a query API and a replay inspector, watched by Grafana, all in one compose project.
* [Start here by question](questions.md) - The questions a new contributor or an agent asks first, each with the concept that answers it; the list is also the benchmark the bundle is read against.
* [conventions](conventions/index.md) - The rules the code and this bundle follow.
* [concepts](concepts/index.md) - The rules the data follows and the pages that show it.
* [data](data/index.md) - Every table, by layer: the ingest tables the drain writes, the landing and staging layer, the marts.
* [api](api/index.md) - The query API: routes, catalog, limits, observability.
* [runbooks](runbooks/index.md) - Run it on one machine; put it on a box.
* [decisions](decisions/index.md) - What was decided, when, why, and what it means for new code.
* [pitfalls](pitfalls/index.md) - Mistakes made once, with the rule that avoids each.

# Neighbouring bundles

The league app that uploads the replays lives in its own repositories, each with a bundle at `docs/okf/`. This bundle names them only through their contracts: the object key layout under `<environment>/replays/`, never a file path into them.

* `wc3-gym-backend` - https://github.com/Warcraft-Gym/wc3-gym-backend - the API that writes replays to the bucket.
* `wc3-gym-frontend` - https://github.com/Warcraft-Gym/wc3-gym-frontend - the league web app.

# Other documents in this repository

* [README](../../README.md) - Run it, the recipe table, how it fits together, the models, the API, the inspector, Grafana.
* [Deploy](../deploy.md) - The box runbook with its cost sheet and egress table.
* [Roadmap](../roadmap.md) - What is proposed and not built: a second instance for stat-events, the league bucket as a source, the deferred quality work.
