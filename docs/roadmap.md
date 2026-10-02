# Roadmap: proposed, not built

Written 2026-10-02 from an audit of the dbt rebuild branch. Each item names what decides it. The README and `docs/okf/` describe what runs; this file describes what does not yet.

## 1. A second instance for stat-events

Goal: two warehouses from one repository. `core` is today's stack over the replay files. `events` is the same stack plus the events a W3Champions map script emits during a game (creep kills, units trained, resources every five seconds), read from the same replay files once the script and the parser carry them.

How, in order:

1. **Parametrise one host for two stacks.** Ports, the lock file and the cron tag come from `.env` (`API_PORT`, `WEB_PORT`, `GRAFANA_PORT`, `DOCS_PORT`, `INGEST_LOCK`); `COMPOSE_PROJECT_NAME` isolates volumes and the network. The compose subnet is fixed and named again in `users.xml`, so a second project needs a second subnet in both files, or the subnet rule replaced by a password on the `default` and `ingest` users. About 30 lines. A shared reverse proxy that routes `<name>.localhost` is the predecessor warehouse's `stack` script; port it when two stacks run side by side.
2. **A second ingest table, not a bigger document.** The drain writes `ingest.stat_events` in the same pass as the document: typed rows (event type, replay id, player, time, object code, coordinates, value), versioned by the document's version, inserted in RowBinary. Plain `MergeTree`, `PARTITION BY parse_version`, `ORDER BY (event_type, replay_id, player_id, time_ms, seq)`; current rows by a semi-join on `(replay_id, doc_version)` against `raw_replays`, so no `FINAL` over tens of millions of rows; a superseded parse version is one `DROP PARTITION`. This follows the ClickHouse rules on partition lifecycle, late-arriving upserts and typed columns over JSON, and keeps `raw_replays` from re-reading a ten times larger document on every build.
3. **dbt behind a selector.** A source `ingest.stat_events` enabled by `var('stat_events')`, a staging view, and marts such as `creep_kills`, `units_completed` and `player_state_5s`, all tagged `stat_events`. `selectors.yml` makes `core` the default selection and `stat_events` a separate one, so an events failure never blocks `player_games`. The predecessor's `stat_events.sql` (raw rows keyed by index, a schema registry, typed views for builds with cancels, economy, heroes, deaths and combat) ports as these models.
4. **Decoding.** The payloads are bit-packed and deflated by the map script's Lua library. The predecessor decoded them in a Node sidecar with the script's own Lua decoder vendored. Here the decoder belongs in the drain (a Rust port of the bit buffer, deflate and schema registry), tested against the predecessor's decoded output as goldens.
5. **The API and the pages.** The catalog reads any model with a `meta.semantic` block, so the events marts appear with no API change. The inspector shows an Events tab when the catalog holds the model.

Blocked on section 3 (the map script) and on the parser: the pinned parser revision drops the sync actions that carry the payloads, through three known bugs (a lossy UTF-8 read of the value, an off-by-one action id boundary after game version 2.0.2, a skipped byte on pause). The maintainers' w3gjs branch fixes all three; port the fix to the Rust parser and expose the sync actions as a `syncs` array. The bucket keeps every raw replay, so one parser bump re-drains past games.

## 2. The league bucket as a source

Facts, from the league backend's contract:

| Item | Fact |
|---|---|
| Buckets | one for production, one for preview and development, each with its own token |
| Key layout | `<VERCEL_ENV>/replays/<series id>/game<n>.w3g`; the environment segment is `production`, `preview` or `development` |
| What the league row stores | the object key, not a URL; every download is a presigned GET the backend makes |
| Who writes | the browser, to a presigned PUT; a slot swap rewrites both keys; a re-upload overwrites the key |
| Who deletes | the backend, when a series, match, season, team or player is dropped |

Mapping to this repository's variables: `W3WAREHOUSE_S3_ENDPOINT` is the account's R2 host (no scheme) with `W3WAREHOUSE_S3_SECURE=true`; `W3WAREHOUSE_S3_BUCKET` the bucket; `W3WAREHOUSE_S3_PREFIX` the environment segment; the key pair a separate token with object read only. The staging bucket is the second source with `W3WAREHOUSE_SOURCE2_PREFIX=preview/replays`, because the second source is listed at its prefix as given.

What to build, in order:

