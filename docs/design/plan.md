# Warehouse build plan

- Written 2026-09-11 over five documents in `docs/design/` and four mockups in `design/mockups/`.
- Data state: the host-binary ClickHouse 26.9.1.1204 (before the move to Docker, §4) holds 6,567 replays, 13,134 `replay_players` rows and 950,132 `replay_events` rows (ingested 16:47:52 to 17:27:57, `replays.ingested_at`). This is the "full load" base of stories.md D3.
- The full load is 6,564 replays from `gs://w3warehouse-05b6-replays/w3g/gnl/` plus the 3 fixtures. Claude loaded it 2026-09-11 with the parse bin plus `INSERT … FROM file()`. Main clone, git-ignored: raw files at `data/deploy/gnl/` (6,564 `.w3g`), parsed docs at `data/parsed/gnl/`.
- The full load is for debugging only. It is not the "about 1,000" set. The org deploy `Warcraft-Gym/wc3-gym-warehouse` holds only app-reported GNL replays.
- "(26.9)" marks a number measured on 26.9.1 (host binary) before the repeat flag. PR 2 re-measures it in the 26.8 container with the flag and writes it into the document that owns it.
- Repo: `tanghyd/wc3-gym-warehouse`. Paths are relative to the repo root. ClickHouse rule names come from the `clickhouse-best-practices` skill.

## 1. How the stack works

- PR 0 is this design branch, `feature/warehouse-design`: documents and mockups only. Each PR stacks on the one before it. The list runs bottom to top.
- One change per PR. Branch prefixes: `feature/`, `fix/`, `refactor/`, `chore/`. Daniel squash-merges from the bottom up. Rebase onto the new base before a merge: CI tests the merge result, not the branch.
- The workflow file is `infrastructure/ci.yml`. Daniel copies it to `.github/workflows/` (ci.yml:1). A PR that changes CI hands him the YAML.
- The Rust service and its SQL goldens (PRs 5-9) land before the frontend PRs that call them (PRs 10-14).
- The PR description carries its gates as a checklist: each item holds the command and its output, or a link to the screenshot artifact.
- Docker first (Daniel, 2026-09-11). Every ClickHouse runs in a container from `compose.yaml`: the local project, the fixtures project, CI and the box. just recipes drive compose; the place is a just module (`local`, `fixtures`, later `box`). rust.md §16 holds the recipes.

### 1.1 Gates

| Gate | What passes | Command |
|---|---|---|
| SQL goldens | `tests/goldens/**/*.sql` are byte-equal to queries.md §7; a bless run leaves no git diff | `just api-bless`, then `git diff --exit-code` |
| Result parity | Per story Review case, `POST /search` returns the replay-id set of the frozen page SQL, on the fixtures and the full load | `just fixtures::parity`, `just api-parity` (rust.md 17.3) |
| cargo | tests pass with `--locked`; clippy `-D warnings`; `cargo fmt --check` | `just test`, `just api-lint` |
| EXPLAIN | `EXPLAIN indexes = 1` shows the `Keys`, the `Condition` and a `Granules` count no worse than the PR's table (`schema-pk-filter-on-orderby`) | `just ch` or `just fixtures::ch` with the golden params |
| Fixture numbers | Every stories.md fixture number matches exactly (stories.md D3) | `just fixtures::up`, then the check (PR 1) |
| Full-load numbers | Re-measured, dated, written into the PR. They inform; they do not fail a PR. | the local project, loaded by `just local::load` |
| node test, vite build | `npm test` (`query.test.mjs`) and `npm run build` pass | `npm --prefix frontend test`, `just ui-build` |
| Playwright shots | 1440 px and 390 px, light and dark, every state of the page. No horizontal page scroll. The author names what each shot checks. Shots go into the PR as an artifact. | the `design-shots/` harness pattern |

## 2. The PRs, bottom to top

### PR 0: `feature/warehouse-design`

