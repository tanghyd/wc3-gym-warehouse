"""The compiler's SQL for fixed requests, no server needed."""

import pytest

import re
from pathlib import Path

import yaml

from compile import (
    BadRequest,
    Model,
    ObjectsRequest,
    Preset,
    QueryRequest,
    SearchRequest,
    StrategiesRequest,
    Step,
    check_presets,
    compile_objects,
    compile_query,
    SearchStep,
    compile_search,
    compile_strategies,
    race_pair,
    sequence_pattern,
)

PG = Model(
    table="w3g.player_games",
    dimensions={"replay_id": "String", "player_id": "UInt8", "race": "LowCardinality(String)", "map": "String",
                "minutes": "Float64", "player": "String", "apm": "UInt32"},
    measures={"games": "count()", "wins": "countIf(result = 'win')"},
)
MAPPINGS = Model(table="w3g.mappings", dimensions={"code": "String"}, measures={})


def step(code: str, **kw: float) -> Step:
    return Step(type="building", code=code, **kw)


def test_pattern_bounds_only_the_gap_it_names() -> None:
    assert sequence_pattern([step("a")]) == "(?1)"
    assert sequence_pattern([step("a"), step("b"), step("c", within_prev_s=21.3)]) == "(?1).*(?2)(?t<=21300)(?3)"


def test_query_groups_filters_and_matches_steps() -> None:
    req = QueryRequest(dimensions=["race"], measures=["games", "wins"],
                       filters={"map": ["Springtime"], "minutes": {"gte": 5}, "apm": [435]},
                       steps=[step("eaom"), step("edob", within_prev_s=30, to_min=4)])
    sql, params = compile_query(req, PG)
    assert sql == (
        "SELECT race, count() AS games, countIf(result = 'win') AS wins"
        " FROM (SELECT *, row_number() OVER (PARTITION BY race, replay_id ORDER BY player_id) = 1 AS shown FROM w3g.player_games"
        " WHERE has({p0:Array(String)}, map) AND minutes >= {p1:Float64} AND has({p2:Array(UInt32)}, apm)"
        " AND (replay_id, player_id) IN (SELECT replay_id, player_id FROM w3g.replay_events"
        " WHERE has({p3:Array(String)}, event_type) AND has({p4:Array(String)}, subject_code) AND is_repeat = 0"
        " GROUP BY replay_id, player_id HAVING sequenceMatch('(?1)(?t<=30000)(?2)')(time_ms,"
        " event_type = {p5:String} AND subject_code = {p6:String},"
        " event_type = {p7:String} AND subject_code = {p8:String} AND time_ms <= 240000)))"
        " GROUP BY race ORDER BY games DESC LIMIT 100"
    )
    assert params == {"p0": "['Springtime']", "p1": "5.0", "p2": "[435]", "p3": "['building']",
                      "p4": "['eaom','edob']", "p5": "building", "p6": "eaom", "p7": "building", "p8": "edob"}


def test_a_race_filter_also_narrows_the_event_scan() -> None:
    sql, params = compile_query(QueryRequest(measures=["games"], filters={"race": ["NE"]}, steps=[step("eaom")]), PG)
    assert "FROM w3g.replay_events WHERE has({p1:Array(String)}, race) AND has(" in sql
    assert params["p0"] == params["p1"] == "['NE']"


def test_one_step_is_a_plain_condition() -> None:
    sql, _ = compile_query(QueryRequest(measures=["games"], steps=[step("hbar", from_min=2)]), PG)
    assert "sequenceMatch" not in sql and "time_ms >= 120000" in sql


def test_dimensions_without_measures_are_distinct() -> None:
    sql, _ = compile_query(QueryRequest(model="mappings", dimensions=["code"]), MAPPINGS)
    assert sql == "SELECT DISTINCT code FROM w3g.mappings ORDER BY code LIMIT 100"


@pytest.mark.parametrize("req, model", [
    (QueryRequest(dimensions=["nope"]), PG),
    (QueryRequest(measures=["nope"]), PG),
    (QueryRequest(filters={"nope": ["x"]}, measures=["games"]), PG),
    (QueryRequest(dimensions=["race"], order_by=["map"]), PG),
    (QueryRequest(), PG),
    (QueryRequest(model="mappings", dimensions=["code"], steps=[step("a")]), MAPPINGS),
])
def test_names_outside_the_catalog_are_refused(req: QueryRequest, model: Model) -> None:
    with pytest.raises(BadRequest):
        compile_query(req, model)


def test_codes_are_validated_at_the_boundary() -> None:
    with pytest.raises(ValueError):
        Step(type="building", code="x' OR 1=1")


def test_race_values_name_a_played_race_and_the_random_flag() -> None:
    assert [race_pair(v) for v in ["NE", "RN", "R"]] == [("NE", 0), ("NE", 1), ("RANDOM", 1)]


