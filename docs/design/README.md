# Warehouse design

Written 2026-09-11. Numbers: 26.9 host binary, 6,567-replay dev load. PR 2 re-measures in the 26.8 container.

## Documents

| File | Holds |
|---|---|
| `stories.md` | Four stories, Done-when lists, Review numbers, D1-D4 |
| `api.md` | HTTP contract: 8 routes, fields, errors, limits |
| `queries.md` | SQL per route, the search compiler, schema changes S1-S5, goldens, the repeat flag |
| `rust.md` | The Rust service, read-only user, just recipes, tests, CI |
| `frontend.md` | The Vite app: routes, URL codec, tokens, screens, serving |
| `plan.md` | PR stack, gates, decisions, open items |
| `../../design/mockups/` | Four mockups in light and dark (`?theme=dark`), `tokens.css` and `theme.js` |

## Decisions

| # | Decided |
|---|---|
| D1 | `download_url` = public base URL + `replays.source_key` (PR 3) |
| D2 | The URL holds every filter and step |
| D3 | Fixtures decide pass or fail; the dev load is a dated scale check |
| D4 | Minimum count, "without", first hero: PRs 15-16 |
| Repeats | Flag `is_repeat` at load, never delete: tier halls, `R…` research, heroes, under 1000 ms |
| Orders | The UI says "ordered"; counts count orders |
| Stack | Docker first: just modules `local`, `fixtures` (PR 1), `box` (with the box) |
| ClickHouse | PR 2 pins `clickhouse/clickhouse-server:26.8.2`, the 26.8 LTS line (today 24.10), for local, CI and the box |
| Races | Wire ids are the GNL ids `HU OC NE UD RANDOM`; storage keeps the parser letters; the API maps at its boundary |
| Style | GNL stone and bronze, light and dark, with the gnl theme menu. Charts: `win` blue, `loss` red, player 2 magenta, one-series bars jade |
| Hosting | None yet (Daniel, 2026-09-11). Local Docker deploys for now; later GCP, or Hetzner with Cloudflare R2. The box PR and the tunnel move wait for that. |
| Names | `{name} {race}` until the dims loader |

## PR stack (bottom to top)

| PR | Branch | Scope |
|---|---|---|
| 0 | `feature/warehouse-design` | These documents and mockups |
| 1 | `chore/dev-data-recipes` | `local` and `fixtures` modules, `load`; drops `infrastructure/local/` |
| 1b | `chore/drain-battle-test` | 6,564 files through compose MinIO and the drain image |
| 2 | `feature/schema-rebuild` | S1 key, S2 `openers`, the `26.8.2` pin, `is_repeat` |
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
| 16 | `…-ui` | D4 controls |

Later: `feature/dims-loader`; the box PR (`just/box.just`).

## Open for Daniel

| Question | Recommend | Decide at |
|---|---|---|
| Public ingress and the GNL backend search path | Tunnel to the `ui` nginx, one per-IP rule on `/api/*`; backend calls `POST /search` | With hosting, after PR 14 |
