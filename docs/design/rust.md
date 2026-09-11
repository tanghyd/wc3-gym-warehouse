# Warehouse API: Rust service design

- Written 2026-09-11, condensed the same day. Data: the host-binary ClickHouse 26.9.1.1204, before the move to Docker (plan.md §4): 6,567 replays (6,564 from `gs://w3warehouse-05b6-replays/w3g/gnl/` plus the 3 fixtures), 13,134 `replay_players`, 950,132 `replay_events` rows (M16). Debugging only. The org deploy holds only app-reported GNL replays.
- Scope: how the `api.md` service is built, configured, shipped and tested. The HTTP contract lives in `api.md`.
- Paths are relative to this repo. `axum:` is the axum 0.8.9 source in the local cargo registry. Rule names come from the `clickhouse-best-practices` skill.
- Server version: PR 2 pins `compose.yaml:12`, `compose.yaml:43` and `infrastructure/ci.yml:26` to `clickhouse/clickhouse-server:26.8` (26.8 LTS; 26.8.2 is the newest tag; today 24.10). Every M-fact (section 11) was measured on 26.9 (host binary). PR 2 re-runs them in the 26.8 container before it lands.

## 1. Summary

Each route is two pure functions: `req::<route>` (raw input to typed input) and `sql::<route>` (typed input to `Vec<Query>`). Goldens call both with no network. One `Ch` struct over reqwest sends `POST /` with the SQL as the body and every value as `param_<name>`. Limits live in a `readonly = 1` profile (section 8). One `ApiError` renders `{"error": ...}` with `Cache-Control: no-store`. No CORS, no traits.

## 2. Where the crate lives (R1)

Decided: a separate crate at `services/api/` (PLAN.md:95), own `Cargo.lock`, no workspace. Why: no shared code with parse-rs; a workspace moves its `[profile.release]` and `[patch.crates-io]` (Cargo.toml:35-38, 43-44) to the root and couples both images to one lock.

## 3. Module layout

```
services/api/
  Cargo.toml, Cargo.lock        lock committed; builds use --locked
  src/main.rs    ~60 lines      env config, tracing init, bind, serve with graceful shutdown on SIGTERM
  src/lib.rs     ~40 lines      pub fn app(state) -> Router: 8 routes, fallbacks, body limit, log middleware
  src/routes.rs                 8 handlers: req::x -> sql::x -> ch.rows -> response + headers
  src/req.rs                    serde request models (deny_unknown_fields) and validation
  src/sql.rs                    the pure compiler: typed request -> Vec<Query>
  src/ch.rs                     the ClickHouse client and the error-code map
  src/error.rs                  ApiError and its IntoResponse
  src/mappings.rs               code -> (name, kind, hero, supply) cache; the object-race rule
  tests/goldens.rs + tests/goldens/<route>/<case>.{json,sql,err}
  tests/http.rs                 the router against a stub ClickHouse
  tests/live.rs + tests/parity/search/*.sql   #[ignore]: live ClickHouse only (17.3)
```

- `lib.rs` exists because `tests/` links only a library (as parse-rs).
- No trait over the client: the HTTP tests stub ClickHouse at the HTTP level.
- State: `#[derive(Clone)] struct App { ch: Ch, mappings: Arc<OnceCell<Mappings>>, download_base: Option<String> }`. `Ch` holds the semaphore (6.1).

### 3.1 Request flow

1. Extract: axum `Query<T>` (GET), `Bytes` (`POST /search`), `Path` (`/replays/{id}`).
2. Validate (pure): `req::search(page, body, &mappings) -> Result<Search, ApiError>`.
3. Compile (pure): `sql::search(&Search) -> Vec<Query>`.
4. Run: `ch.rows::<Row>(&q)`. `/stats` and `/replays/{id}` use `tokio::try_join!`; on one failure it drops the others, and `cancel_http_readonly_queries_on_client_close` ends them (M12).
5. Respond: `(StatusCode, [(CACHE_CONTROL, ..), (X-Total-Count, ..)], Json(body))`.

## 4. Request models and validation

### 4.1 Body (`POST /search`)

- Serde structs with `#[serde(deny_unknown_fields)]`. `Outcome` and `EventType` use `rename`/`rename_all = "snake_case"`. A `race` field is a `String`, mapped in `req` (4.4), so the 400 text is the api.md one.
- Race values on the wire are the GNL ids `HU OC NE UD RANDOM`. `RANDOM` is a fifth race.
- The handler takes `Bytes` and calls `serde_path_to_error::deserialize`: text `<path>: <serde message>` (api.md 2.6). Not axum `Json`: its text has a fixed axum prefix (axum: src/json.rs:174-194). Cost: a 3-line `Content-Type: application/json` check for the 415.
- `DefaultBodyLimit::max(16384)` gives the 413 (api.md 2.6, 2.8). The `Bytes` extractor obeys it.
- Bounds and cross-field rules run in `req::search` after serde: `bad("<path>: <rule>")` with the api.md 3.4 texts.
- Kind check (api.md 3.4): a `subject_code` must exist in `Mappings` with a kind that fits `event_type`. It reads the in-memory `Mappings`, no data scan.
- PR 15 adds the D4 Step and Group fields (minimum count, "without", first hero). The count form counts orders.

### 4.2 Query strings (R2)

Decided: every field is `Option<String>`, parsed in `req`. Why: empty means absent (api.md 2.1), and the texts are fixed (api.md 3.4); typed serde fields fail on `""` with serde's words.

- `filter(|s| !s.is_empty())`, then parse. Comma lists use `split(',')`.
- `deny_unknown_fields`: an unknown key gives 400; a repeated key gives serde's "duplicate field" 400.
- **Trap:** no `#[serde(flatten)]` for the 6 filter keys: serde does not support it with `deny_unknown_fields`. Each struct lists its keys: `StatsQ` (6), `OpenersQ` (6 + `prefix`, `sort`), `OpenerReplaysQ` (6 + `prefix`, `limit`, `offset`), `PageQ` (`limit`, `offset`; no `sort` or `order`, api.md A2), `NoQ`. `req::filters(..) -> Result<Filters, ApiError>` is shared.
- `player`, `map`: 1-64 chars, no control characters (below U+0020).

### 4.3 Parameter values (measured)

Every value reaches ClickHouse as `param_<name>` for a `{name:Type}` placeholder. The value is text in ClickHouse's escaped format, not raw text.