| | |
|---|---|
| Scope | The design documents and mockups (`docs/design/*.md`, `design/mockups/*.html`) |
| Gates | None run code. |
| Daniel reviews | §4 "Still open". None of it blocks PR 0. |

### PR 1: `chore/dev-data-recipes`

Needed: stories.md D3 needs a fixture base, and the recipes must drive compose (Docker first, §1). `just fixtures` does not exist (justfile:1-68). The justfile `client` runs a host `clickhouse-client` when one is on PATH (justfile:5-8); it then misses the container, which publishes no native port.

| | |
|---|---|
| Files | `justfile`: `mod local`, `mod fixtures`, aliases `up`, `down`, `ch`; `_default` lists submodules; `test` stays (rust.md §16). `just/local.just`: `up`, `down`, `ch`, `schema` (the compose one-shot), `mappings`, `backfill`, `backfill-bucket`, `drain-once` (the drain image) move here; new `fixtures` (refreshing `w3g.refresh__opener_rollup`) and `load [glob]` (the `replay_id` gate of backfill.sql:22-23, `file()` over the mounted `data/`, default glob `data/parsed/gnl/*.json`); `client` always uses `docker compose exec`. `just/fixtures.just`: `up`, `down`, `ch` on compose project `wh-fixtures`. `compose.yaml`: ClickHouse host port `${CLICKHOUSE_HTTP_PORT:-8123}`; `${W3WAREHOUSE_DATA_DIR:-./data}` mounted read-only at `/app/data`. `user-files.xml`: comment. `db/w3g/backfill.sql`: `LIMIT 1 BY replay_id` (queries.md §5). `.env.example`: drop `CLICKHOUSE_HOST`, add `W3WAREHOUSE_DATA_DIR`. Delete `infrastructure/local/` and its `.gitignore` lines (§3 P4). |
| Gates | `just fixtures::up`: `replays FINAL` 3, `replay_players FINAL` 6, `replay_events` 323; a second `up` gives the same. `just local::fixtures` on the full load adds no row. `fixtures` checks `input()` + `JSONAsString` and waits for `SYSTEM REFRESH VIEW` to finish. `just local::load` twice: `count()` = `count() FINAL` on `replay_events`, 0 key groups with more than 1 row (`insert-optimize-avoid-final`). A doc twice in one glob stages once. `file()` reads the glob in one `INSERT` (`insert-batch-size`). Both projects run at once (8123, 8124). No recipe calls a host `clickhouse-client` or `infrastructure/local/`. |
| Image | 24.10 until PR 2. PR 1 moves the full load from the 26.9 host binary into the local project; its gates are counts, so the version does not change them. |
| 71 replays | List the 71 replays with no events, each with a reason. Check whether they are LAN games hit by the w3grs action-id shift after 2.0.2 (the calibration saw 0 orders on a LAN game vs the AI). |

### PR 1b: `chore/drain-battle-test`

Needed: the full load came through parse + `file()`, not the real path.

| | |
|---|---|
| Files | `just/fixtures.just`: `battle-test` (rust.md §16). Containers only: it drops the `wh-fixtures` volumes, sets every S3 variable (MinIO `minio:9000`, `W3WAREHOUSE_S3_PREFIX=dev`), starts the compose `local` profile (MinIO, bucket), uploads each `data/deploy/gnl/<stem>.w3g` as `dev/replays/<stem>/game1.w3g` from the `minio-setup` container, runs `local::drain-once` (the drain image) twice, then `local::backfill-bucket`, then prints the `"failed"` breadcrumbs. No new script, no host port. |
| Steps | `just local::load` first, so the local project holds the `file()` oracle. Then `just fixtures::battle-test` in the empty `wh-fixtures` project. Then `just fixtures::up` restores the fixture base. The stems are numeric (13185269 to 13738541, in u32), so `parse_key` (drain.rs:113-120) accepts them. |
| Gates | `replays FINAL` in `wh-fixtures` equals the local project's `file()` load of the same set: 6,564 rows, the same `sum(cityHash64(replay_id))`. The second drain pass parses 0 files. Every failure is listed with its reason. The `dev/` prefix and its fake series ids stay in the `wh-fixtures` volumes; they never reach the org deploy. |

