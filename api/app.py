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

import yaml
from fastapi import FastAPI, HTTPException

from compile import (
    FORWARD_UNITS,
    OPPONENTS_SQL,
    REPLAY_SQL,
    BadRequest,
    Model,
    ObjectsRequest,
    Preset,
    QueryRequest,
    SearchRequest,
    StrategiesRequest,
    check_presets,
    compile_objects,
    compile_query,
    compile_search,
    compile_strategies,
    race_value,
    tuples,
)

CH_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123")
CH_USER = os.environ.get("CLICKHOUSE_USER", "api")
CH_PASSWORD = os.environ.get("CLICKHOUSE_API_PASSWORD", "")
MANIFEST = Path(os.environ.get("DBT_MANIFEST", "/target/manifest.json"))
# The strategy presets, checked once at start: a bad file stops the API.
PRESETS = check_presets([Preset(**p) for p in yaml.safe_load((Path(__file__).parent / "strategies.yaml").read_text())])

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
    models = {}
    for name, (table, sem) in semantic.items():
        # a measure is its SQL, or a map with sql, label, type, parts and note
        info = {m: v if isinstance(v, dict) else {"sql": v} for m, v in sem["measures"].items()}
        models[name] = Model(
            table=table,
            dimensions={d: types.get(table, {}).get(d, "String") for d in sem["dimensions"]},
            measures={m: v["sql"] for m, v in info.items() if "sql" in v},
            labels=sem.get("labels", {}) | {m: v["label"] for m, v in info.items() if "label" in v},
            types={m: v["type"] for m, v in info.items() if "type" in v},
            parts={m: v["parts"] for m, v in info.items() if "parts" in v},
            notes={m: v["note"] for m, v in info.items() if "note" in v},
        )
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
        name: {
            "dimensions": m.dimensions, "measures": list(m.measures), "steps": m.takes_steps,
            "labels": m.labels, "types": m.types, "parts": m.parts, "notes": m.notes,
        }
        for name, m in catalog().items()
    }


@app.post("/query")
def query(req: QueryRequest) -> dict[str, Any]:
    try:
        sql, params = compile_query(req, model(req.model))
    except BadRequest as e:
        raise HTTPException(400, str(e)) from e
    return {"rows": run(sql, params), "sql": sql, "params": params}


@app.post("/objects")
def objects(req: ObjectsRequest) -> dict[str, Any]:
    """A step picker's groups: each source with its objects, most ordered first."""
    try:
        sql, params = compile_objects(req, model("player_games"))
    except BadRequest as e:
        raise HTTPException(400, str(e)) from e
    groups: dict[str, dict[str, Any]] = {}
    for r in run(sql, params):
        group = groups.setdefault(r["source_code"], {"source": {"code": r["source_code"], "name": r["source_name"]}, "objects": []})
        group["objects"].append({"code": r["code"], "name": r["name"], "games": r["games"]})
    return {"groups": list(groups.values()), "sql": sql, "params": params}


def _won(team_id: int, winning_team_id: int) -> bool | None:
    return None if winning_team_id < 0 else team_id == winning_team_id


def _tally(s: dict[str, Any], prefix: str) -> dict[str, Any]:
    """Games, summed length and the games that fit both ways. Wins and losses count the games that
    fit one way only, and are null when there is none: every game fits both ways."""
    record = s[f"{prefix}games"] > s[f"{prefix}both_sides"]
    return {
        "games": s[f"{prefix}games"], "wins": s[f"{prefix}wins"] if record else None,
        "losses": s[f"{prefix}losses"] if record else None, "duration_ms_total": s[f"{prefix}duration_ms_total"],
        "both": s[f"{prefix}both_sides"],
    }


def _side(r: dict[str, Any]) -> dict[str, Any]:
    """One player of a listed game: name, race value, result and heroes in pick order."""
    return {
        "name": r["player"], "race": race_value(r["race"], r["random"]),
        "won": None if r["result"] == "unknown" else r["result"] == "win",
        "heroes": [{"code": c, "level": lv} for c, lv in zip(r["heroes"], r["hero_levels"], strict=True)],
    }


@app.post("/search")
def search(req: SearchRequest) -> dict[str, Any]:
    """Games that fit both sides: the summary and the scope counted in one statement, one page of
    the list in another, and each listed game's opponent row."""
    try:
        stats_sql, rows_sql, params = compile_search(req, model("player_games"))
    except BadRequest as e:
        raise HTTPException(400, str(e)) from e
    s = run(stats_sql, params)[0]
    rows = run(rows_sql, params)
    pairs = tuples((r["replay_id"], r["opponent_id"]) for r in rows)
    opponents = {(o["replay_id"], o["player_id"]): o for o in run(OPPONENTS_SQL, {"pairs": pairs})} if rows else {}
    return {
        "total": s["games"],
        # both: games either player can sit on the Player side of; they add no win or loss
        "summary": _tally(s, ""),
        "scope": _tally(s, "scope_"),
        "replays": [
            {
                "replay_id": r["replay_id"], "map": r["map"], "duration_ms": r["duration_ms"], "both": bool(r["both_sides"]),
                "player": _side(r), "opponent": _side(opponents[(r["replay_id"], r["opponent_id"])]),
            }
            for r in rows
        ],
        "sql": f"{stats_sql};\n\n{rows_sql}",
        "params": params,
    }


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
            "player_id": r["player_id"], "name": r["name"], "race": race_value(r["race"], r["random"]), "team_id": r["team_id"],
            "won": _won(r["team_id"], h["winning_team_id"]), "apm": r["apm"], "apm_per_minute": r["apm_per_minute"],
            "heroes": [{"slot": slot, "code": code, "final_level": level} for slot, code, level in r["heroes"]],
        }
        for r in run(REPLAY_SQL["players"], p)
    ]
    return {
        "replay_id": h["replay_id"], "map": h["map"], "matchup": h["matchup"], "duration_ms": h["duration_ms"],
        "winning_team_id": h["winning_team_id"], "version": h["version"],
        "patch": h["patch"], "download_url": None,
        "players": players,
        "events": run(REPLAY_SQL["events"], {**p, "forward_units": str(FORWARD_UNITS)}),
        "chat": run(REPLAY_SQL["chat"], p),
    }


@app.get("/strategies")
def strategies() -> dict[str, Any]:
    """The presets of api/strategies.yaml, each with its own steps; a variant also holds its parent's."""
    keys = {"id", "name", "race", "parent_id", "source", "vs_races"}
    return {"strategies": [p.model_dump(include=keys) | {"steps": [s.model_dump(exclude_defaults=True) for s in p.steps]} for p in PRESETS.values()]}


@app.post("/strategies/stats")
def strategy_stats(req: StrategiesRequest) -> dict[str, Any]:
    """Games, wins, losses, summed length and the games that fit both ways, of the games in scope
    with a player of the race and of each of its presets, in one statement."""
    try:
        sql, ids, params = compile_strategies(req, PRESETS, model("player_games"))
    except BadRequest as e:
        raise HTTPException(400, str(e)) from e
    s = run(sql, params)[0]
    return {
        "scope": _tally(s, ""),
        "strategies": [{"id": i} | _tally(s, f"s{n}_") for n, i in enumerate(ids)],
        "sql": sql,
        "params": params,
    }