| Type | Rule | Evidence |
|---|---|---|
| `String` | Escape `\` as `\\` | M1 |
| `Array(String)` | `['a','b']`, `\` and `'` escaped inside quotes | M2 (a raw `'` gave Code 130) |
| Integers | `n.to_string()` | |

```rust
/// A String param value. ClickHouse unescapes `\` sequences in it (M1).
fn text(v: &str) -> String { v.replace('\\', "\\\\") }
/// An Array(String) param value (M2).
fn texts(vs: &[&str]) -> String {
    let items: Vec<String> = vs.iter().map(|v| format!("'{}'", v.replace('\\', "\\\\").replace('\'', "\\'"))).collect();
    format!("[{}]", items.join(","))
}
```

Both get a unit test with the M1 and M2 inputs.

### 4.4 Race ids

Decided (Daniel, 2026-09-11): the wire carries the GNL ids `HU OC NE UD RANDOM` (gnl backend `app/models/enums.py:4-9`, api.md 2.1). Storage keeps the parser's letters `H O N U R` in `replay_players.race` and the event tables. No re-parse.

- One `const RACES: [(&str, char); 5]` in `req.rs` holds the pairs `HU H`, `OC O`, `NE N`, `UD U`, `RANDOM R`. Two functions read it: id to letter, letter to id.
- Request parsing maps every race parameter to its letter before `sql.rs` sees it: `race`, `opponent_race` and `groups[i].race`. An unknown id gives 400 `groups[0].race: must be one of HU, OC, NE, UD, RANDOM` (api.md 3.4).
- The hydrate maps back: every `race` field of a response holds a GNL id, `GET /mappings` included (api.md 3.2). The `matchup` string stays as stored, e.g. `"NvO"`.
- SQL text, every `{name:String}` parameter value and the goldens keep the letters (17.1).
- Unit test: each id maps to its letter and back; an unknown id gives the 400 text.

## 5. The SQL compiler (`sql.rs`)

```rust
pub struct Query { pub sql: String, pub params: Vec<(String, String)> }  // name without "param_", encoded value
```

| # | Rule |
|---|---|
| 1 | Pure: no I/O, clock or randomness. Goldens compare bytes. |
| 2 | SQL text comes only from static fragments, loop indices and `match` arms on enums. No request string enters it (guard test, 17.1). |
| 3 | Semantic param names: `g0_race`, `g0_s1_code`, `g0_s1_to`, `g0_pat`, `g0_s1_pat`, `map`, `min_ms`, `limit`, `offset`. |
| 4 | One fixed `ORDER BY` per list route (api.md 2.4). `/openers` picks one of two by a `match` on `sort` returning `&'static str`. |
| 5 | The `sequenceMatch` pattern is a bound `{g<i>_pat:String}` (measured to work: clickhouse-audit.md:127). |
| 6 | Two patterns (api.md 3.4; queries.md §4.2, rule 7). Order: `(?1)`, then `.*(?<k>)` per later step, never a `(?t…)`. Gap: each step with `within_previous_seconds` ANDs `sequenceMatch({g<i>_s<k>_pat:String})(time_ms, <cond k-1>, <cond k>)` with `(?1)(?t<=<ms>)(?2)`. Never `.*(?t<=N)` or `(?t<=N).*` (false matches or adjacency; w3warehouse-api.md §7). |
| 7 | One step: no `sequenceMatch`; the condition goes into the WHERE (index.html:720-721). |
| 8 | Times are `UInt32` ms (`seconds * 1000`, `minutes * 60000`), max 10,800,000. The `(?t<=N)` unit is ms against `time_ms`. |
| 9 | No `SETTINGS` (Code 164 under `readonly = 1`, w3warehouse-api.md C3; `agent-query-safety`: limits in the profile) and no `FORMAT`: `Ch` appends `\nFORMAT JSON` (6.1), the transport, as queries.md §1. The goldens equal queries.md §7. |
| 10 | Header reads use `FINAL`; event counts use `uniqExact` or `DISTINCT` (`insert-optimize-avoid-final`; clickhouse-audit.md:41, finding 7). |
| 11 | Each slot's `replay_players FINAL` read is filtered with `(replay_id, player_id) IN (<slot set>)` before the join (`query-join-filter-before`; queries.md §6 C2). `replays FINAL` is not pre-filtered: a second `IN` rebuilds the set; the runtime join filter covers it (26.2+, queries.md 3.4). |
| 12 | Every event read (steps, openers, counts, stats, timeline) adds `is_repeat = 0`. Decided: PR 2 flags at load a same-code order by the same player under 1000 ms after the previous one, for tier halls, research and heroes only (queries.md). |
| 13 | `player_heroes` reads drop the 68 rows with `hero_id = ''`. `kind != 'unknown'` stays in SQL. |

Shapes: api.md 3.4-3.8. One function per route, no builder type. `search` ports index.html:699-798, each `q(...)` paste (index.html:471) replaced by a bound name.

## 6. The ClickHouse client (`ch.rs`)

### 6.1 Request

- `POST {CLICKHOUSE_URL}/`, body `<compiled SQL>\nFORMAT JSON` (a clause, which `readonly = 1` accepts; `default_format` is a setting and fails).
- URL keys: only `param_<name>`, through reqwest's `query` feature. No settings, no `query_id`.
- Auth headers: `X-ClickHouse-User`, `X-ClickHouse-Key`.
- Permits (api.md 2.8, A12): `Arc<tokio::sync::Semaphore>` with 6 permits; each query calls `tokio::time::timeout(1 s, acquire())`; a timeout answers 503 `warehouse busy: retry` with `Retry-After: 1`. The permit drops when the query ends. One `/stats` load holds up to 4.
- Response: `#[derive(Deserialize)] struct Body<T> { data: Vec<T> }`.
- Log id: the `X-ClickHouse-Query-Id` header (M3). `system.query_log` keeps SQL and params 14 days (tuning.xml:43-46). The service never logs SQL.

### 6.2 Error map

Decide by the `X-ClickHouse-Exception-Code` header, never the HTTP status (M3: 159 is HTTP 408).

| ClickHouse result | API answer (api.md 2.6) |
|---|---|
| reqwest `is_connect()` (refused, DNS, connect timeout) | 503 `warehouse offline` |
| code 241 `MEMORY_LIMIT_EXCEEDED` (HTTP 500, M3) | 503 `query used too much memory: narrow the filters` |
| code 159 `TIMEOUT_EXCEEDED` (HTTP 408, M3), or reqwest `is_timeout()` | 504 `query took too long: narrow the filters` |
| code 158 `TOO_MANY_ROWS` (`max_rows_to_read`, HTTP 500, M11) | 400 `query reads too much: narrow the filters` |
| code 160 `TOO_SLOW` (the `sequenceMatch` iteration cap, api.md 3.4 "Too complex") | 400 `groups: search too complex: drop a repeated step or widen a time gap` |
| code 202 `TOO_MANY_SIMULTANEOUS_QUERIES` (`max_concurrent_queries_for_user`) | 503 `warehouse busy: retry`, with `Retry-After: 1` |
| code 396, any other code, a non-2xx with no code, or a 200 body that is not valid JSON | 500 `warehouse query failed` |

- Check `is_connect()` before `is_timeout()`: a connect timeout sets both.
- Decided: 158 and 160 are 400. Why: they depend only on the request; a retry never helps.
- Decided: 241 is 503. Why: `max_memory_usage_for_user` depends on other queries, so a retry can pass.
- 202 means another client of the same user: 6 permits stay under the cap of 8.
- api.md 2.6 holds the same rows with the same texts. Change both together.
- The ClickHouse text goes to the log with code and query id, never to the client.
- M4: without `http_wait_end_of_query = 1` at the HTTP level, a mid-stream error gives HTTP 200 and an `__exception__` trailer. The profile sets it. If it goes missing, the JSON parse fails and the last table row catches it. No special trailer code.

### 6.3 Mappings cache (R7)

Decided: `tokio::sync::OnceCell::get_or_try_init` on first use. Why: same size as a startup load; ClickHouse down at start gives a 503 and a retry, not an exit loop.

