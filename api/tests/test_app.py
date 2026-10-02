"""The app layer without a server: ClickHouse is a fake transport, so the error map, the
request id, the input caps, the query budget and the readiness route are pinned here."""

from threading import BoundedSemaphore
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

import app as api
from compile import Model

PG = Model(
    table="w3g.player_games",
    dimensions={"race": "LowCardinality(String)", "minutes": "Float64", "player": "String", "added_at": "DateTime",
                "replay_id": "String", "player_id": "UInt8"},
    measures={"games": "count()"},
)
client = TestClient(api.app)


@pytest.fixture
def ch(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """ClickHouse as a handler the test sets, and a fixed catalog so no system.columns read runs."""
    state: dict[str, Any] = {"calls": [], "answer": lambda req: httpx.Response(200, json={"data": [{"ok": 1}]})}

    def handler(request: httpx.Request) -> httpx.Response:
        state["calls"].append(request)
        return state["answer"](request)

    monkeypatch.setattr(api, "_http", httpx.Client(base_url="http://ch", transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(api, "catalog", lambda: {"player_games": PG})
    return state


def test_a_query_carries_the_request_id_to_clickhouse(ch: dict[str, Any]) -> None:
    ch["answer"] = lambda req: httpx.Response(200, json={"data": [{"race": "HU"}]}, headers={"X-ClickHouse-Summary": '{"read_rows":"7"}'})
    res = client.post("/query", json={"dimensions": ["race"]}, headers={"X-Request-Id": "abc-1"})
    assert res.status_code == 200
    assert res.json()["rows"] == [{"race": "HU"}]
    assert res.headers["X-Request-Id"] == "abc-1"
    sent = ch["calls"][0]
    assert sent.url.params["query_id"] == "abc-1-1"
    assert sent.headers["user-agent"] == "warehouse-api /query"


@pytest.mark.parametrize("code,status", [(241, 503), (202, 503), (159, 504), (160, 504), (158, 400), (396, 400), (53, 400), (1000, 502)])
def test_a_clickhouse_error_code_picks_the_status(ch: dict[str, Any], code: int, status: int) -> None:
    ch["answer"] = lambda req: httpx.Response(500, text=f"Code: {code}. DB::Exception: boom (version 26.8.2)", headers={"X-ClickHouse-Exception-Code": str(code)})
    res = client.post("/query", json={"dimensions": ["race"]})
    assert res.status_code == status
    body = res.json()
    assert "version" not in body["detail"] and "boom" not in body["detail"]  # the server's text stays in the log
    assert body["request_id"] == res.headers["X-Request-Id"]
    if status == 503:
        assert res.headers["Retry-After"] == "1"


def test_a_timeout_is_504_and_a_dead_server_is_503(ch: dict[str, Any]) -> None:
    def slow(req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=req)

    def dead(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=req)

    ch["answer"] = slow
    assert client.post("/query", json={"dimensions": ["race"]}).status_code == 504
    ch["answer"] = dead
    assert client.post("/query", json={"dimensions": ["race"]}).status_code == 503


def test_a_failure_after_the_first_rows_is_not_a_partial_answer(ch: dict[str, Any]) -> None:
    ch["answer"] = lambda req: httpx.Response(200, json={"data": [{"race": "HU"}], "exception": "Code: 241. DB::Exception: memory"})
    assert client.post("/query", json={"dimensions": ["race"]}).status_code == 502


def test_oversized_or_mistyped_input_is_refused_before_clickhouse(ch: dict[str, Any]) -> None:
    assert client.post("/query", json={"dimensions": ["race"] * 21}).status_code == 422
    assert client.post("/query", json={"dimensions": ["race"], "filters": {"player": ["x" * 101]}}).status_code == 422
    assert client.post("/query", json={"dimensions": ["race"], "filters": {f"d{i}": ["x"] for i in range(21)}}).status_code == 422
    res = client.post("/query", json={"dimensions": ["race"], "filters": {"race": {"gte": 1}}})
    assert res.status_code == 400 and "range" in res.json()["detail"]
    res = client.post("/query", json={"dimensions": ["race"], "filters": {"minutes": ["ten"]}})
    assert res.status_code == 400 and "numbers" in res.json()["detail"]
    res = client.post("/query", json={"dimensions": ["race"], "filters": {"race": [1]}})
    assert res.status_code == 400 and "text" in res.json()["detail"]
    assert ch["calls"] == []  # nothing reached ClickHouse
    # a time dimension takes a range and text values
    assert client.post("/query", json={"dimensions": ["race"], "filters": {"added_at": {"gte": 1700000000}}}).status_code == 200
    assert client.post("/query", json={"dimensions": ["race"], "filters": {"added_at": ["2026-01-01 00:00:00"]}}).status_code == 200


def test_a_full_query_budget_answers_busy(ch: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    taken = BoundedSemaphore(1)
    taken.acquire()
    monkeypatch.setattr(api, "_slots", taken)
    res = client.post("/query", json={"dimensions": ["race"]})
    assert res.status_code == 503 and res.headers["Retry-After"] == "1"


def test_health_needs_nothing_and_ready_needs_clickhouse_and_the_catalog(ch: dict[str, Any]) -> None:
    def dead(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=req)

    ch["answer"] = dead
    assert client.get("/health").json() == {"ok": True}
    assert client.get("/ready").status_code == 503
    ch["answer"] = lambda req: httpx.Response(200, json={"data": [{"ok": 1}]})
    assert client.get("/ready").json() == {"ok": True, "models": 1}


def test_an_unhandled_error_is_a_500_with_a_request_id(ch: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    def broken() -> dict[str, Model]:
        raise RuntimeError("manifest half written")

    monkeypatch.setattr(api, "catalog", broken)
    res = client.post("/query", json={"dimensions": ["race"]})
    assert res.status_code == 500
    assert res.json() == {"detail": "internal error", "request_id": res.headers["X-Request-Id"]}


def test_a_page_past_the_last_game_runs_one_query(ch: dict[str, Any]) -> None:
    ch["answer"] = lambda req: httpx.Response(200, json={"data": [{
        "games": 0, "wins": 0, "losses": 0, "duration_ms_total": 0, "both_sides": 0,
        "scope_games": 0, "scope_wins": 0, "scope_losses": 0, "scope_duration_ms_total": 0, "scope_both_sides": 0,
    }]})
    res = client.post("/search", json={"player": {"race": ["HU"]}, "opponent": {}})
    assert res.status_code == 200, res.text
    assert res.json()["replays"] == []
    assert len(ch["calls"]) == 1
