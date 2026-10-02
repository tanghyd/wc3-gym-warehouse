"""Request/response pairs in cases/*.json, run against the API on the live stack
(the 3 goldens loaded). Plain JSON on purpose: a Rust port of the API passes when
it answers the same. `just api-cases-update` rewrites the answers; review the diff."""

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import app

CASES = sorted(Path(__file__).parent.glob("cases/*.json"))
client = TestClient(app)


@pytest.mark.parametrize("path", CASES, ids=lambda p: p.stem)
def test_case(path: Path) -> None:
    case = json.loads(path.read_text())
    res = client.post(case["route"], json=case["request"]) if "request" in case else client.get(case["route"])
    body = res.json()
    for key in ("sql", "params", "request_id"):  # how it was asked, not what it answered
        body.pop(key, None)
    if not isinstance(body.get("detail", ""), str):  # FastAPI's own 422 shape: the status is the contract
        body.pop("detail")
    got = {"status": res.status_code, "body": body}
    if os.environ.get("UPDATE_CASES"):
        path.write_text(json.dumps(case | {"response": got}, indent=2, ensure_ascii=False) + "\n")
    else:
        assert got == case["response"]