- A failed init leaves the cell empty; the next request tries again. `/health` does not read the cache.
- After `just local::mappings` or `just box::mappings`, restart the API (the table changes only on a parser bump, section 16). No TTL reload: add it when mappings change without a restart.
- `Mappings`: `code -> {name, kind, hero, is_supply_building}` from `w3g.mappings` where `kind != 'unknown' AND name != ''` (api.md 3.2). Orc Burrow (`otrb`) is `is_supply_building = 1`: PR 7 adds it to `SUPPLY_BUILDING_CODES` (pipeline/parse-rs/src/bin/export-mappings.rs:28) and to the db/w3g/tables.sql:226-228 comment, then runs `just local::mappings`.
- The object-race rule (api.md 3.2): one function, one unit test over `eaom`, `Edem`, `Recb`, `Rwdm`, `AEmb`, `AHfa`, `ankh`.

## 7. Errors (`error.rs`)

```rust
pub struct ApiError(pub StatusCode, pub String);   // IntoResponse: {"error": text} + Cache-Control: no-store
```

| Source | Mapping |
|---|---|
| Validation | 400 `<path>: <rule>` |
| `QueryRejection` | `From`: 400 with the serde text (unknown and duplicate keys) |
| `BytesRejection` | `From`: keep its status (413), text `body: larger than 16384 bytes` |
| Missing JSON content type | 415 `body: send Content-Type application/json` |
| Unknown route | `Router::fallback` (axum: src/routing/mod.rs:345): 404 `not found` |
| Wrong method | `Router::method_not_allowed_fallback` (axum: src/routing/mod.rs:374): 405 `method not allowed` |
| Bad replay id | 404 `No game with this id`, before any query (api.md 3.8) |
| ClickHouse | 6.2 |

## 8. The read-only ClickHouse user

New file `infrastructure/docker/clickhouse/api-user.xml`, mounted into `users.d` like refreshable.xml (compose.yaml:26).

```xml
<?xml version="1.0"?>
<!-- The warehouse API's user: read-only, w3g only, limits in the profile. -->
<clickhouse>
    <profiles>
        <api>
            <readonly>1</readonly>
            <max_execution_time>5</max_execution_time>
            <timeout_overflow_mode>throw</timeout_overflow_mode>
            <max_memory_usage>1000000000</max_memory_usage>
            <max_memory_usage_for_user>2000000000</max_memory_usage_for_user>
            <max_concurrent_queries_for_user>8</max_concurrent_queries_for_user>
            <max_rows_to_read>10000000</max_rows_to_read>
            <read_overflow_mode>throw</read_overflow_mode>
            <max_bytes_before_external_group_by>500000000</max_bytes_before_external_group_by>
            <max_bytes_before_external_sort>500000000</max_bytes_before_external_sort>
            <max_result_rows>100000</max_result_rows>
            <result_overflow_mode>throw</result_overflow_mode>
            <cancel_http_readonly_queries_on_client_close>1</cancel_http_readonly_queries_on_client_close>
            <http_wait_end_of_query>1</http_wait_end_of_query>
            <output_format_json_quote_64bit_integers>0</output_format_json_quote_64bit_integers>
        </api>
    </profiles>
    <users>
        <warehouse_api>
            <password from_env="CLICKHOUSE_API_PASSWORD"/>
            <!-- loopback (clients in the container) and chapi only: .87 local and box, .88 the fixtures project; not the tunnel's network -->
            <networks><ip>127.0.0.1</ip><ip>::1</ip><ip>172.30.87.0/24</ip><ip>172.30.88.0/24</ip></networks>
            <profile>api</profile>
            <quota>default</quota>
            <access_management>0</access_management>
            <grants><query>GRANT SELECT ON w3g.*</query></grants>
        </warehouse_api>
    </users>
</clickhouse>
```

All values are starting values. Decided: measure them after PR 2 (the rebuild on 26.8).

| Setting | Why |
|---|---|
| `readonly`, `max_execution_time`, `max_memory_usage`, `max_result_rows`, `result_overflow_mode`, `http_wait_end_of_query` | api.md 2.8 |
| `max_rows_to_read` 10 M, `read_overflow_mode = throw` | `agent-query-safety`: bounds scan size; `LIMIT` and `max_result_rows` do not (M5). M11 (26.9): the sum over every table a query reads. Largest route today: openers, 950,132 + 26,268 + 13,134 + 1,567 rows (queries.md §2); its refresh read 991,101 (M15). Rule: 10 × the largest route read, from `system.query_log` `read_rows` for `warehouse_api`. On the current key a no-race event scan reads every granule (queries.md 3.4); it hits 10 M near 69,000 replays (about 145 events each). |
| `max_bytes_before_external_group_by`, `_sort` 500 MB | Half of `max_memory_usage` (`agent-query-safety`). M14: default 0; 26.9 also spills by `max_bytes_ratio_before_external_*` = 0.5. The absolute values work with or without the ratio settings. PR 2 checks 26.8. |
| `cancel_http_readonly_queries_on_client_close` 1 | M12: a dropped connection ends the query in about 1 s (code 394); without it the query holds a slot to `max_execution_time`. Needs `readonly > 0`. The frontend aborts on route change (frontend.md 4). Not checked: that nginx passes a browser abort on to the API (default `proxy_ignore_client_abort off`). The live suite checks the reqwest side (17.3). |
| `max_memory_usage_for_user` 2 GB | Caps all API queries. Box 4 GB (PLAN.md:74), server 80% (tuning.xml:16) = 3.2 GB. Ingest, refresh and merges run as `default`: M15 270 MiB insert, 159 MiB refresh. tuning.xml:14-15 defers a per-query cap "until one fat query starts starving others"; public input is that case. Rule after PR 2: server cap minus that peak, minus merge headroom. |
| `max_concurrent_queries_for_user` 8 | Two `/stats` loads (about 4 queries each). Overflow: 202 (6.2). Watch the 503 rate. |
| `quota` `default` | M14: every limit NULL. On purpose: one shared user, so a quota would lock out everyone. Per-visitor limits belong at Cloudflare. |
| `networks` | Loopback (a `clickhouse-client` inside the container) and `chapi` (only `clickhouse`, `api`, `ui`): `172.30.87.0/24` in the local project and on the box, `172.30.88.0/24` in the `wh-fixtures` project (section 16). Two compose projects cannot share one subnet. The tunnel on `default` cannot log in. Not checked: the source address of a host call through the published port (PR 4 gate). Expected: a host process on the published port arrives from the bridge gateway `172.30.87.1` (local) or `172.30.88.1` (fixtures), inside the subnet; PR 4 records the real address from `system.query_log` and, if it is outside, `api`, `api-parity`, `fixtures::api` and `fixtures::parity` run the API in a container on `chapi`. |
| Not set: `timeout_before_checking_execution_speed` | M13 (26.9): a 2 s limit fired at 2.0 s with 10 and with 0. The live 159 check covers 26.8. |
| `output_format_json_quote_64bit_integers` 0 | M6: 26.9 defaults to 0. The pin keeps `u64` parseable whatever 26.8 does. |
| `max_result_rows` scope | M5: the final result only, not the `/search` slot sets. |
| `GRANT SELECT ON w3g.*` | Least privilege; `url()` and `s3()` stay closed. |
| `password from_env` | Server and API read `CLICKHOUSE_API_PASSWORD` from `.env`, as they read `CLICKHOUSE_PASSWORD` today (.env.example:3-4); PR 4 adds the new line. Set on the box. PR 4 tests the empty case. Not checked: how the image restricts `default` when `CLICKHOUSE_PASSWORD` is empty. |

Wiring:

