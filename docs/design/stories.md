# Warehouse stories

- Written 2026-09-11. D1-D4 decided.
- Paths are relative to the repo root unless marked `w3warehouse:`.

## Setup for every Review line

Every Review line gives two numbers. Only the fixture number decides pass or fail (D3).

| Base | What | How | Use |
|---|---|---|---|
| **Fixtures** | The 3 parser goldens: 3 replays, 6 players, 323 `replay_events` rows. | Its own compose project, `wh-fixtures`: own volumes, ClickHouse on `127.0.0.1:8124` (plan.md P1). `just fixtures::up` rebuilds it from nothing: schema, mappings, the 3 fixtures. plan.md PR 1 adds the module (rust.md §16; not in justfile:1-68 today). | Pass or fail. The numbers never change. |
| **Full load** | Measured on 26.9 (host binary 26.9.1.1204), re-read 2026-09-11 evening. From PR 1 the local compose project holds it; PR 2 re-measures it on 26.8. 6,567 replays = 6,564 from `gs://w3warehouse-05b6-replays/w3g/gnl/` + the 3 fixtures. 13,134 players, 950,132 `replay_events` rows. Ingested 16:47:52 to 17:27:57 (`replays.ingested_at`). All `type = '1on1'`, all `gnl_series_id = 0` (queries.md header). | Claude loaded it 2026-09-11: the parse bin, then `INSERT … FROM file()`. Parsed docs: main clone `data/parsed/gnl/` (git-ignored). PR 1 loads them into the local project (`just local::load`; compose mounts `data/` read-only). PR 1b reloads the same set through the real drain path (plan.md). | Scale check: grey rule, sums, page speed. Re-measure and re-date after each load. Debugging only: the org deploy holds only app-reported GNL replays. |

Then:
1. Start the Rust API on the fixtures (`just fixtures::api`) or on the full load (`just api`), and the Vite dev server (`just ui`). plan.md names the PR that adds each recipe.
2. Open the dev server URL plus the route in the Review line.

The 3 fixtures (short ids). The full load contains them too. None has a GNL series link (`gnl_series_id = 0`).

| Id | Map | Matchup | Length | Players (race) | Winner |
|---|---|---|---|---|---|
| `0ddb…` | Springtime 1.3 | NvO | 6.7 min | FoCuS#31324 (O), Medusa#31315 (N) | Medusa |
| `9233…` | Springtime 1.3 | HvN | 6.8 min | moosangsung#1804 (H), Medusa#31315 (N) | Medusa |
| `dcd3…` | Concealed Hill | NvO | 15.6 min | thanks#11187 (N), Okeanos#22605 (O) | thanks |

## 1. Build-order search

As a GNL player I want to describe a build in order, with timing, so that I find every GNL game that opened that way.

Done when:
- [ ] `/search` has the shared filters and 1-2 player slots: race, outcome, player, up to 8 steps.
- [ ] A step is a kind, an object with its icon, and optional timing in m:ss (within previous s, not before/after).
- [ ] The picker keeps heroes, skills, upgrades and items for the slot race.
- [ ] A 10 s gap rejects A ordered @0, A @5 s, B @100 s (golden; w3warehouse:tests/test_compiler.py:77 pins the wrong answer).
- [ ] Results use the shared replay table; a row opens `/replays/:id`. An empty `/search` lists every game.
- [ ] (D4) A step can ask for a minimum count: "at least 5 Archer orders by 5:00".
- [ ] (D4) A slot can list up to 3 objects the player never ordered ("without").
- [ ] (D4) A hero step can require the player's first hero ordered.

Query forms:

| Form | Example | Status |
|---|---|---|
| Ordered steps | `eate` then `eaom` | In |
| Gap to the previous step | B within 10 s of A | In |
| Step time window | `eaom` before 2:00 | In |
| Repeated step | Two `eaom` | In (api.md 3.4 "Repeated step") |
| Two slots, per-slot race, player, outcome | Night Elf vs Orc | In |
| Minimum count | at least 5 `earc` orders by 5:00 | In, PRs 15-16 (D4) |
| Without | No `eden` ordered in the game | In, PRs 15-16 (D4) |
| First hero | First hero `Edem` (PLAN.md:40) | In, PRs 15-16 (D4) |
| Cross-player order | "A before the opponent's B" | Out. Each slot runs its own `sequenceMatch` (api.md 3.4 "Slots are players"). |
| Ordered negation | "A, then no B before C" | Out |
| OR inside a step | `eaom` or `edob` | Out |
| Second or third hero | Hero number 2 | Out |