### PR 2: `feature/schema-rebuild`

| | |
|---|---|
| Scope | queries.md §5 S1 (the `replay_events` key), S2 (`w3g.openers`, built by a refreshable MV, replaces `opener_rollup`), S4 (pin `clickhouse/clickhouse-server:26.8`, the LTS line), the repeat flag |
| Files | `db/w3g/tables.sql` (key at :213, comment :195-197; drop :237-254; add `openers`; `is_repeat UInt8 DEFAULT 0` on `player_order_events` and `replay_events`, `schema-types-minimize-bitwidth`, `schema-types-avoid-nullable`). `db/w3g/views.sql` (compute `is_repeat` in the order MVs, `mv__order_unknown` included, carry it through `mv_events__order`; add `refresh__openers`; drop :433-470). `just/local.just` (the `backfill`, `load` and `fixtures` refreshes become `w3g.refresh__openers`). `compose.yaml:12`, `:43`, `infrastructure/ci.yml:26` to `26.8` (today 24.10). |
| Repeat rule | Replays record commands, not outcomes, so repeats double-count. Flag, never delete, a same-code order by the same player less than 1000 ms after the previous same-code order. Only single-instance orders: tier halls `hkee hcas ostr ofrt unp1 unp2 etoa etoe`, research (codes starting `R`), hero training (hero codes, in the unknown bucket via `mv__order_unknown`). Code list, not `kind` (tier upgrades sit in the buildings bucket). Buildings and units stay raw. The first order keeps its time. The MV computes the flag from the one doc at load, so no `ALTER UPDATE` (`insert-mutation-avoid-update`). |
| How it lands | ClickHouse is derived state (PLAN.md:105): `just up` (the 26.8 image), `DROP DATABASE w3g` in `just ch`, `just local::schema local::mappings local::load local::fixtures`, `just fixtures::up`. No `EXCHANGE`, no hand `DROP`. The box needs the same rebuild if live. |
| Gates | Flag goldens: `ostr` at 0, 500, 1500 ms flags only 500; `hhou` at 0, 500 flags none; a hero code at 0, 300 flags the second. Full load: flagged rows by class (26.9: Stronghold 1,052 of 1,071 repeats under 1 s). EXPLAIN per queries.md §5 S1: G04 and G06 about 2 granules, G16 about 5, `Keys: race event_type subject_code` (`schema-pk-filter-on-orderby`, `schema-pk-prioritize-filters`). Openers: `Keys: race`, binary search, 1 granule; rows equal the view's in count and `sum(cityHash64(…))` (26.9: 12,881; `query-mv-refreshable`). The `/openers/replays` EXPLAIN (queries.md 3.6) runs on the real table. Refresh peak memory from `system.query_log` goes into queries.md §5 S2. Profile limits (rust.md §8): `max_rows_to_read` = 10 × the largest route read; the memory cap from the ingest and refresh peaks. The key changes no result. The flag does: re-measure every story number into stories.md. |
| 26.8 re-run | The facts were measured on the 26.9.1 host binary. After the rebuild above, both projects run the 26.8 container. Re-run every EXPLAIN in queries.md §5 and §7 and rust.md §11 M1-M7, M11-M14 through `just ch` and `just fixtures::ch`; date each "26.8 (container)". The runtime join filter needs 26.2+. |

### PR 3: `feature/replay-source-key`

| | |
|---|---|
| Scope | queries.md §5 S3: the drain writes the raw R2 object key into each doc; `replays.source_key` stores it; `download_url` = public base URL + `source_key` |
| Files | the drain's `gnl` object (drain.rs:203-206), `db/w3g/tables.sql:36` (`source_key String DEFAULT ''`, `schema-types-avoid-nullable`), `db/w3g/views.sql:97` (`mv__replays`), parse-rs tests |
| Re-stage | The drain re-runs over the staging bucket `replays/` with the breadcrumbs cleared (PLAN.md:106). Add a play date in the same pass if the drain can read the upload time. |
| Gates | `cargo test` on parse-rs. A staged doc carries `gnl.key`. After re-stage and rebuild, `countIf(source_key != '')` equals the docs the drain wrote. Fixtures keep `source_key = ''` and show "No file". |

