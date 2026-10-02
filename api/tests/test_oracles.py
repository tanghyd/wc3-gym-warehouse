"""Hand-labelled search cases in oracles/*.json, run against the API on the live stack (the
loaded games). Each case names about 10 replays and the player-games its steps must match there,
picked and labelled by the SQL beside it (oracles/<name>.sql) on the order tables, not through
the compiler. No recipe rewrites them: a changed answer is a changed meaning."""

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
    res = client.post("/search", json=case["request"])
    assert res.status_code == 200, res.text
    body = res.json()
    got = sorted([r["replay_id"], r["player"]["name"]] for r in body["replays"])
    assert {"games": body["summary"]["games"], "matches": got} == case["expected"], case["operator"]