| Review | Fixtures | Full load |
|---|---|---|
| `/search`, Night Elf, steps `eate` then `eaom` ordered | 3 games | 2,263 |
| Same, plus opponent Orc | 2 | 654 |
| One step, hero `Edem` ordered | 3 | 1,520 |
| (D4) Night Elf, at least 5 `earc` orders by 5:00 | 1 (`dcd3…`) | 1,100 |
| (D4) Night Elf, step `eate`, without `eden` | 1 | 573 |
| (D4) Night Elf, first hero `Edem` | 3 | 1,430 |

Out of scope: MMR, seasons, teams, custom-map objects, saved searches, and the "Out" rows above.

## 2. Openers tree

As a GNL player I want to walk each race's first buildings one at a time, so that I see which openers are common and which win.

Done when:
- [ ] `/openers` takes race (required), the shared filters and a sort (most played, best win rate).
- [ ] Each row shows building ordered, games, win rate, average minutes and branch count.
- [ ] A click opens the next building in place, to depth 6 (index.html:448).
- [ ] Win rate stays grey under 10 games (index.html:446). The floor sits in two places; tests pin both.
- [ ] Children plus stopped sum to the parent.
- [ ] A row's replay button lists its games.

| Review | Fixtures | Full load |
|---|---|---|
| `/openers`, Night Elf, top row | Altar of Elders, 3 games, grey | Altar of Elders, 2,503, not grey |
| Open Altar of Elders | Ancient of War 3 | Ancient of War 2,294; Tree of Life 3, grey |
| Open Ancient of War | Tree of Ages 2, Ancient of Wonders 1 | Tree of Ages 872, Ancient of Wonders 816, Hunter's Hall 466 |
| Player Medusa#31315, top row | 2 | 2 |

Full-load numbers come from the `replay_openers` view (queries.md 3.5). `w3g.openers` replaces it after queries.md §5 S2 with the same rows. Both count only games with a known winner. The repeat flag changes none: 483 of 548 `etoa` repeats are under 1 s, and none has a building order between, so `arrayCompact` drops them already (full load, 2026-09-11).

Out of scope: Random rolled race, MMR bands, depth past 6.

## 3. Stats dashboards

As a GNL player I want matchup win rates, hero picks, game lengths and APM for a slice of games, so that I see what the league plays and what wins.

Done when:
- [ ] `/stats` takes the shared filters and states the cohort size.
- [ ] Matchup table: games and win % of the row race.
- [ ] Hero picks per race: share of that race's player-games.
- [ ] Histograms: length in 5 min buckets, APM in 25 APM buckets.
- [ ] A repeated load changes no number.
- [ ] Each chart has a tooltip and a table view.

| Review, `/stats`, no filter | Fixtures | Full load |
|---|---|---|
| Games | 3 | 6,567 |
| NvO, HvN | 2, 1 | 707, 672 |
| Demon Hunter, of Night Elf player-games | 3 of 3 | 1,605 of 2,787 |
| Length 5-10 min, 15-20 min | 2, 1 | 1,129, 1,666 |

Out of scope: MMR, seasons, teams, custom modes, player career pages.

## 4. Replay detail

As a GNL player I want one page per game with both builds side by side, so that I study a game without opening Warcraft III.

Done when:
- [ ] `/replays/:id` shows map, matchup, length, winner, download, and the GNL series and game as text when `gnl_series_id > 0`. No link: the GNL route `/match/:id` is member-only and needs a match id the warehouse does not have.
- [ ] Each player shows race icon, name, APM, heroes and final levels.
- [ ] A timeline per player lists time (m:ss), icon and name of each order; kind chips filter it; skills sit under their hero. Flagged repeats are hidden.
- [ ] APM-over-time chart and chat log. Private chat is hidden.
- [ ] An unknown id shows "No game with this id".

Review (both bases): from a search row open `dcd3…`: Concealed Hill, NvO, 15.6 min, thanks#11187 won. Then `/replays/nope`.

Out of scope: stat-events, playback, hotkeys, resource transfers.

## Shared by every feature

