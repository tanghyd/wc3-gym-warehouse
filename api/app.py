"""The warehouse query API. The catalog of what a caller may ask for is the
`meta.semantic` block on dbt models (dbt/models/marts/marts.yml), read from dbt's
manifest; compile.py turns a request into parameterised ClickHouse SQL."""

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException

from compile import (
    REPLAY_SQL,
    ROWS_SQL,
    BadRequest,
    Model,
    QueryRequest,
    SearchRequest,
    array,
    compile_query,
    compile_search,
)

CH_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123")
CH_USER = os.environ.get("CLICKHOUSE_USER", "api")
CH_PASSWORD = os.environ.get("CLICKHOUSE_API_PASSWORD", "")
MANIFEST = Path(os.environ.get("DBT_MANIFEST", "/target/manifest.json"))

app = FastAPI(title="wc3-gym-warehouse")


def run(sql: str, params: dict[str, str] | None = None) -> list[dict[str, Any]]:
    query = urllib.parse.urlencode({f"param_{k}": v for k, v in (params or {}).items()})
    req = urllib.request.Request(
        f"{CH_URL}/?{query}",
        data=(sql + "\nFORMAT JSON").encode(),
        headers={"X-ClickHouse-User": CH_USER, "X-ClickHouse-Key": CH_PASSWORD},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return json.load(res)["data"]
    except urllib.error.HTTPError as e:
        raise HTTPException(502, e.read().decode().strip().splitlines()[0]) from e
    except urllib.error.URLError as e:
        raise HTTPException(503, f"ClickHouse unreachable: {e.reason}") from e


_catalog: tuple[float, dict[str, Model]] = (0.0, {})


def catalog() -> dict[str, Model]:
    """Semantic models from the manifest, reloaded when `dbt build` rewrites it."""
    global _catalog
    try:
        mtime = MANIFEST.stat().st_mtime
    except FileNotFoundError:
        raise HTTPException(503, "no dbt manifest yet: run `just dbt build`") from None
    if mtime == _catalog[0]:
        return _catalog[1]
    nodes = json.loads(MANIFEST.read_text())["nodes"].values()
    semantic = {
        n["name"]: (f"{n['schema']}.{n['alias']}", n["config"]["meta"]["semantic"])
        for n in nodes
        if n["resource_type"] == "model" and "semantic" in n["config"].get("meta", {})
    }
    types: dict[str, dict[str, str]] = {}
    for row in run("SELECT table, name, type FROM system.columns WHERE database = 'w3g'"):
        types.setdefault(f"w3g.{row['table']}", {})[row["name"]] = row["type"]
    models = {
        name: Model(
            table=table,
            dimensions={d: types.get(table, {}).get(d, "String") for d in sem["dimensions"]},
            measures=sem["measures"],
        )
        for name, (table, sem) in semantic.items()
    }
    _catalog = (mtime, models)
    return models


def model(name: str) -> Model:
    if (m := catalog().get(name)) is None:
        raise HTTPException(400, f"unknown model {name!r}")
    return m


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": run("SELECT 1 AS ok")[0]["ok"] == 1}


@app.get("/catalog")
def get_catalog() -> dict[str, Any]:
    return {
        name: {"dimensions": m.dimensions, "measures": list(m.measures), "steps": m.takes_steps}
        for name, m in catalog().items()
    }


@app.post("/query")
def query(req: QueryRequest) -> dict[str, Any]:
    try:
        sql, params = compile_query(req, model(req.model))
    except BadRequest as e:
        raise HTTPException(400, str(e)) from e
    return {"rows": run(sql, params), "sql": sql, "params": params}


def _won(team_id: int, winning_team_id: int) -> bool | None:
    return None if winning_team_id < 0 else team_id == winning_team_id


def _gnl(row: dict[str, Any]) -> dict[str, int] | None:
    return {"series_id": row["gnl_series_id"], "game_no": row["gnl_game_no"]} if row["gnl_series_id"] else None


@app.post("/search")
def search(req: SearchRequest) -> dict[str, Any]:
    try:
        sql, params = compile_search(req, model("player_games"))
    except BadRequest as e:
        raise HTTPException(400, str(e)) from e
    focus = {r["replay_id"]: r["focus_player_id"] for r in run(sql, params)}
    rows = []
    if focus:
        for r in run(ROWS_SQL, {"ids": array(focus)}):
            rows.append({
                "replay_id": r["replay_id"], "map": r["map"], "matchup": r["matchup"],
                "duration_ms": r["duration_ms"], "winning_team_id": r["winning_team_id"],
                "result_source": r["result_source"], "gnl": _gnl(r),
                "download_url": None,  # no public file host for source_key yet
                "focus_player_id": focus[r["replay_id"]],
                "players": [
                    {
                        "player_id": pid, "name": name, "race": race, "team_id": team, "won": _won(team, r["winning_team_id"]),
                        "heroes": [{"code": code, "final_level": level} for _slot, code, level in heroes],
                    }
                    for pid, name, race, team, heroes in r["players"]
                ],
            })
    return {"replays": rows, "sql": sql, "params": params}


@app.get("/replays/{replay_id}")
def replay(replay_id: str) -> dict[str, Any]:
    missing = HTTPException(404, "No game with this id")
    if not re.fullmatch(r"[0-9a-f]{64}", replay_id):
        raise missing
    p = {"id": replay_id}
    header = run(REPLAY_SQL["header"], p)
    if not header:
        raise missing
    h = header[0]
    players = [
        {
            "player_id": r["player_id"], "name": r["name"], "race": r["race"], "team_id": r["team_id"],
            "won": _won(r["team_id"], h["winning_team_id"]), "apm": r["apm"], "apm_per_minute": r["apm_per_minute"],
            "heroes": [{"slot": slot, "code": code, "final_level": level} for slot, code, level in r["heroes"]],
        }
        for r in run(REPLAY_SQL["players"], p)
    ]
    return {
        "replay_id": h["replay_id"], "map": h["map"], "matchup": h["matchup"], "duration_ms": h["duration_ms"],
        "winning_team_id": h["winning_team_id"], "result_source": h["result_source"], "version": h["version"],
        "patch": h["patch"], "gnl": _gnl(h), "download_url": None,
        "players": players,
        "events": run(REPLAY_SQL["events"], p),
        "chat": run(REPLAY_SQL["chat"], p),
    }