### PR 4: `feature/api-readonly-user`

| | |
|---|---|
| Scope | The `warehouse_api` user and profile (rust.md §8), bound to the `chapi` network. The tunnel move to `ui:80` waits for PR 10. |
| Files | `infrastructure/docker/clickhouse/api-user.xml`, `compose.yaml` (volume, env, `chapi` with subnet `${CHAPI_SUBNET:-172.30.87.0/24}`), `just/fixtures.just` (`CHAPI_SUBNET` `172.30.88.0/24`: two projects cannot share one subnet), `.env.example` (`CLICKHOUSE_API_PASSWORD=`), `.dockerignore` (`**/target/`) |
| Gates | As `warehouse_api` over HTTP on 26.8, in both compose projects: `SELECT {x:UInt8}` with `param_x` works; a `SETTINGS` clause gives 164; over `max_rows_to_read` gives 158; a login from the `default` network gives 516, with the right and with an empty password (rust.md §18); `SELECT` outside `w3g` is denied (`agent-query-safety`). A host call through the published port: record its `address` in `system.query_log`. If that address is outside `chapi`, the login fails, and `api`, `api-parity`, `fixtures::api` and `fixtures::parity` run the API in a container on `chapi` (rust.md §18). |
| Daniel reviews | Subnets `172.30.87.0/24` (local, box) and `172.30.88.0/24` (fixtures) against the box's Docker networks. Set the password on the box. |

### PR 5: `feature/api-service-core`

| | |
|---|---|
| Scope | The crate at `services/api/`: config, the ClickHouse client (param encoding, 6-permit semaphore, error map), `ApiError`, the mappings cache with the object-race rule, `GET /health`, `/mappings`, `/filters` |
| Files | `services/api/{Cargo.toml,Cargo.lock,src/*.rs}` (rust.md §3), `tests/http.rs`, `tests/goldens.rs` (`mappings`, `filters` cases), `tests/live.rs` (user checks, cancel on close), `infrastructure/docker/Dockerfile.api`, compose `api` service, `justfile` (`api`, `api-lint`, `api-bless`, `api-parity`, `test`), `just/fixtures.just` (`api`, `parity`), `infrastructure/ci.yml` (`rust` job, `live` job on the compose 26.8 image in place of `schema`, image step) |
| Gates | cargo. Stub tests: the rust.md 6.2 error map (158; 159 as 408; 160; 202; 241 as 503; 396; connect refused; broken body), `no-store` and the envelope on every answer; 413, 415, 405, 404; never more than 6 permits. Unit: M1, M2 param encoding; race of `eaom`, `Edem`, `Recb`, `Rwdm`, `AEmb`, `AHfa`, `ankh`. Live: `/mappings` 649 rows; `/filters` on fixtures 2 maps, 5 players. |

### PR 6: `feature/api-search`

| | |
|---|---|
| Scope | `POST /search`: `req::search`, `sql::search`, the hydrate; skips `is_repeat = 1` rows |
| Files | `services/api/src/{req,sql,routes}.rs`, `tests/goldens/search/*` (G01-G18, rust.md 17.1 errors), `tests/parity/search/*.sql` (frozen from index.html:311-317; lands before PR 14 deletes the page) |
| Gates | Goldens (queries.md §7). No request string in any SQL text. Parity on fixtures and full load (mirror difference excluded, rust.md 17.3). A@0, A@5 s, B@100 s with a 10 s gap gives 0. Equal-timestamp real-data golden (26.9: 1,605 of 1,605 in order). 7 × `ewsp` gives 400 `search too complex`. EXPLAIN: G06 `Keys: race event_type subject_code`; G10 runtime join filter on `replays` (`query-join-filter-before`, queries.md 3.4). Fixture 3, 2, 3 (stories.md story 1). Full load (26.9) 2,263, 654, 1,520. |