| Where | Change |
|---|---|
| compose `clickhouse` | Volume `./infrastructure/docker/clickhouse/api-user.xml:/etc/clickhouse-server/users.d/api-user.xml:ro`; env `CLICKHOUSE_API_PASSWORD: "${CLICKHOUSE_API_PASSWORD:-}"`; networks `default`, `chapi` |
| compose top level | `networks: { default: {}, chapi: { ipam: { config: [ { subnet: "${CHAPI_SUBNET:-172.30.87.0/24}" } ] } } }` (must match the XML; not checked against other Docker networks on the box) |
| compose `api` / `ui` | `networks: [chapi]` / `[default, chapi]` |
| compose `cloudflared`, `infrastructure/cloudflared/config.yml.example` | Only if the tunnel moves (section 20): drop `network_mode: "service:clickhouse"` (compose.yaml:128); service `http://ui:80` (lines 9-11 have `http://clickhouse:8123`; the comment at lines 4-5 follows) |
| `just/fixtures.just` | `export CHAPI_SUBNET := '172.30.88.0/24'` (section 16) |
| `.env.example` | `CLICKHOUSE_API_PASSWORD=` (empty locally) |

### 8.1 Exposure

- Today the tunnel sends `warehouse.<domain>` to `http://clickhouse:8123` (config.yml.example:9-11); cloudflared shares the ClickHouse network namespace (compose.yaml:128).
- The `networks` list closes `warehouse_api` to the tunnel whatever its target. The target is open (section 20).
- No startup guard for an empty password: the container binds `0.0.0.0`, so it would stop every local `docker compose up`. The live CI job proves the network list (section 18).

## 9. Config

`std::env::var` with a default (as drain.rs:63). `just` and compose load `.env`.

| Variable | Default | Meaning |
|---|---|---|
| `API_BIND` | `127.0.0.1:8000` | Container: `0.0.0.0:8000` |
| `CLICKHOUSE_URL` | `http://127.0.0.1:8123` | compose: `http://clickhouse:8123`; the fixtures project: `http://127.0.0.1:8124` (`just fixtures::api` sets it) |
| `CLICKHOUSE_API_USER` | `warehouse_api` | Section 8 |
| `CLICKHOUSE_API_PASSWORD` | empty | Section 8 |
| `DOWNLOAD_BASE_URL` | empty | The public R2 base URL |
| `RUST_LOG` | `info` | `tracing-subscriber` filter |

- Decided (D1): `download_url` = `DOWNLOAD_BASE_URL` + `replays.source_key` when both are non-empty, else `null`. The drain writes the raw R2 object key into each doc; `replays.source_key` stores it (PR 3, queries.md §5 S3).
- Tests: base + key concatenates with no extra `/`; an empty key gives `null` (the fixtures); an empty base gives `null` (17.2). Live: every fixture `download_url` is `null`.
- Constants, not env: timeouts, body limit, page bounds, the win-rate floor (pinned by a golden; frontend.md pins its copy by a test). Row, time and memory limits live in the profile, not the service.

## 10. Timeouts

| Layer | Value | Why |
|---|---|---|
| reqwest `connect_timeout` | 1 s | Same box: slow connect means down, 503 fast |
| `max_execution_time` | 5 s (profile) | Code 159: 504 |
| reqwest `timeout` | 8 s | Above 5 s, so 159 arrives first; ends a hung socket |
| reqwest `pool_idle_timeout` | 2 s | M7: `keep_alive_timeout` 3 s; the reqwest default 90 s reuses closed sockets |
| Graceful shutdown | SIGTERM | In-flight requests finish |

No tower `TimeoutLayer`. Slow-header clients: not handled; the proxy and Cloudflare sit in front (PLAN.md:25).

## 11. Measured facts

Measured on 26.9 (host binary 26.9.1.1204) or the local cargo, 2026-09-11, read-only `SELECT`s over HTTP as `default`. PR 2 re-runs M3-M6 and M11-M14 in the 26.8 container.

| # | Fact | How |
|---|---|---|
| M1 | `param_x=a%5Cnb` gave `{"s":"a\nb","l":3}` | `SELECT {x:String} AS s, length(s)` |
| M2 | `param_a=['a\'b','c']` gave `["a'b","c"]`; `['a'b']` gave Code 130 | `SELECT {a:Array(String)}` |
| M3 | Code 159 is HTTP 408; 241 is HTTP 500; both set `X-ClickHouse-Exception-Code`; `X-ClickHouse-Query-Id` is set | `SETTINGS max_execution_time=0.3`, `max_memory_usage=10000000` |
| M4 | `throwIf` at row 200,000: `SETTINGS http_wait_end_of_query=1` gave 200 + `__exception__` trailer; `?http_wait_end_of_query=1` or `?wait_end_of_query=1` gave 500, code 395 | `max_block_size=1000`, 300,000 rows |
| M5 | `max_result_rows=2` did not fire on `count()` over a 10-row subquery or a 5-row `IN` subquery | `result_overflow_mode='throw'` |
| M6 | `output_format_json_quote_64bit_integers` = 0; `count()` gave `{"c":3}` | `system.settings` |
| M7 | `keep_alive_timeout` = 3 | `system.server_settings` |
| M8 | The 3 parser goldens' `id` fields equal the 3 fixture `replay_id` values | `pipeline/parse-rs/tests/goldens/*.json` |
| M9 | axum 0.8.9, reqwest 0.13.5 (MSRV 1.85.0), tokio 1.53.1, serde 1.0.229, serde_json 1.0.151, serde_path_to_error 0.1.20, tracing 0.1.44, tracing-subscriber 0.3.23, tower-http 0.7.1; reqwest `default-tls` is rustls with aws-lc-rs | `cargo info` |
| M10 | axum default features include `tracing`, `json`, `query`; `Json` and `Query` use `serde_path_to_error` | axum: Cargo.toml, src/json.rs:174-194, src/extract/query.rs:91-93 |
| M11 | `max_rows_to_read` overflow: code 158, HTTP 500, `X-ClickHouse-Exception-Code: 158`. It sums over tables: `replays` (6,567) + `replay_players` (13,134) failed a 15,000 cap at "current rows: 19.70 thousand", though the setting's text says "applied only to the deepest table expression" | `?max_rows_to_read=100000` on a `replay_events` sum; `?max_rows_to_read=15000` on two scalar subqueries |
| M12 | `cancel_http_readonly_queries_on_client_close=1`, `readonly=2` (POST) or GET: curl gave up at 1 s, the query ended at about 1,005 ms, code 394, with or without `http_wait_end_of_query`. Without it, or `readonly=0`: ran to 12 s | `numbers(1e11)`, `curl --max-time 1`, then `system.query_log` |
| M13 | `max_execution_time=2` fired at 2.0 s with `timeout_before_checking_execution_speed` 10 and 0 | `numbers(2e10)` |
| M14 | Defaults: `max_rows_to_read` 0, `read_overflow_mode` throw, `max_bytes_before_external_*` 0, `max_bytes_ratio_before_external_*` 0.5, `cancel_http_readonly_queries_on_client_close` 0 (its text: "Cloud default value: 1"), `queue_max_wait_ms` 0; `default` quota limits NULL; codes 158, 202, 394 = `TOO_MANY_ROWS`, `TOO_MANY_SIMULTANEOUS_QUERIES`, `QUERY_WAS_CANCELLED` | `system.settings`, `system.quota_limits` |
| M15 | At 6,567 replays: largest `Insert` by `default` 270 MiB; refresh insert 159 MiB, 991,101 rows read; largest ad-hoc `Select` 323 MiB | `system.query_log` `max(memory_usage)` |
| M16 | 6,567 replays, 13,134 `replay_players`, 950,132 `replay_events` | `count()` |

