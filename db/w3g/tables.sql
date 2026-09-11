-- db/w3g/tables.sql — all CREATE TABLE statements for the w3g database.
--
-- Applied before views.sql on every run. This file is the source of truth for
-- the shape.
--
-- Contents:
--   - Raw landing:        replays_raw
--   - Header/per-player:  replays, replay_players, player_heroes,
--                         player_group_hotkeys
--   - Event source:       player_order_events, hero_ability_events,
--                         chat, resource_transfers
--   - Mart fact:          replay_events
--   - Dim:                mappings
--   - Rollup target:      opener_rollup

CREATE DATABASE IF NOT EXISTS w3g;

-- Raw landing: one row per replay, full w3grs JSON document as String.
-- Re-staging the same replay_id is a no-op after merge.
CREATE TABLE IF NOT EXISTS w3g.replays_raw
(
    replay_id   String,
    doc         String,
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY replay_id;

-- Header + global settings transcribed from the .w3g.
CREATE TABLE IF NOT EXISTS w3g.replays
(
    replay_id        String,
    -- The GNL series and game number the object key carried, written into the
    -- parsed document by the drain. 0 for a replay from any other source.
    gnl_series_id    UInt32,
    gnl_game_no      UInt8,
    map_json         String,
    gamename         String,
    creator          String,
    type             LowCardinality(String),
    matchup          LowCardinality(String),
    duration_ms      UInt32,
    build_number     UInt32,
    version          String,
    expansion        UInt8,
    parse_time_ms    UInt32,
    winning_team_id  Int8,
    random_seed      Int64,
    start_spots      UInt8,
    observers        Array(String),
    speed            UInt8,
    fixed_teams      UInt8,
    teams_together   UInt8,
    full_shared_unit_control UInt8,
    always_visible   UInt8,
    map_explored     UInt8,
    referees         UInt8,
    observer_mode    LowCardinality(String),
    random_hero      UInt8,
    random_races     UInt8,
    hide_terrain     UInt8,
    ingested_at      DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY replay_id;

CREATE TABLE IF NOT EXISTS w3g.replay_players
(
    replay_id             String,
    player_id             UInt8,
    name                  String,
    color                 LowCardinality(String),
    team_id               Int8,
    race                  LowCardinality(String),
    race_detected         LowCardinality(String),
    apm                   UInt32,
    actions_rightclick    UInt32,
    actions_basic         UInt32,
    actions_buildtrain    UInt32,
    actions_ability       UInt32,
    actions_item          UInt32,
    actions_select        UInt32,
    actions_removeunit    UInt32,
    actions_subgroup      UInt32,
    actions_selecthotkey  UInt32,
    actions_assigngroup   UInt32,
    actions_esc           UInt32,
    apm_timed             Array(UInt32),
    ingested_at           DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (replay_id, player_id);

-- `seq` keeps the ORDER BY unique when two events share the same
-- (replay_id, player_id, time_ms, kind, object_code) — without it the RMT
-- collapses distinct events on merge.
--
-- race/matchup are denormalized in from the doc at extraction time (the
-- per-player race, the doc-level matchup) so the replay_events fan-out
-- (mv_events__order) can stamp the cohort without JOINing the header tables.
-- That removes the header-before-events ordering dependency and lets the whole
-- chain be a pure materialized-view cascade off replays_raw — see views.sql.
CREATE TABLE IF NOT EXISTS w3g.player_order_events
(
    replay_id    String,
    player_id    UInt8,
    -- 'unknown' = rawcodes outside the parser's melee mapping tables
    -- (custom-map objects, plus a few melee order classes upstream never
    -- tracked — see the tanghyd/w3grs fork pinned in pipeline/parse-rs/Cargo.toml).
    kind         Enum8('building'=1,'unit'=2,'item'=3,'upgrade'=4,'unknown'=5),
    object_code  LowCardinality(String),
    time_ms      UInt32,
    seq          UInt32,
    race         LowCardinality(String),
    matchup      LowCardinality(String),
    ingested_at  DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (replay_id, player_id, time_ms, kind, object_code, seq);

CREATE TABLE IF NOT EXISTS w3g.player_heroes
(
    replay_id    String,
    player_id    UInt8,
    hero_slot    UInt8,
    hero_id      LowCardinality(String),
    final_level  UInt8,
    ingested_at  DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (replay_id, player_id, hero_slot);

-- race/matchup denormalized from the doc (see player_order_events) so both the
-- hero-skill fan-out (mv_events__hero) and the synthetic hero_trained fan-out
-- can stamp the cohort without JOINing the header tables.
CREATE TABLE IF NOT EXISTS w3g.hero_ability_events
(
    replay_id    String,
    player_id    UInt8,
    hero_slot    UInt8,
    hero_id      LowCardinality(String),
    event_type   LowCardinality(String),
    ability_id   LowCardinality(String),
    time_ms      UInt32,
    seq          UInt32,
    race         LowCardinality(String),
    matchup      LowCardinality(String),
    ingested_at  DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (replay_id, player_id, hero_slot, time_ms, seq);

-- Two players talking at the same ms tick happens (~58 cases observed); seq
-- keeps them distinct.
CREATE TABLE IF NOT EXISTS w3g.chat
(
    replay_id    String,
    player_id    UInt8,
    player_name  String,
    mode         LowCardinality(String),
    message      String,
    time_ms      UInt32,
    seq          UInt32,
    ingested_at  DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (replay_id, time_ms, seq);

CREATE TABLE IF NOT EXISTS w3g.player_group_hotkeys
(
    replay_id    String,
    player_id    UInt8,
    group_key    UInt8,
    assigned     UInt32,
    used         UInt32,
    ingested_at  DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (replay_id, player_id, group_key);

CREATE TABLE IF NOT EXISTS w3g.resource_transfers
(
    replay_id       String,
    from_player_id  UInt8,
    to_player_id    UInt8,
    gold            Int32,
    lumber          Int32,
    time_ms         UInt32,
    seq             UInt32,
    ingested_at     DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (replay_id, time_ms, seq, from_player_id);

-- Denormalized event fact for sequenceMatch queries. Sort key matches the
-- dominant filter shape: (race, matchup) for the cohort, then
-- (replay_id, player_id, time_ms) for per-player ordered scan.
CREATE TABLE IF NOT EXISTS w3g.replay_events
(
    race          LowCardinality(String),
    matchup       LowCardinality(String),
    replay_id     String,
    player_id     UInt8,
    time_ms       UInt32,
    event_type    LowCardinality(String),
    subject_code  LowCardinality(String),
    subject_name  LowCardinality(String),  -- bounded by the mappings set
    detail        LowCardinality(String),
    seq           UInt32,
    ingested_at   DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (race, matchup, replay_id, player_id, time_ms, event_type, subject_code, seq);

-- WC3 canonical mappings (units/buildings/items/upgrades/heroes/abilities).
-- Source-agnostic WC3 reference data; populated by load_mappings.sql from
-- the parser's exported JSON.
CREATE TABLE IF NOT EXISTS w3g.mappings
(
    code                String,
    name                String,
    kind                LowCardinality(String),
    -- Reference facet only: per-event race comes from the replay doc.
    race                LowCardinality(String),
    hero                LowCardinality(String),
    -- Marks supply structures (Farm / Moon Well / Ziggurat base tier) so
    -- opener_rollup excludes them from build-order prefixes. Burrow (otrb) is
    -- deliberately not flagged: it fights.
    is_supply_building  UInt8 DEFAULT 0,
    -- Custom-map facet, set by the seed rows only: ui-menu / builder / tower /
    -- upgrade / item / other. Empty for melee kinds.
    category            LowCardinality(String) DEFAULT ''
)
ENGINE = MergeTree
ORDER BY code;

-- Opener trie rollup target. One row per (race, opponent_race, map, prefix)
-- where prefix is an ordered Array of non-supply building subject_codes
-- fanned out at every depth 1..N (N=6). Populated by
-- views.sql:refresh__opener_rollup.
CREATE TABLE IF NOT EXISTS w3g.opener_rollup
(
    race            LowCardinality(String),
    opponent_race   LowCardinality(String),
    map             String,
    depth           UInt8,
    prefix          Array(String),
    matches         UInt64,
    wins            UInt64,
    sum_duration_ms UInt64,
    sample_replays  Array(String)
)
ENGINE = MergeTree
ORDER BY (race, opponent_race, map, depth, prefix);