| Need | Done when |
|---|---|
| Filter row | Race, opponent race, map, player, game length (min and max minutes) sit in one row above the content. Same names and same query keys on every page. No season or team filter until the dims loader (after the four pages). |
| URL is the state | Every filter and search step lives in the route query. A reload or a pasted link gives the same result (D2). |
| Race display | Race ids are the letters `H O N U R`; `R` (Random) is a fifth race. Player race uses the `RaceSelect` and `RaceIcon` pattern from wc3-gym-frontend. The icon shows only when the row has a race (PlayerName.vue `v-if="race"`). A player shows `{name} {race}`: no flag, no MMR until the dims loader. |
| Object race | Pickers read the `race` that `GET /mappings` derives (api.md 3.2): lower-case lead for buildings and units, upper-case lead for heroes, second letter plus one override (`Rwdm`) for `R…` upgrades, the owning hero for `A…` skills (so `AHfa` is Night Elf), none for items. A leading `n`/`N` is neutral. |
| Orders, not outcomes | Replays record commands. Every label says "ordered", and counts count orders. A same-code order by the same player under 1000 ms after the previous one is flagged (`is_repeat`, PR 2), never deleted, for tier halls (`hkee hcas ostr ofrt unp1 unp2 etoa etoe`), research (`R…`) and hero training only. The first order's time counts. Searches, openers, counts and stats skip flagged rows. Buildings and units stay raw. |
| Shared replay table | One component: map, matchup, players, length, result, download. Search and the openers replay list use it. |
| Download link | Every replay row and the detail header link the `.w3g` file. A replay with no file shows "No file", not a dead link (D1). |
| Empty state | Says what to change, e.g. "No game matches. Drop a step or widen the filters." (index.html:289). |
| Error state | Shows the API `{"error": "<text>"}` text. ClickHouse down shows "Warehouse offline" and a retry button. A bad input names the field. |
| Loading | The content keeps its place and shows a progress bar. Buttons do not double-submit. |
| Theme and size | The GNL stone-and-bronze theme in light and dark, approved 2026-09-11 (D1-D15): the tokens, Alegreya and Alegreya Sans of frontend.md section 6 (`design/mockups/tokens.css`). A theme menu with Light, Dark and System, as in gnl. Every page works at 400 px wide in both modes. |

## Decisions

**D1. Download link.** Decided: the drain writes the raw R2 object key into each doc; `replays.source_key` stores it; `download_url` = public base URL + `source_key`. PR 3 builds it and re-stages the staging bucket (drain re-run with breadcrumbs cleared). Why: the key is where the file sits, so it cannot drift.

**D2. Filter state.** Decided: the route query holds every filter and step. Why: a player can post an exact search in the GNL Discord; the step codec is small.

**D3. Review data.** Decided: two bases. The fixtures decide pass or fail; a dated full-load number sits beside each. Why: a fixture number is exact and stable; every load, and later the backfill cron (PLAN.md:43), changes full-load numbers; the fixtures cannot show scale effects (the grey rule, children that stop early, api.md 4 A7).

**D4. Query forms.** Decided: minimum count, "without" and first hero are in, as PRs 15-16 at the top of the stack. Cross-player order stays out. Why: each form keeps the slot's `GROUP BY replay_id, player_id` shape and adds one bound `HAVING` term; PLAN.md:40 plans a first-hero filter; api.md §5 drops `hero_ordinal` until a story asks, and story 1 now asks. The PRs add api.md 3.4 Step and Group fields and a queries.md golden per form.

Rules for the D4 forms:
- **Count.** `unit` rows are training orders, not finished units; finished counts wait for stat-events. PR 15 checks whether the parser drops a cancelled training order (plan.md). Count `uniqExact(seq)`, not `count()`: `replay_events` is a ReplacingMergeTree and dedupes only at merge (`insert-optimize-avoid-final`). Skip flagged repeats.
- **Without.** The slot `WHERE` keeps only step codes, so the "without" codes join that `IN` list. A slot with only a "without" list has no rows to test; it uses `replay_players` of that race as its base.
- **First hero.** Decided: `hero_trained` timing is accepted (it is the first ability cast, not the training order; api.md 6 question 5). On the full load, "earliest `hero_trained` is `Edem`" and "`player_heroes.hero_slot = 0` is `Edem`" both give 1,514 Night Elf player-games. w3warehouse ranks distinct heroes by earliest `hero_trained` (w3warehouse:services/api/src/api/compiler.py:806-844).