### PR 7: `feature/api-openers`

| | |
|---|---|
| Scope | `GET /openers`, `GET /openers/replays` on `w3g.openers`, with the per-owner list (api.md 3.6). Needs the w3grs fork export with `otrb` `is_supply_building = 1`. |
| Files | `services/api/src/*`, `tests/goldens/openers*/*` (O1-O4, R1, errors). Drop the `replay_openers` view (views.sql:45-88) when nothing reads it. |
| Gates | Fixture: `eate` 3 games, grey; `eaom` 3; `etoa` 2, `eden` 1; Medusa 2. Full load (26.9): 2,503, 2,294, then 872, 816, 466; `stopped` 59 at `eate,eaom`. R1 `X-Total-Count` 816 (26.9), equal to the `eden` row. Every level: `sum(rows[].games) + stopped = total`. The win-rate floor (server literal + frontend constant) is pinned by a golden and a test. EXPLAIN: `Keys: race`, binary search. |

### PR 8: `feature/api-stats`

| | |
|---|---|
| Scope | `GET /stats` (queries.md 3.7) |
| Gates | Goldens T1-T5. Fixture: 3 games, NvO 2, HvN 1, Demon Hunter 3 of 3, lengths `[0, 2, 0, 1]`. Full load (26.9): 6,567; 707 and 672; 1,605 of 2,787; 1,129 and 1,666. Two loads give byte-equal JSON. One `is_total = 1` row per race. EXPLAIN: `replay_id in N-element set` on `replays`, `replay_players`. Counts from `FINAL` and `uniqExact` (`insert-optimize-avoid-final`). |

### PR 9: `feature/api-replay-detail`

| | |
|---|---|
| Scope | `GET /replays/{id}` (queries.md 3.8): `hero_retrained`, `All` chat only, the 68 `hero_id = ''` rows dropped |
| Gates | Goldens D1-D5. `dcd3…`: Concealed Hill, NvO, 937219 ms, thanks#11187 won, 150 events (152 raw minus 2 flagged; 26.9 emulation), 3 chat lines. D5: no `code = ''`. `/replays/nope` gives 404 with 0 queries. EXPLAIN: `Keys: replay_id` on all six tables. |

### PR 10: `feature/frontend-shell`

| | |
|---|---|
| Scope | The Vite frame: shell, router, API client, URL codec, the light and dark theme, theme.js, the theme menu and the pre-paint script (frontend.md §6, `design/mockups/tokens.css`), copied gnl components, `FilterRow`, `StateBlock`, `ReplayTable`, `ObjectIcon`, `NotFoundView`. nginx serving and the tunnel move (rust.md 8.1). |
| Files | `frontend/` per frontend.md §2; `infrastructure/docker/{Dockerfile.ui,nginx-ui.conf}`; compose `ui`; `infrastructure/cloudflared/config.yml.example` (`http://ui:80`); compose `cloudflared` (drop `network_mode`); `justfile` (`ui`, `ui-build`); `infrastructure/ci.yml` (`ui` job, image step). The old page moves to `frontend/public/legacy/index.html`. |
| Gates | node test, build. The dataviz validator on the chart pairs, light and dark surfaces (frontend.md 6.5). Shots of the shell and `/nope`. `curl /api/health` through nginx gives 200. |
| Daniel reviews | §4 ingress, search path and hosting |

### PR 11: `feature/frontend-search`

| | |
|---|---|
| Scope | `SearchView`, `StepList`, `ObjectPicker`, the step codec |
| Gates | node test (codec round trip, `~` on step 0, `@-300`, `[{}, {...}]`). Build. Shots: result, empty, 400 on a step, offline (API stopped), phone picker. Fixture lines through the UI: 3, 2, 3. A pasted URL gives the same page. A Night Elf slot's picker shows heroes, skills, upgrades, items, with `AHfa` under Priestess of the Moon. The UI says "ordered". |