## 12. Dependencies

```toml
[package]
name = "warehouse-api"
version = "0.1.0"
edition = "2024"
rust-version = "1.85"      # reqwest 0.13 (M9)
publish = false

[dependencies]
axum = "0.8.9"
reqwest = { version = "0.13.5", default-features = false, features = ["query"] }
serde = { version = "1.0.229", features = ["derive"] }
serde_json = "1.0.151"
serde_path_to_error = "0.1.20"
tokio = { version = "1.53.1", features = ["rt-multi-thread", "macros", "net", "signal", "sync", "time"] }
tracing = "0.1.44"
tracing-subscriber = { version = "0.3.23", features = ["env-filter"] }

[lints.rust]
unsafe_code = "forbid"
```

- Caret requirements; the committed `Cargo.lock` pins; every build uses `--locked`.
- reqwest without default features: ClickHouse is plain HTTP; rustls with aws-lc-rs (M9) needs a C toolchain and cmake. Add `rustls` with a TLS hop.
- `serde_path_to_error` and `tracing` already come in through axum (M10); direct use adds no crate.
- No dev-dependencies: `tokio::test`, axum (stub), reqwest.
- Left out: `tower-http` (no CORS, one `from_fn` logger, no `TimeoutLayer`), `anyhow`, `thiserror`, `validator` (the kind check needs `Mappings`), `clickhouse` (decided: reqwest), `insta`, `wiremock`, `uuid` (ClickHouse returns the query id), `dotenvy`, a release `lto` profile (about 92% of request time is ClickHouse, plan-api-ports-go-rust.md:13-17).

## 13. CORS (R5)

Decided: no CORS layer. Why: every caller is same-origin, and a shared cache can keep the first caller's CORS header (api.md 2.7). Add the layer when a second origin exists. The legacy page depends on ClickHouse's own CORS (index.html:436-437, compose.yaml:75-77); the new app does not. Vite proxy (as gnl-frontend vite.config.js:14-21):

```js
server: { proxy: { '/api': {
  target: process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:8000',
  changeOrigin: true,
  rewrite: p => p.replace(/^\/api/, ''),
} } },
```

## 14. Logging (R6)

Decided: `tracing` + `tracing-subscriber`. Why: one crate; axum's events become visible.

- `info` per request (`from_fn` middleware): method, matched route, status, ms.
- `warn` per ClickHouse error: code, query id, first 300 chars of its text.
- Never SQL or param values (the query id finds both). Default `fmt` text to stdout. JSON logs: add when a log store exists.
- Filter example: `RUST_LOG=warehouse_api=debug,axum=debug`.

## 15. Dockerfile and compose

`infrastructure/docker/Dockerfile.api` (as Dockerfile.drain:10-22):

```dockerfile
# The warehouse API. Builder pinned to -bookworm so glibc matches the runtime (see Dockerfile.drain).
FROM rust:1-slim-bookworm AS build
WORKDIR /build
COPY services/api ./services/api
RUN cargo build --release --locked --manifest-path services/api/Cargo.toml

FROM debian:bookworm-slim
COPY --from=build /build/services/api/target/release/warehouse-api /usr/local/bin/warehouse-api
USER nobody
ENV API_BIND=0.0.0.0:8000
EXPOSE 8000
CMD ["warehouse-api"]
```

- No `ca-certificates` (no TLS). `.dockerignore:3` `target/` becomes `**/target/` (PR 4).

```yaml
  # The JSON API over ClickHouse, as the read-only warehouse_api user.
  api:
    build:
      context: .
      dockerfile: infrastructure/docker/Dockerfile.api
    environment:
      CLICKHOUSE_URL: http://clickhouse:8123
      CLICKHOUSE_API_PASSWORD: "${CLICKHOUSE_API_PASSWORD:-}"
      DOWNLOAD_BASE_URL: "${DOWNLOAD_BASE_URL:-}"
      RUST_LOG: "${RUST_LOG:-info}"
    networks: [chapi]            # the only subnet warehouse_api accepts (section 8)
    ports:
      - "127.0.0.1:8000:8000"
    depends_on:
      clickhouse:
        condition: service_healthy
    restart: unless-stopped
```

- Loopback port only (as compose.yaml:19-20). nginx in `ui` proxies `location /api/ { proxy_pass http://api:8000/; }`; frontend.md owns it.
- Decided: no compose healthcheck. Why: `bookworm-slim` has no curl, and nothing depends on the API. `GET /health` is an ops probe (api.md §1). When something needs a healthcheck, add a `--health` flag (one GET to `/health`; reqwest is linked).

## 16. just recipes

Docker first (plan.md §4, Daniel, 2026-09-11). The rules:

- The place is a just module, not an argument. A place that cannot be reached has no module.
- Recipes drive compose. Nobody types a `docker` command by hand.
- Nested calls use `{{ just_executable() }}`, never bare `just`.
- A module sets `working-directory := '..'` and uses relative paths. It never uses `justfile_directory()`: inside a module that returns the root's directory (a just bug).
- No `scripts/` files. An operational step is a recipe.
- Secrets come from `.env`, never from a recipe. The root's `set dotenv-load` loads `.env` for module recipes too.
- Checked on just 1.58.0: a root alias to a module recipe, `working-directory := '..'` in a module, and a module `export` that reaches a nested call.

| Module | File | Lands | Place |
|---|---|---|---|
| root | `justfile` | today | No ClickHouse: cargo, npm, the module list |
| `local` | `just/local.just` | PR 1 | Compose project `wc3-gym-warehouse` (compose.yaml:8). ClickHouse on `127.0.0.1:8123`. Holds the full load. |
| `fixtures` | `just/fixtures.just` | PR 1 | Compose project `wh-fixtures`: own volumes, ClickHouse on `127.0.0.1:8124`, `chapi` `172.30.88.0/24`. Holds the 3 fixtures, or the PR 1b battle set. |
| `box` | `just/box.just` | The box PR (PLAN.md build order step 3), not before | The Hetzner box, over ssh |

`justfile` (root):

```just
# wc3-gym-warehouse: ClickHouse, the parse drain, the API and the pages.
# Secrets come from .env (see .env.example), never from a recipe.
set dotenv-load

mod local 'just/local.just'
mod fixtures 'just/fixtures.just'
# mod box 'just/box.just'        # lands with the box

alias up := local::up
alias down := local::down
alias ch := local::ch

manifest := 'pipeline/parse-rs/Cargo.toml'
api_manifest := 'services/api/Cargo.toml'

_default:
    @{{ just_executable() }} --list --list-submodules

# run the API against CLICKHOUSE_URL (default: the local project) on API_BIND
api:
    cargo run --manifest-path {{api_manifest}}

# parser tests and goldens, then the API goldens and HTTP tests
test:
    cargo test --manifest-path {{manifest}}
    cargo test --locked --manifest-path {{api_manifest}}

# rewrite the API SQL goldens from the compiler; review the git diff
api-bless:
    UPDATE_GOLDENS=1 cargo test --manifest-path {{api_manifest}} --test goldens

# format check and clippy on the API, warnings fail
api-lint:
    cargo fmt --check --manifest-path {{api_manifest}}
    cargo clippy --locked --manifest-path {{api_manifest}} --all-targets -- -D warnings

# the live suite on CLICKHOUSE_URL (default: the local project): parity, story numbers, user checks
api-parity:
    cargo test --locked --manifest-path {{api_manifest}} --test live -- --ignored
```

