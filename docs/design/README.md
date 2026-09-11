# Warehouse design

Written 2026-09-11. Numbers are from 26.9 (dev load: 6,567 replays).

## Documents

| File | Holds |
|---|---|
| `stories.md` | The four stories, Done-when lists, Review numbers, D1-D4 |
| `api.md` | The HTTP contract: 8 routes, fields, errors, limits |
| `queries.md` | The SQL per route, the search compiler, schema changes S1-S5, goldens, the repeat flag |
| `rust.md` | The Rust service: crate, client, read-only user, recipes, tests, CI |
| `frontend.md` | The Vite app: routes, URL codec, tokens, screens, serving |
| `plan.md` | The PR stack, gates, decisions, open items |
| `../../design/mockups/` | Four light-only mockups and `tokens.css` |

## Decisions

| # | Decided |
|---|---|
| D1 | `download_url` = public base URL + `replays.source_key` (PR 3, re-stage) |
| D2 | The URL holds every filter and step |
| D3 | Fixtures decide pass or fail; the dev load is a dated scale check |
| D4 | Minimum count, "without", first hero: PRs 15-16 |
| Repeats | Flag `is_repeat` at load, never delete: tier halls, `R…` research, heroes, under 1000 ms |
| Orders | The UI says "ordered"; counts count orders |
| ClickHouse | PR 2 pins 26.8 LTS (today 24.10) and re-runs the 26.9 checks |
| Style | GNL stone and bronze, light only |
| Names | `{name} {race}` until the dims loader (after the four pages) |

## PR stack (bottom to top)

| PR | Branch | Scope |
|---|---|---|
| 0 | `feature/warehouse-design` | These documents and mockups |
| 1 | `chore/dev-data-recipes` | `fixtures`, `load-local`, `fixture-server`; the 71 empty replays |
| 1b | `chore/drain-battle-test` | The 6,564 files through MinIO, the drain, `backfill-bucket` |
| 2 | `feature/schema-rebuild` | S1 key, S2 `openers`, 26.8 pin, `is_repeat` |
| 3 | `feature/replay-source-key` | `source_key`, staging re-stage |
| 4 | `feature/api-readonly-user` | `warehouse_api` user and profile |
| 5 | `feature/api-service-core` | Crate, client, `/health`, `/mappings`, `/filters` |
| 6 | `feature/api-search` | `POST /search` |
| 7 | `feature/api-openers` | `/openers`, `/openers/replays` |
| 8 | `feature/api-stats` | `/stats` |
| 9 | `feature/api-replay-detail` | `/replays/{id}` |
| 10 | `feature/frontend-shell` | Vite shell, tokens, nginx, tunnel move |
| 11 | `feature/frontend-search` | Search page |
| 12 | `feature/frontend-openers` | Openers page |
| 13 | `feature/frontend-stats` | Stats page |
| 14 | `feature/frontend-replay` | Replay page; deletes the legacy page |
| 15 | `feature/search-count-without-first-hero` | D4 API fields and goldens |
| 16 | `feature/search-count-without-first-hero-ui` | D4 controls |

Later: `feature/dims-loader` (seasons, teams, players from the GNL API).

## Open for Daniel

| Question | Recommend | Decide at |
|---|---|---|
| Public ingress, GNL backend search path, hosting | Tunnel to the `ui` nginx, one per-IP rule on `/api/*`; backend calls `POST /search`; the box first | PR 10 |
| When to design a dark theme | With the GNL theme PR | GNL theme PR |
| Final win/loss pair | Blue `#2A6496`, red `#B5452F` | GNL theme PR |