### PR 12: `feature/frontend-openers`

| | |
|---|---|
| Scope | `OpenersView`, the selection panel, inline marks, the `open` and `sel` keys |
| Gates | Shots: no-race picker, empty, deep link, phone order. Fixture rows through the UI. Children plus "Stopped here" equal the parent. The list header equals the node's player-games. A shared link rebuilds the tree and panel. |

### PR 13: `feature/frontend-stats`

| | |
|---|---|
| Scope | `StatsView`, `ColumnChart`, `BarList`, `WinRateBars`, `ChartTooltip`, `useWidth` |
| Gates | Shots of chart and table views. Fixture numbers through the UI. Keyboard focus opens each tooltip. Chart pairs pass the validator on the light and dark surfaces. Shots in both modes. |

### PR 14: `feature/frontend-replay`

| | |
|---|---|
| Scope | `ReplayView`, `BuildTimeline` (swimlane plus list, flagged repeats hidden), `ApmLine`; the GNL series as text; deletes the legacy page |
| Gates | Shots: desktop swimlane, phone tabs, hover tooltip, `/replays/nope`. A minute has the same x in the APM chart and the timeline. Under 760 px only the timeline box scrolls sideways. The `dcd3…` line through the UI. |

### PRs 15-16: `feature/search-count-without-first-hero` (API) and `…-ui`

| | |
|---|---|
| Scope | The D4 forms (stories.md D4): minimum count, "without" list, first hero. PR 15: Step and Group fields, goldens, api.md text. PR 16: the controls. The count counts orders ("at least 5 Archer orders by 5:00"). |
| Gates | Goldens per form. The count is `uniqExact(seq)` over `is_repeat = 0` rows, not `count()` (`insert-optimize-avoid-final`). A slot with only "without" codes uses `replay_players` of that race as its base. Fixture 1, 1, 3. Full load (26.9) 1,100, 573, 1,430. Check whether the parser drops cancelled training orders. |

### Later, outside this stack

- `feature/dims-loader`: GNL seasons, teams and players from the GNL API, after the four pages ship. Until then: names show `{name} {race}` (no flag, no MMR); no season or team filters; the replay page shows the GNL series as text (the gnl route `/match/:id` is member-only and needs a match id the warehouse lacks).
- Counts of finished objects wait for stat-events.
- The box (PLAN.md build order step 3) brings `just/box.just` and `mod box`, not before: a place that cannot be reached gets no module. Recipes (rust.md §16): `deploy` (rsync `compose.yaml`, `db/`, `infrastructure/docker/clickhouse/`; then `docker compose --profile prod pull` and `up -d` over ssh), `schema`, `mappings` (from the deployed drain image), `backfill-bucket`, `ch`. Compose gains `image:` GHCR tags beside each `build:`. `.env.example` gains `WAREHOUSE_BOX` and `WAREHOUSE_BOX_DIR`. Gates: a second `deploy` recreates nothing; `mappings` 649 rows; `backfill-bucket` loads from R2 on the box (PLAN.md:118). The box's `.env` never leaves the box.

## 3. Plan choices

- P1: the fixture base runs as its own compose project, `wh-fixtures`: own volumes, ClickHouse on 8124. `just fixtures::up` rebuilds it from nothing; `just fixtures::api` points the API at it. PR 1b's battle test borrows it. Why: a Review runs in a browser, and CI has none; the local project keeps the full load as the oracle.
- P2: the old page sits at `/legacy/` from PR 10 until PR 14. Why: page PRs compare old and new side by side.
- P3: one API PR for the core, then one per route. Why: each route has its own goldens and numbers.
- P4: PR 1 deletes the host-native `infrastructure/local/` (server.sh, minio.sh, config). It is not kept as a fallback. Why: every use has a container recipe; the host path runs a different version (26.9) from the pin (26.8), which is the drift PR 2 must re-measure; it duplicates the users and config XML, and PR 4 would have to copy `api-user.xml` into it too; nothing tests it, so it would rot. Cost: a machine with no Docker cannot run the stack. Git history keeps the scripts.
- The page PR shots replace the mockups, including their gaps: the gnl shell, the openers panel, the replay swimlane (frontend.md §17). D2 (the URL holds the state) and D3 (two Review bases) stand.