`just/local.just` (PR 1). `mappings`, `backfill` and `backfill-bucket` move from justfile:30-58 with two changes: the new `client`, and `backfill-bucket` calls `local::backfill`.

```just
# The local compose project: ClickHouse on 127.0.0.1:8123, the drain, the ui.
set working-directory := '..'

manifest := 'pipeline/parse-rs/Cargo.toml'
# Must match PARSE_VERSION in pipeline/parse-rs/src/lib.rs.
parse_version := '2'
# clickhouse-client in the container, SQL on stdin. $CLICKHOUSE_PASSWORD expands in the container.
client := "docker compose exec -T clickhouse sh -c 'exec clickhouse-client ${CLICKHOUSE_PASSWORD:+--password=\"$CLICKHOUSE_PASSWORD\"} \"$@\"' client"

# PR 1 refreshes w3g.refresh__opener_rollup (views.sql:444); PR 2 (S2) renames it to w3g.refresh__openers.

# build and start clickhouse, the schema one-shot, the drain and the ui
up:
    docker compose up -d --build

# stop the project; its volumes and the full load stay
down:
    docker compose down

# an interactive clickhouse-client
ch:
    docker compose exec clickhouse sh -c 'exec clickhouse-client ${CLICKHOUSE_PASSWORD:+--password="$CLICKHOUSE_PASSWORD"}'

# apply tables.sql then views.sql: the compose one-shot, which starts clickhouse
schema:
    docker compose run --rm schema

# load the 3 parser goldens into w3g.replays_raw, no bucket needed (run mappings first)
fixtures:
    for f in pipeline/parse-rs/tests/goldens/*.json; do {{client}} --query "INSERT INTO w3g.replays_raw (replay_id, doc) SELECT JSONExtractString(doc, 'id'), doc FROM input('doc String') WHERE JSONExtractString(doc, 'id') NOT IN (SELECT replay_id FROM w3g.replays_raw) FORMAT JSONAsString" < "$f"; done
    {{client}} --query 'SYSTEM REFRESH VIEW w3g.refresh__opener_rollup'

# load parsed docs from the mounted data/ in one INSERT … FROM file(), then refresh
load glob='data/parsed/gnl/*.json':
    {{client}} --param_glob='{{glob}}' --query "INSERT INTO w3g.replays_raw (replay_id, doc) SELECT JSONExtractString(doc, 'id') AS replay_id, doc FROM file({glob:String}, 'JSONAsString', 'doc String') WHERE replay_id != '' AND replay_id NOT IN (SELECT replay_id FROM w3g.replays_raw) LIMIT 1 BY replay_id"
    {{client}} --query 'SYSTEM REFRESH VIEW w3g.refresh__opener_rollup'

# parse every new or changed replay in the bucket once, with the drain image
drain-once:
    docker compose run --rm --build drain drain --once
```

`just/fixtures.just` (PR 1; `battle-test` PR 1b; `api`, `parity` PR 5):

```just
# The fixtures project: an empty ClickHouse on 127.0.0.1:8124 with the 3 parser goldens.
# It reuses the local recipes; compose reads these three values from the environment.
set working-directory := '..'

export COMPOSE_PROJECT_NAME := 'wh-fixtures'
export CLICKHOUSE_HTTP_PORT := '8124'
export CHAPI_SUBNET := '172.30.88.0/24'

# drop the project and rebuild it from nothing: schema, mappings, the 3 fixtures
up: down
    {{ just_executable() }} local::schema local::mappings local::fixtures

# remove the project and its volumes
down:
    docker compose --profile local down -v

# an interactive clickhouse-client on this project
ch:
    {{ just_executable() }} local::ch

# the API on this project
api:
    CLICKHOUSE_URL=http://127.0.0.1:8124 {{ just_executable() }} api

# the live suite on this project
parity:
    CLICKHOUSE_URL=http://127.0.0.1:8124 {{ just_executable() }} api-parity

# PR 1b: the raw .w3g files through compose MinIO, the drain image and backfill-bucket (never R2)
battle-test: down
    #!/usr/bin/env bash
    set -euo pipefail
    # The public MinIO defaults, not secrets. Every S3 variable is set, so .env R2 values never apply.
    export W3WAREHOUSE_S3_ENDPOINT=minio:9000 W3WAREHOUSE_S3_SECURE=false W3WAREHOUSE_S3_ACCESS_KEY=minioadmin \
      W3WAREHOUSE_S3_SECRET_KEY=minioadmin W3WAREHOUSE_S3_BUCKET=warehouse W3WAREHOUSE_S3_PREFIX=dev
    raw="$(realpath "${W3WAREHOUSE_DATA_DIR:-data}")/deploy/gnl"
    mc='mc alias set -q l http://minio:9000 minioadmin minioadmin'
    {{ just_executable() }} local::schema local::mappings
    docker compose --profile local run --rm -v "$raw:/in:ro" --entrypoint sh minio-setup -c \
      "$mc && mc mb -q --ignore-existing l/warehouse && for f in /in/*.w3g; do s=\$(basename \"\$f\" .w3g); mc cp -q \"\$f\" l/warehouse/dev/replays/\$s/game1.w3g; done"
    {{ just_executable() }} local::drain-once
    {{ just_executable() }} local::drain-once    # the gate: this pass parses 0 files
    {{ just_executable() }} local::backfill-bucket
    docker compose --profile local run --rm --entrypoint sh minio-setup -c \
      "$mc && mc find l/warehouse/dev/status --name '*.json' --exec 'mc cat {}'" | grep '"failed"' || true
```

`just/box.just` (the box PR, not before). `WAREHOUSE_BOX` (`user@host`) and `WAREHOUSE_BOX_DIR` come from `.env`. The box PR checks the quoting.

```just
# The Hetzner box, over ssh. The box's own .env holds its secrets and never leaves the box.
set working-directory := '..'

ssh := 'ssh "$WAREHOUSE_BOX" cd "$WAREHOUSE_BOX_DIR" "&&"'
# The box's clickhouse-client, SQL on stdin. Two quote layers: $CLICKHOUSE_PASSWORD expands in the container.
client := ssh + ' ' + '''docker compose exec -T clickhouse sh -c "'exec clickhouse-client \${CLICKHOUSE_PASSWORD:+--password=\"\$CLICKHOUSE_PASSWORD\"} \"\$@\"'" client'''

# copy compose.yaml, db/ and the ClickHouse config; pull the CI images; restart what changed
deploy:
    rsync -a --relative compose.yaml db/ infrastructure/docker/clickhouse/ "$WAREHOUSE_BOX:$WAREHOUSE_BOX_DIR/"
    {{ssh}} docker compose --profile prod pull
    {{ssh}} docker compose --profile prod up -d

# apply tables.sql then views.sql on the box: the compose one-shot
schema:
    {{ssh}} docker compose run --rm schema

# rebuild w3g.mappings from the deployed drain image's export-mappings, then the custom-map seed
mappings:
    {{ssh}} docker compose run --rm --no-deps -T drain sh -c "'export-mappings /tmp/m.json >&2 && cat /tmp/m.json'" > /tmp/box-mappings.json
    {{client}} --query "'TRUNCATE TABLE w3g.mappings'"
    {{client}} --query "'INSERT INTO w3g.mappings (code, name, kind, race, hero, is_supply_building) FORMAT JSONEachRow'" < /tmp/box-mappings.json
    {{client}} --query "'INSERT INTO w3g.mappings (code, name, kind, category) FORMAT JSONEachRow'" < db/w3g/seed/custom_object_names.ndjson

# an interactive clickhouse-client on the box
ch:
    ssh -t "$WAREHOUSE_BOX" cd "$WAREHOUSE_BOX_DIR" "&&" docker compose exec clickhouse sh -c "'exec clickhouse-client \${CLICKHOUSE_PASSWORD:+--password=\"\$CLICKHOUSE_PASSWORD\"}'"
```

