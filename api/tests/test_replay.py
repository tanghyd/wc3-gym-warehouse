"""GET /replays/{id} against the API on the live stack (the loaded games): the forward flag."""

from fastapi.testclient import TestClient

from app import app

client = TestClient(app)


def test_replay_forward() -> None:
    """8aac280e (Springtime 1.4): 7 of the Random Orc's 9 Watch Towers stand under 3,000 from the
    Night Elf's empty start, so they are forward; the towers at 355 and 366 s are not. No other order is."""
    res = client.get("/replays/8aac280efe003e9ad65dd9747293dc6368672cfafac2096853040bb5ca8624d1")
    assert res.status_code == 200, res.text
    events = res.json()["events"]
    forward = [(e["player_id"], e["code"], e["time_ms"] // 1000) for e in events if e["forward"]]
    assert forward == [(1, "owtw", s) for s in (221, 222, 241, 285, 286, 316, 376)]
    other = [e["time_ms"] // 1000 for e in events if e["player_id"] == 1 and e["code"] == "owtw" and not e["forward"]]
    assert other == [355, 366]