def test_objects_count_the_side_race_and_list_its_and_neutral_objects() -> None:
    req = ObjectsRequest(kind="hired", race=["NE", "RN"], filters={"map": ["Echo Isles"]})
    sql, params = compile_objects(req, PG)
    assert "FROM w3g.player_games WHERE has({p0:Array(String)}, map) AND has({p1:Array(Tuple(String, UInt8))}, (race, random))" in sql
    assert params["p1"] == "[('NE',0),('NE',1)]"
    assert params["p2"] == "['unit']"  # a mercenary is a unit order
    assert "WHERE kind = {p4:String} AND has({p5:Array(String)}, race)" in sql
    assert params["p5"] == "['NE','']"


def test_objects_take_replay_filters_only() -> None:
    with pytest.raises(BadRequest):
        compile_objects(ObjectsRequest(kind="unit", filters={"player": ["a"]}), PG)


def ss(kind: str, *codes: str, **kw: object) -> dict[str, object]:
    return {"kind": kind, "codes": list(codes), **kw}


def test_every_step_reads_orders_that_are_not_repeat_clicks() -> None:
    groups = [{"steps": [ss("building", "etoa", count=2)]},
              {"steps": [ss("hero", "Edem"), ss("skill", "AEmb", link="then"), ss("building", "edob", negate=True, before=1)]}]
    _, rows, _ = compile_search(SearchRequest(player={"groups": groups}), PG)
    assert rows.count("FROM w3g.replay_events WHERE") == rows.count("is_repeat = 0") == 2


def test_an_nth_hero_step_with_a_window_times_that_hero() -> None:
    _, rows, _ = compile_search(SearchRequest(player={"groups": [{"steps": [ss("hero", "Nngs", "Npbm", nth=1, from_s=480)]}]}), PG)
    assert "heroes[" not in rows and "seq = 1 AND time_ms >= 480000" in rows


def test_a_forward_step_counts_placements_near_the_opponent_start() -> None:
    groups = [{"steps": [ss("building", "hwtw", count=3, to_s=240), ss("building", "hwtw", count=2, to_s=240, forward=True)]}]
    _, rows, params = compile_search(SearchRequest(player={"race": ["HU"], "groups": groups}), PG)
    join = "FROM w3g.replay_events INNER JOIN (SELECT replay_id, player_id, opp_start_x, opp_start_y FROM w3g.player_games) AS g USING (replay_id, player_id) WHERE"
    # only the forward step's chain joins the opponent's start, and its count reads forward placements alone
    assert rows.count(join) == 1 and rows.count("FROM w3g.replay_events WHERE") == 1
    bound = next(k for k, v in params.items() if v == "3000")
    assert f"time_ms <= 240000 AND sqrt(pow(x - opp_start_x, 2) + pow(y - opp_start_y, 2)) < {{{bound}:Float64}} AND is_repeat = 0 GROUP BY replay_id, player_id HAVING count() >= 2" in rows


def test_search_counts_the_scope_and_matches_any_group() -> None:
    req = SearchRequest(
        filters={"map": ["Echo Isles"]},
        player={
            "race": ["NE", "RN"], "outcome": "win",
            "groups": [
                {"steps": [ss("hero", "Edem", nth=1), ss("unit", "earc", count=5, to_s=360)]},
                {"steps": [ss("building", "etol", to_s=540, negate=True)]},
            ],
        },
        opponent={"race": ["OC"], "groups": [{"steps": [ss("hero", "Obla", nth=1)]}]},
        sort="duration", offset=25,
    )
    stats, rows, params = compile_search(req, PG)
    scope = "has({p0:Array(String)}, map) AND has({p1:Array(Tuple(String, UInt8))}, (race, random)) AND has({p2:Array(Tuple(String, UInt8))}, (opponent_race, opponent_random))"
    assert f"FROM w3g.player_games WHERE {scope})" in stats
    # one result per game: a game matches when one of its two seatings does, and counts once
    assert "GROUP BY replay_id" in stats and "countIf(hits > 0) AS games" in stats and "countIf(hits = 2) AS both_sides" in stats
    # a result counts only from a game that fits one way: in one that fits both ways either player can sit on the Player side
    assert "countIf(hits = 1 AND hit_result = 'win') AS wins" in stats and "anyIf(result, m) AS hit_result" in stats
    assert "countIf(seated = 1 AND seated_result = 'loss') AS scope_losses" in stats and "countIf(seated = 2) AS scope_both_sides" in stats
    assert "WHERE seat = 1" in rows and "count() OVER (PARTITION BY replay_id) = 2 AS both_sides" in rows
    assert params["p1"] == "[('NE',0),('NE',1)]" and params["p2"] == "[('OC',0)]"
    # group 1: a 1st hero alone reads the heroes array; Archer x5 by 6:00 counts orders
    assert "(has({p4:Array(String)}, heroes[1]) AND (replay_id, player_id) IN (SELECT replay_id, player_id FROM w3g.replay_events WHERE has({p5:Array(String)}, race) AND has({p6:Array(String)}, event_type) AND has({p7:Array(String)}, subject_code) AND time_ms <= 360000 AND is_repeat = 0 GROUP BY replay_id, player_id HAVING count() >= 5))" in rows
    # group 2: no Tree of Life by 9:00; the groups are alternatives
    assert ") OR (NOT ((replay_id, player_id) IN (SELECT replay_id, player_id FROM w3g.replay_events WHERE " in rows
    # the opponent's steps hold on his own row
    assert "(replay_id, opponent_id) IN (SELECT replay_id, player_id FROM w3g.player_games WHERE ((has({p" in rows
    assert rows.endswith("ORDER BY duration_ms, replay_id\nLIMIT 25 OFFSET 25")
    assert params["p3"] == "win"