1. **Series id and game number in dbt, not the drain.** `replays.source_key` already holds the key, so `extract(source_key, '^\w+/replays/(\d+)/game(\d+)\.w3g$')` names both with no re-parse; a segment that is not a number is not a league upload. Note the standing decision of 2026-10-01 that the warehouse holds no link into the league's data; these two columns name the key's own segments and nothing else, and joining them to league rows waits on that decision.
2. **Deletes.** The drain never sees a deleted key, so a replay the league removes stays in the marts. After a full listing, a key in `ingest.files` that the listing no longer holds gets a tombstone document (empty `doc`) at a new version, and `raw_replays` drops documents that are empty. About 20 lines of Rust and 3 of SQL, with a drain test.
3. **Downloads.** A replay page link to the raw file goes through the league backend's presigned URL or a presign of the warehouse's own read token; the bucket has no public domain.
4. **Metadata dimensions later, after a count.** A W3Champions game carries a game name of the form `w3c-<gateway>-<match id>`, which joins the W3Champions match documents (season, MMR). Count the league replays whose game name has that form before building a dimension loader.

## 3. The map script's game-end flush

The end goal needs the map script (W3Champions `map-updater-scripts`, the `stat-events` pull request) to flush its event buffer into the replay when a game ends. Read in full on 2026-10-02: the flush is not correct as written at the pull request's head.

| Defect | What happens | Fix |
|---|---|---|
| The end-game hook wraps the melee victory check with no game-over test and no repeat guard | every leave and every defeat check adds an end event and a forced flush, and the result is applied while the last batch is still sending; a quick quit loses that batch | run the original check first, end only when the game is over, latch so it runs once |
| `time` is a signed 13-bit field | at 68 minutes every event throws and the hooked check never reaches the melee code, so the game cannot end by melee rules | an unsigned or wider field, and a guard that always calls the original check |
| every client sends every packet | the replay holds one copy per player with the same chunk ids; in a 4v4 the per-tick byte limit can drop packets | gate the send call by the designated sender, keep timers identical on every client |
| the final batch is all or nothing, in chunks 0.1 s apart | a client that quits inside the window loses it whole | keep the backlog small with a size-triggered flush, so the end needs one or two packets |
| a flush skipped for any reason drops the end callback | the melee result, a draw or a tournament result is never applied | always run the callback, even when nothing is sent |

The maintainers' fork branch `stat-events.flush` (fork pull request 1, unmerged) fixes most of this: the original check first, a once-only latch, sends gated by sender, one send queue with a burst at game end. It does not fix the time overflow. The script's Lua tests pass under a Lua 5.3 and 5.4 runtime obtained with `uv run --with lupa`; none covers the end-game path with a full buffer.

What settles it: one Lua unit test of `end_game` with a full buffer (every buffered event and the end event sent before the original check runs, a second call a no-op, a non-sender sending nothing, `time` past 4095 s not throwing), and one real game on a map built from the branch, where the loser leaves and the winner quits half a second after victory, parsed with a raw-bytes reader of the sync actions to confirm the last batch is complete and the end event is last.

On the replay side: the payload is action `0x78` with the identifier `WC`; all three parsers in use (w3gjs, w3grs, FLO) read the value as lossy UTF-8, which corrupts it, and they disagree on the action id after game version 2.0.2. A parser that keeps the raw bytes is step one of section 1.

## 4. Deferred quality work, with what decides each

| Item | Decides it | Size |
|---|---|---|
| A `dbt` user and profile with a memory cap and spill settings | `SELECT query, memory_usage FROM system.query_log WHERE user = 'default' ORDER BY memory_usage DESC LIMIT 10` after a build; act when the top node passes half the server cap | 25 lines |
| One typed staging table parsed once, in place of a view six marts re-parse (109 `JSONExtract` sites) | `dbt build` time over 60 s | 120 lines |
| `replay_id` as a materialized column on `ingest.docs`, and `raw_replays` picking by `argMax` over small columns | the same measurement | 25 lines |
| Grafana alert rules: minutes since the last pass over 30, a pass with an error, parse failures in the last hour, free disk | provision `alerting/rules.yaml` once the stack is up and the ClickHouse datasource query model is confirmed; a webhook contact point from an env variable | 90 lines |
| `store_failures` into an audit schema and a failing-tests panel | a spike that the built-in adapter supports it | 40 lines |
| Golden-output tests per model on the three goldens (dbt unit tests skip integer and array columns) | after the typed staging table | 60 lines |
| Response models in OpenAPI for the eight routes | when a second consumer appears | 120 lines |
| A `Store` and `Sink` trait in the drain with in-memory fakes, so the loop and every failure path have a test | the next drain change beyond a line | 210 lines |
| Web: one helper per idea (about twelve duplicates), split the 697-line `Sides.tsx`, tag the 60 screenshot tests so the default run asserts only | the next web change in those files | 240 lines |
| The CI image used on the box (`image:` with a tag from `.env`) and a rollback recipe | the first deploy | 60 lines |
| Pinned MinIO tags | the registry lists them | 2 lines |
| The box clones the personal fork; the organisation repository is the origin | decide the deploy source before the first deploy | 2 lines |
| A ClickHouse query cache for the API and `Cache-Control` on the read routes | the share of repeated queries in `system.query_log` over a week | 15 lines |
