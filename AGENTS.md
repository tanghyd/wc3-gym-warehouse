# Guide for agents and contributors

## The knowledge bundle in `docs/okf/`

`docs/okf/` is public. Read [how the bundle is written](docs/okf/conventions/okf-bundle.md) before you change it. This file lists what never goes in and the check to run before a commit. A pull request that changes a model, a table, a route, a recipe or a decision updates the concept in `docs/okf/` that states it, in the same pull request.

### What never goes in

- **A person.** No name, handle, email, machine, in-game name or battle tag, not even a fixture player's. Write "the maintainers".
- **A conversation.** No quote, and no sentence about what people wanted, agreed or rejected. State the rule as it stands, with its date and its why.
- **A value.** No token, password, key, bucket name, account id, box address, tunnel token or default credential, even a local one. An environment variable name is fine. Its value never.
- **A posture.** Nothing about which ports are open, which users have passwords, how Grafana logs people in, what a bucket holds, or what anything costs. Write the operator instruction instead.
- **A weakness.** No unfixed defect or lost data. Open an issue with the detail; the bundle states the rule that holds once it is fixed.
- **Another organisation.** The vendors the code depends on are fine: Cloudflare, Hetzner, ClickHouse, dbt, Grafana, GitHub, W3Champions. No other site, community or person.

### Before you commit

1. Read your own diff once as a stranger on the internet. For each sentence ask: does it name a person, tell a story, hold a value, describe a posture, or expose a weakness? Rewrite it as the current rule.
2. Run `just local::api-test tests/test_okf.py`, or `uv run --directory api --frozen pytest tests/test_okf.py` on the host. It fails on an id-shaped number, an email, a connection string, a token, a hostname or an IP address, and when a dbt model is named in no Data Model concept. It cannot see meaning. Step 1 is the real check.
3. A change to a fact the bundle states changes the concept in the same pull request and updates `generated.at`.

## Working in this repository

- Everything runs through `just` and Docker: `just up`, `just ingest`, `just dbt build`. The recipe table is in the README.
- Tests: `just test` (the parser, on the host), `just local::drain-test` (the parser and the drain in its image), `just local::api-test` (the compiler goldens and the offline app tests need no stack; the cases and oracles need `just up` and a built warehouse), `just dbt test` (needs a built warehouse), `just local::web-lint`, `just local::e2e` (needs the stack and the full replay load). CI runs the parser tests, the compiler goldens, the offline app tests, the bundle test, a dbt parse and the web lint and typecheck; `infrastructure/ci.yml` is copied into `.github/workflows/` by hand.
- Rules that break things when ignored: never lower `PARSE_VERSION`; `infrastructure/docker/clickhouse/ingest.sql` runs on an empty volume, `just up` applies it to an existing one; the compose subnet is named in `compose.yaml` and `users.xml`, change both; every dbt column has a YAML description; the API's catalog is the `meta.semantic` block in `dbt/models/marts/marts.yml`; the browser never calls the API; the `just deploy *` recipes act on the box and run only on the owner's word.
- Which document is true: the README and `docs/okf/` describe the code as it is; `docs/deploy.md` is the box runbook; `docs/roadmap.md` holds what is proposed and not built; `docs/design/` is the design of an earlier version, kept for its reasoning; `PLAN.md` is the backlog.
- The code rules are in the bundle: [code style](docs/okf/conventions/code-style.md), [testing](docs/okf/conventions/testing.md).
- Commits end with the `Co-Authored-By` trailer of the agent that wrote them and nothing else; pull request text an agent wrote opens with `> [!NOTE]` and `> Claude Code wrote this description.`