@pytest.mark.parametrize("steps", [
    [ss("unit", "earc", link="then")],  # nothing above to follow
    [ss("unit", "earc", within_s=30)],  # within needs then
    [ss("unit", "earc", nth=1)],  # nth needs a hero
    [ss("unit", "earc", negate=True), ss("unit", "esen", link="then")],  # a step that did not happen has no then
    [ss("unit", "earc", negate=True, exactly=True)],  # nor an exact count
    [ss("unit", "earc", before=1)],  # before names another step
    [ss("unit", "earc"), ss("unit", "esen", before=3)],  # of the group
    [ss("unit", "earc", negate=True), ss("unit", "esen", before=1)],  # that happened
    [ss("unit", "earc"), ss("unit", "esen", before=1), ss("unit", "edry", link="then")],  # and links to no other step
    [ss("unit", "earc", forward=True)],  # forward needs a building
])
def test_step_links_that_mean_nothing_are_refused(steps: list[dict[str, object]]) -> None:
    with pytest.raises(BadRequest):
        compile_search(SearchRequest(player={"groups": [{"steps": steps}]}), PG)


def test_a_measure_with_parts_and_no_sql_names_its_parts() -> None:
    model = PG.model_copy(update={"parts": {"record": ["wins", "losses"]}})
    with pytest.raises(BadRequest, match="ask for wins and losses"):
        compile_query(QueryRequest(measures=["record"]), model)


PRESETS = check_presets([Preset(**p) for p in yaml.safe_load((Path(__file__).parent.parent / "strategies.yaml").read_text())])


def test_the_presets_file_holds_the_three_sources() -> None:
    sources = [p.source for p in PRESETS.values()]
    assert (sources.count("w3warehouse"), sources.count("gym-replays"), sources.count("wc3-gnl-website")) == (24, 16, 32)
    # a variant holds its parent's steps, then its own
    late = PRESETS["ud-cl-necro-mw-late"]
    assert late.parent_id == "ud-cl-necro-mw" and len(PRESETS[late.parent_id].steps) == 3


def test_strategy_stats_count_each_preset_of_the_race_in_one_statement() -> None:
    req = StrategiesRequest(race=["UD", "RU"], opponent_race=["NE"], filters={"minutes": {"gte": 2}})
    sql, ids, params = compile_strategies(req, PRESETS, PG)
    assert ids == [i for i, p in PRESETS.items() if p.race == "UD"]
    assert sql.count("countIf(g") == 4 * len(ids) and sql.count("sumIf(game_ms, g") == len(ids)
    # per game: the seatings that hold a preset, and a result only from a game where one seating holds it
    assert len(re.findall(r"countIf\(s\d+\) AS g\d+", sql)) == len(ids) and sql.count("anyIf(result, s") == len(ids) and "GROUP BY replay_id" in sql
    assert sql.count(" = 1 AND r") == 2 * len(ids) and "countIf(seated = 1 AND seated_result = 'win') AS wins" in sql
    assert "FROM w3g.player_games WHERE minutes >= {p0:Float64} AND has({p1:Array(Tuple(String, UInt8))}, (race, random))" in sql
    assert params["p1"] == "[('UD',0),('UD',1)]" and params["p2"] == "[('NE',0)]"
    # the late expo: the Crypt Lord first of its parent, an expansion 8:00 to 15:00 and none by 8:00
    inner = sql.split("FROM (SELECT ", 1)[1]
    late = re.split(rf"\) AS s{ids.index('ud-cl-necro-mw-late')}\b", inner)[0].rsplit(") AS s", 1)[-1]
    assert "heroes[1]" in late and "time_ms >= 480000 AND time_ms <= 900000" in late and "NOT (" in late


@pytest.mark.parametrize("race", [["R"], ["HU", "OC"]])
def test_strategy_stats_take_one_race(race: list[str]) -> None:
    with pytest.raises(BadRequest):
        compile_strategies(StrategiesRequest(race=race), PRESETS, PG)


def test_a_preset_with_an_unknown_parent_is_refused() -> None:
    p = Preset(id="x", name="X", race="HU", parent_id="nope", source="test", steps=[SearchStep(kind="hero", codes=["Hamg"])])
    with pytest.raises(BadRequest):
        check_presets([p])