- `client` (PR 1) has one path: the container. Today's fallback (justfile:5-9) runs a host `clickhouse-client` when one is on PATH. That binary connects to native port 9000, which compose does not publish, so on such a machine every recipe misses the container.
- `fixtures`: the 3 parser goldens are the 3 fixture replays (M8); the `replay_id` gate copies backfill.sql:22-23. PR 1 adds it with today's target `w3g.refresh__opener_rollup`; PR 2 (S2) renames it, and the `backfill` and `load` refreshes, to `w3g.refresh__openers`. PR 1 checks that the `input()` + `JSONAsString` insert works and that `SYSTEM REFRESH VIEW` has finished before the recipe returns (add `SYSTEM WAIT VIEW` if the refresh is async).
- `load` (PR 1) loads parsed docs in one `INSERT … FROM file()` (`insert-batch-size`), with the backfill.sql:22-23 gate and `LIMIT 1 BY replay_id`. `file()` is chrooted to `user_files_path` `/app/` (user-files.xml). Compose mounts `${W3WAREHOUSE_DATA_DIR:-./data}` read-only at `/app/data`, so the glob reads as a repo-relative path. A worktree has no `data/`: its `.env` sets `W3WAREHOUSE_DATA_DIR` to the main clone's `data/`. PR 2 rebuilds the local project with `load`.
- `fixtures::up` drops its volumes first, so the base is the same every time (D3). No recipe removes the local project's volumes.
- The `fixtures` module exports `COMPOSE_PROJECT_NAME`, `CLICKHOUSE_HTTP_PORT` and `CHAPI_SUBNET`, then calls the `local` recipes. Compose takes these from the shell before `.env`. The project starts only `clickhouse` (through `schema`) and, in `battle-test`, MinIO and the drain; `ui` (8080) and `api` (8000) run only in the local project.
- `battle-test` (PR 1b, `chore/drain-battle-test`) runs the bulk set through the real path, in containers only: 6,564 files, 1.4 GB, from `data/deploy/gnl/`. No host MinIO and no host port: the drain and ClickHouse reach `minio:9000` on the project network. The stems are numeric, so the drain key parser (drain.rs:113-120) accepts `dev/replays/<stem>/game1.w3g`; the stem becomes a fake `gnl_series_id`. `just fixtures::up` restores the fixture base after.
- Memory: each ClickHouse container may take 80% of RAM (tuning.xml:16). Record the local project's oracle numbers first, then `just down` if the machine is short during the battle test.
- PR 1b gates: in `wh-fixtures`, the `replays FINAL` count and `sum(cityHash64(replay_id))` equal the local project's `file()` load of the same 6,564 files (the 3 fixtures excluded). The second `drain-once` parses 0 files. Every failure is listed with its reason (the `"failed"` breadcrumbs: key, error). The `dev/` prefix and its fake series ids stay in the `wh-fixtures` volumes and never reach the org deploy; after PR 3, `countIf(startsWith(source_key, 'dev/'))` is 0 on the box.
- `box` (the box PR): `deploy` copies only tracked files and pulls the CI images. Compose gains `image: ghcr.io/warcraft-gym/wc3-gym-warehouse-<drain|api|ui>:latest` beside each `build:`, so `pull` has something to pull. `mappings` uses the deployed drain image (Dockerfile.drain ships `export-mappings`), so the table matches the running parser. `backfill-bucket` (PLAN.md:105, "rebuild from nothing") builds the URL and keys inside the box's `clickhouse` container from the `W3WAREHOUSE_S3_*` values compose passes in; nothing secret crosses ssh. A rollback deploys a `:<sha>` tag; add a tag argument when the first rollback happens.
- PR 3 re-stages the staging bucket the same way: the drain re-runs with the breadcrumbs cleared, so each doc carries its raw key.
- `test` stays one command. frontend.md adds `npm --prefix frontend test` to it. `ui` and `ui-build` (frontend.md 14.2) sit in the root: they touch no ClickHouse.

## 17. Testing

### 17.1 SQL goldens (`tests/goldens.rs`)

- One case = `tests/goldens/<route>/<case>.json` plus `<case>.sql` (queries and params) or `<case>.err` (status and text).
- Input: `{"query": "race=NE&prefix=eate", "body": {...}}`. The runner parses `query` with axum's `Query::try_from_uri` (the handler's path), then calls `req::<route>` and `sql::<route>`.
- `.sql`: each query as emitted (no `FORMAT`), then its params as comments, byte for byte:

```
-- query 1
SELECT ...
-- param g0_race=N
-- param g0_pat=(?1)(?t<=10000)(?2)
```

- Race ids: the input holds a GNL id, the param holds the stored letter (4.4).
- `tests/goldens/mappings.json`: a small fixed `Mappings` with only the codes used, so a parser bump does not move goldens.
- `UPDATE_GOLDENS=1` rewrites the files (`just api-bless`); the git diff is the review (parse-rs tests/parity.rs:13-16).
- Guard: no `String` param value of 4+ chars appears in any SQL text (rule 2).
- Guard: every query reading `replay_events` or `player_order_events` holds `is_repeat = 0` (rule 12).

| Route | Cases |
|---|---|
| search | one step hero `Edem` (no `sequenceMatch`); two steps open gap (`(?1).*(?2)`); 10 s gap (`(?1)(?t<=10000)(?2)`); three steps mixed (`(?1).*(?2).*(?3)` plus `(?1)(?t<=N)(?2)`, G08); step window; opponent slot; result won; result lost; player bound; map and minutes; no groups (lists every game); `limit=2&offset=1` (G17); repeated step (G09); mirror (G12); Random slot (G15); no race (G16); flagged code `ostr` then `ostr` (G18); equal timestamps (real-data golden). Byte-equal to queries.md §7. |
| search errors | 3 groups; 9 steps; gap on step 0; `to` below `from`; `Edem` as `building`; unknown code; race `X`; `limit=0`; unknown field; wrong type |
| search D4 (PR 15) | minimum count ("at least 5 Archer orders by 5:00", `uniqExact(seq)`); "without" only (base: `replay_players` of that race); first hero |
| openers | top level; prefix of 2; player filter; `sort=winrate` |
| openers errors | no race; 6 codes; a supply building; `sort=x`; `race=` ("race: required") |
| openers/replays | prefix of 3 with paging |
| stats | no filter; all 6 filters |
| replay | a valid id; `nope` (404, no query) |
| filters, mappings | one case each |

These cover the 28 applicable w3warehouse cases (w3warehouse-api.md §8), minus the name-input cases (codes only, C2).

### 17.2 HTTP tests with a stub ClickHouse (`tests/http.rs`) (R4)

Decided: the stub is a small axum app in the test (about 25 lines). Why: same power as `wiremock`, 0 crates. It records (URL query, headers, body) in an `Arc<Mutex<Vec<_>>>`. Stub and API bind `127.0.0.1:0`.