## 4. Decisions and open items

### Decided

Data and pipeline
- D1: `download_url` = public base URL + `replays.source_key`, the raw R2 key from the drain (PR 3).
- The bulk set is battle-tested through MinIO and the drain (PR 1b). The 71 empty replays are checked in PR 1.
- Repeat orders: the `is_repeat` flag (PR 2). Why: calibration on 3 LAN stat-events games (`order-calibration.md`) fixed heroes exactly (14 orders to 8 = 8 starts); no time rule beat raw for buildings or units.
- Reads skip flagged rows; the timeline hides them; the UI says "ordered".
- List order stays fixed (a tie today: every `gnl_series_id = 0`); a play date rides the PR 3 re-stage if the drain can read the upload time.
- 68 empty `hero_id` rows are dropped in reads; a parser fix is tracked in the w3grs fork. Orc Burrow is a supply building in the fork export (26.9: 3,386 of 3,396 Orc openers hold it).

Local stack and deploy (Daniel, 2026-09-11)
- Docker first: local, fixtures, CI and the box run `clickhouse/clickhouse-server:26.8` from compose (PR 2 pins it). Recipes drive compose; nobody types a `docker` command.
- The place is a just module: `local` and `fixtures` (PR 1), `box` with the box. Root aliases `up`, `down`, `ch`.
- The bulk dev load reads `file()` from `data/`, mounted read-only into the container. The fixture base is the `wh-fixtures` project (P1).
- Images build in CI and go to GHCR; `just box::deploy` pulls them on the box.
- Facts stay dated "26.9 (host binary)"; PR 2 re-measures them in the 26.8 container. `infrastructure/local/` goes in PR 1 (P4).

ClickHouse
- Pin 26.8 (LTS); PR 2 re-runs the 26.9 checks on it, in the container.
- S1 key as proposed: `(race, event_type, subject_code, replay_id, …)`. S2 refresh size and the profile limits are measured in PR 2. S2 must land before about 20,000 replays.
- `kind != 'unknown'` stays in SQL (26.9: 6 of 104 granules). Equal timestamps get a real-data golden.

API
- Race ids are `H O N U R`; `R` is a fifth race. Private chat is hidden (the route is public, cached 1 hour). `hero_trained` time is the first cast, not the training order: accepted, revisit with the fork.
- Story 2 reads "children plus stopped sum to the parent".
- Crate at `services/api/`; no compose healthcheck until something depends on the API; code 241 maps to 503.
- PR 4 tests the empty password and `users.d`. clippy on parse-rs comes in a later `chore/` PR.
- D4 is in, as PRs 15-16.

Frontend
- Style: GNL stone-and-bronze theme, light and dark, with the gnl theme menu (frontend.md §6).
- `m:ss` timing. An empty `/search` lists every game.
- The phone table tries the Vuetify `mobile` prop first, in PR 10. The 3 icon-less codes get the fallback glyph.
- The win-rate floor sits in two places, pinned by tests.

### Still open for Daniel

| Item | Options | Recommend | Decide at |
|---|---|---|---|
| Public ingress, GNL backend search path, hosting | Tunnel to ClickHouse 8123 with a password, or to the `ui` nginx (rust.md 8.1). Backend calls ClickHouse, or the API's `POST /search`. The box through nginx, or pages copied into gnl. | nginx, with one Cloudflare rate-limit rule per IP on `/api/*` (plan limits not checked). The backend calls `POST /search`: 8123 is not public after the move. The box first. | PR 10 |
