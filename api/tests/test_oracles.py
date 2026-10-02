"""Hand-labelled cases in oracles/*.json, run against the API on the live stack (the loaded
games). A search case names about 10 replays and the games its steps must match there, each with
the player shown on the Player side and the games marked both, and some also the shown players
who won, the wins, the losses and the scope; a /query case names a few replays and its rows. Each
is picked and labelled by the SQL beside it (oracles/<name>.sql) on the order and replay tables,
not through the compiler. No recipe rewrites them: a changed answer is a changed meaning."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import app

CASES = sorted(Path(__file__).parent.glob("oracles/*.json"))
client = TestClient(app)


@pytest.mark.parametrize("path", CASES, ids=lambda p: p.stem)
def test_oracle(path: Path) -> None:
    case = json.loads(path.read_text())
    route = case.get("route", "/search")
    res = client.post(route, json=case["request"])
    assert res.status_code == 200, res.text
    body = res.json()
    if route == "/query":
        assert body["rows"] == case["expected"]["rows"], case["operator"]
        return
    summary, rows = body["summary"], body["replays"]
    both = sorted(r["replay_id"] for r in rows if r["both"])
    assert summary["both"] == len(both)
    got = {
        "games": summary["games"],
        "matches": sorted([r["replay_id"], r["player"]["name"]] for r in rows),
        "both": both,
        "won": sorted(r["replay_id"] for r in rows if r["player"]["won"]),
        "wins": summary["wins"],
        "losses": summary["losses"],
        "scope": {k: body["scope"][k] for k in ("games", "wins", "losses")},
    }
    want = {"both": []} | case["expected"]
    assert {k: got[k] for k in want} == want, case["operator"]