- Happy path: `/mappings` 200 with the derived `race` and `Cache-Control: public, max-age=3600`; `/search` sets `X-Total-Count`.
- Sent to ClickHouse: auth headers; every URL key starts with `param_`; the body ends in `\nFORMAT JSON` exactly once.
- Error map: 408 + 159 → 504; 500 + 241 → 503; 500 + 158 → 400 `query reads too much: narrow the filters`; 500 + 160 → 400 `search too complex`; 500 + 202 → 503 `warehouse busy: retry` + `Retry-After: 1`; 500 + 396 → 500; closed port → 503 `warehouse offline`; 200 + broken body → 500. All with `no-store` and the envelope.
- Permits: the stub holds each answer 2 s; four parallel `GET /filters` send 8 queries; the stub never sees more than 6 at once; a query waiting past 1 s gets 503 `warehouse busy: retry` + `Retry-After: 1`.
- `download_url`: base + key; empty key → `null`; empty base → `null`.
- API side: unknown query key 400; unknown body field 400 with its path; 16,385-byte body 413; no content type 415; `DELETE /stats` 405; `/nope` 404; `/replays/nope` 404 with 0 stub requests.

### 17.3 Live suite on a real ClickHouse (`tests/live.rs`, `#[ignore]`)

| Check | Asserts | Data |
|---|---|---|
| Search parity | `tests/parity/search/*.sql` freezes the page's search SQL per story Review case (`buildSql()` and `slotSelect()`, frontend/index.html:699-798). Its replay-id set equals `POST /search` (`limit=100`). | Fixtures and full load |
| Story numbers | `/stats` 3 games, NvO 2, HvN 1 (story 3); `dcd3…` Concealed Hill, NvO, 15.6 min (story 4); 150 events after the PR 2 flag (api.md 3.8); the openers Review rows; every `download_url` is `null` | The 3 fixtures (M8) |
| Pattern semantics | Compiler patterns over inline rows: A@0, A@5 s, B@100 s with a 10 s gap gives 0; A@0, X@3 s, B@8 s gives 1 (api.md 3.4 goldens) | Inline rows |
| Read-only user | `SELECT {x:UInt8}` as `warehouse_api` works; a `SETTINGS max_execution_time = 1` query gives Code 164 | None |
| Profile limits | Over `max_rows_to_read` gives 158, summed over tables (M11); a slow read gives 159 | `numbers()` |
| Cancel on close | A slow `SELECT` through `Ch` with a fixed `query_id`; drop the future after 1 s; poll `system.processes` until the id is gone (bound 5 s). Proves a dropped reqwest future closes the socket. | `numbers()` |

- Search parity is the only semantic oracle: blessed goldens catch a change, not a wrong answer. The frozen SQL lands in PR 6 and outlives `frontend/index.html` (deleted in PR 14). It reads `replay_events`, `replay_players`, `replays` and `w3g.replay_map` (index.html:751, :767, :795), which keep their names (S2 retires only the rollup objects). It does not depend on the data.
- Known difference: the page's second slot can bind slot 1's player (index.html:775-788); the API binds two players. The cases avoid mirrors.
- Known difference: the page SQL has no `is_repeat = 0` (rule 12). The frozen copy adds it to its event reads, so both sides read the same rows.
- Openers have no frozen SQL: the page template (index.html:906-923) reads the `replay_openers` view, and S2 moves the route to `w3g.openers` (queries.md §6 C7). The story Review rows check them.
- Not asserted: the G01-G18 and O1-O4 full-load totals (data-dependent, queries.md §7; CI has no bulk set).

### 17.4 Lint

`cargo clippy --all-targets --locked -- -D warnings` and `cargo fmt --check` (`just api-lint`, CI). Decided: clippy on parse-rs waits for a later `chore/` PR.

## 18. CI (R8)

`infrastructure/ci.yml`; Daniel copies it to `.github/workflows/` (ci.yml:1). Decided: a `live` job on the compose ClickHouse (26.8, api-user.xml mounted) replaces `schema` (ci.yml:22-43). Why: it proves the users.d XML loads, `readonly = 1` accepts `param_*` over HTTP, and the 26.9 facts hold on 26.8. No secrets: the fixtures ship in the repo (M8).

```yaml
  rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy, rustfmt
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: |
            pipeline/parse-rs
            services/api
      - run: cargo test --manifest-path pipeline/parse-rs/Cargo.toml
      - run: cargo fmt --check --manifest-path services/api/Cargo.toml
      - run: cargo clippy --locked --manifest-path services/api/Cargo.toml --all-targets -- -D warnings
      - run: cargo test --locked --manifest-path services/api/Cargo.toml

  # Replaces `schema`: the compose ClickHouse (26.8, api-user.xml mounted), the schema, the 3 fixtures, parity.
  live:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: |
            pipeline/parse-rs
            services/api
      - uses: extractions/setup-just@v2
      - run: just local::schema
      - run: just local::mappings local::fixtures
      - run: just api-parity
        env:
          CLICKHOUSE_URL: http://127.0.0.1:8123
```

- `just local::schema` runs the compose `schema` one-shot. It starts ClickHouse through `depends_on` (compose.yaml:56-58) and applies both SQL files. The job runs the same `clickhouse/clickhouse-server:26.8` image as the local project and the box.
- Network check (PR 4 gate): `docker run --rm --network wc3-gym-warehouse_default curlimages/curl` to `http://clickhouse:8123/?query=SELECT+1` with the `warehouse_api` headers gives code 516 `AUTHENTICATION_FAILED`, with the right password and with an empty one.
- If ClickHouse sees the runner's calls on 8123 from the `default` gateway, the job runs the suite in a container on `chapi`.
- Every recipe reaches ClickHouse through `docker compose exec`, so the runner needs no `clickhouse-client`.
- `image` job: a second `docker/build-push-action` step for `Dockerfile.api`, tags `ghcr.io/warcraft-gym/wc3-gym-warehouse-api:latest` and `:${{ github.sha }}` (as ci.yml:58-65).
- Deploy: CI builds and pushes the images; `just box::deploy` pulls them on the box (section 16). A CI deploy step (PLAN.md:98) needs an ssh key secret; it waits until the box exists.

## 19. Design choices

All decided: R1 separate crate (2); R2 `Option<String>` query fields (4.2); R3 hand-rolled goldens with `UPDATE_GOLDENS=1`, not `insta` (repo convention, plain `.sql` diffs); R4 axum stub (17.2); R5 no CORS (13); R6 `tracing` (14); R7 `OnceCell` mappings (6.3); R8 live CI job on 26.8 (18); R9 `warehouse_api` bound to loopback and `chapi` (8). The tunnel target stays open (20).

## 20. Open questions

Both decide at PR 10. Hosting (the box first, the gnl app later) is in frontend.md.

1. **Public ingress.** (a) Keep the tunnel on ClickHouse 8123 with the password: any holder of the password runs any SELECT on `w3g`, and one env value is the only fence. (b) Tunnel to the `ui` nginx (`http://ui:80`), which serves the app and proxies `/api/`: only the 8 routes are public, and Cloudflare rules see API routes. **Recommend (b)**, with one Cloudflare rate-limit rule per IP on `/api/*` (not checked: which rules the plan allows). (b) needs the cloudflared rows of section 8.
2. **GNL backend search path.** PLAN.md:39 and :58 say "ClickHouse or the API". (a) The API's `POST /search` on the same hostname. (b) Raw ClickHouse: a second hostname and its own user, never `warehouse_api`. **Recommend (a)**: after 1(b), 8123 is not public. PLAN.md, compose.yaml and config.yml.example follow the answer.
