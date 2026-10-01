"""The compiler's SQL for fixed requests, no server needed."""

import pytest

from compile import BadRequest, Model, QueryRequest, SearchRequest, Step, compile_query, compile_search, sequence_pattern

PG = Model(
    table="w3g.player_games",
    dimensions={"replay_id": "String", "player_id": "UInt8", "race": "LowCardinality(String)", "map": "String",
                "minutes": "Float64", "player": "String", "gnl_series_id": "UInt32"},
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
                       filters={"map": ["Springtime"], "minutes": {"gte": 5}, "gnl_series_id": [435]},
                       steps=[step("eaom"), step("edob", within_prev_s=30, to_min=4)])
    sql, params = compile_query(req, PG)
    assert sql == (
        "SELECT race, count() AS games, countIf(result = 'win') AS wins FROM w3g.player_games"
        " WHERE has({p0:Array(String)}, map) AND minutes >= {p1:Float64} AND has({p2:Array(UInt32)}, gnl_series_id)"
        " AND (replay_id, player_id) IN (SELECT replay_id, player_id FROM w3g.replay_events"
        " WHERE has({p3:Array(String)}, event_type) AND has({p4:Array(String)}, subject_code)"
        " GROUP BY replay_id, player_id HAVING sequenceMatch('(?1)(?t<=30000)(?2)')(time_ms,"
        " event_type = {p5:String} AND subject_code = {p6:String},"
        " event_type = {p7:String} AND subject_code = {p8:String} AND time_ms <= 240000))"
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


def test_search_matches_each_other_player_as_the_focus_opponent() -> None:
    req = SearchRequest(filters={"race": ["N"]}, others=[{"filters": {"player": ["a'b"]}}], limit=5)
    sql, params = compile_search(req, PG)
    assert sql == (
        "SELECT replay_id, min(player_id) AS focus_player_id FROM w3g.player_games"
        " WHERE has({p0:Array(String)}, race)"
        " AND (replay_id, player) IN (SELECT replay_id, opponent FROM w3g.player_games WHERE has({p1:Array(String)}, player))"
        " GROUP BY replay_id ORDER BY replay_id LIMIT 5"
    )
    assert params["p1"] == "['a\\'b']"


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
