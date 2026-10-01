"""Request models and the SQL compiler: catalog names and validated values in,
ClickHouse SQL plus query parameters out. No I/O here, so tests/test_compile.py
pins every shape without a server."""

from collections.abc import Iterable
from typing import Annotated, Literal

from pydantic import BaseModel, Field

EVENTS = "w3g.replay_events"
PLAYER_GAMES = "w3g.player_games"

# The replay_events.event_type values a build-order step can name.
type StepType = Literal["building", "unit", "item", "upgrade", "unknown", "hero_trained", "hero_skill"]


class Step(BaseModel):
    type: StepType
    code: Annotated[str, Field(pattern=r"^[A-Za-z0-9_]{1,8}$")]
    # Most seconds after the previous step; none leaves the gap open.
    within_prev_s: Annotated[float, Field(ge=0, le=7200)] | None = None
    # A window in game minutes the step itself must fall in.
    from_min: Annotated[float, Field(ge=0, le=600)] | None = None
    to_min: Annotated[float, Field(ge=0, le=600)] | None = None


class Range(BaseModel):
    gte: float | None = None
    lte: float | None = None


# A filter is either the values a dimension may take or a numeric range.
type Filter = Annotated[list[str | int | float], Field(min_length=1, max_length=500)] | Range
type Filters = dict[str, Filter]
type Steps = Annotated[list[Step], Field(max_length=10)]


class QueryRequest(BaseModel):
    model: str = "player_games"
    dimensions: list[str] = []
    measures: list[str] = []
    filters: Filters = {}
    steps: Steps = []
    # Dimension or measure names; a leading "-" sorts that one descending.
    order_by: list[str] = []
    limit: Annotated[int, Field(ge=1, le=10000)] = 100


class Player(BaseModel):
    filters: Filters = {}
    steps: Steps = []


class SearchRequest(BaseModel):
    # The focus player: the row whose result the answer reports.
    filters: Filters = {}
    steps: Steps = []
    # Other players who must be in the same replay.
    others: Annotated[list[Player], Field(max_length=3)] = []
    limit: Annotated[int, Field(ge=1, le=1000)] = 100


class Model(BaseModel):
    """One semantic model from the dbt manifest, with ClickHouse column types."""

    table: str
    dimensions: dict[str, str]  # name -> ClickHouse type
    measures: dict[str, str]  # name -> aggregate expression

    @property
    def takes_steps(self) -> bool:
        return {"replay_id", "player_id"} <= self.dimensions.keys()


class BadRequest(ValueError):
    pass


class Params:
    """Collects query parameters, so no request value is ever spliced into SQL."""

    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    def add(self, ch_type: str, value: str) -> str:
        name = f"p{len(self.values)}"
        self.values[name] = value
        return f"{{{name}:{ch_type}}}"


def _literal(value: str | int | float) -> str:
    if isinstance(value, str):
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"
    return repr(value)


def array(values: Iterable[str | int | float]) -> str:
    """Values in ClickHouse's quoted text form, the value of an Array parameter."""
    return "[" + ",".join(_literal(v) for v in values) + "]"


def _base_type(ch_type: str) -> str:
    return ch_type[len("LowCardinality(") : -1] if ch_type.startswith("LowCardinality(") else ch_type


def where_filters(model: Model, filters: Filters, params: Params) -> list[str]:
    out = []
    for name, f in filters.items():
        if name not in model.dimensions:
            raise BadRequest(f"unknown dimension {name!r}")
        if isinstance(f, Range):
            if f.gte is not None:
                out.append(f"{name} >= {params.add('Float64', repr(f.gte))}")
            if f.lte is not None:
                out.append(f"{name} <= {params.add('Float64', repr(f.lte))}")
        else:
            ch_type = f"Array({_base_type(model.dimensions[name])})"
            out.append(f"has({params.add(ch_type, array(f))}, {name})")
    return out


def _step_condition(s: Step, params: Params) -> str:
    parts = [f"event_type = {params.add('String', s.type)}", f"subject_code = {params.add('String', s.code)}"]
    if s.from_min is not None:
        parts.append(f"time_ms >= {round(s.from_min * 60000)}")
    if s.to_min is not None:
        parts.append(f"time_ms <= {round(s.to_min * 60000)}")
    return " AND ".join(parts)


def sequence_pattern(steps: list[Step]) -> str:
    """sequenceMatch's pattern: `(?1)` then each later step, joined by `.*` (any
    gap) or `(?t<=ms)` (at most that gap). Never `(?t<=N).*`: the `.*` lets the
    matcher pick another pair and the bound stops biting."""
    pattern = "(?1)"
    for i, s in enumerate(steps[1:], start=2):
        link = ".*" if s.within_prev_s is None else f"(?t<={round(s.within_prev_s * 1000)})"
        pattern += f"{link}(?{i})"
    return pattern


def sequence_sql(steps: list[Step], params: Params, races: list[str | int | float] | None = None) -> str:
    """(replay_id, player_id) pairs whose events contain the steps in order."""
    types = array(dict.fromkeys(s.type for s in steps))
    codes = array(dict.fromkeys(s.code for s in steps))
    # Narrow the scan to the objects the steps name before grouping. Race leads
    # replay_events' sort key, so a race filter joins the index condition too.
    where = [f"has({params.add('Array(String)', array(races))}, race)"] if races else []
    where += [
        f"has({params.add('Array(String)', types)}, event_type)",
        f"has({params.add('Array(String)', codes)}, subject_code)",
    ]
    if len(steps) == 1:  # one step needs no ordering: its condition is the whole test
        where.append(_step_condition(steps[0], params))
    sql = f"SELECT replay_id, player_id FROM {EVENTS} WHERE {' AND '.join(where)} GROUP BY replay_id, player_id"
    if len(steps) > 1:
        conds = ", ".join(_step_condition(s, params) for s in steps)
        sql += f" HAVING sequenceMatch('{sequence_pattern(steps)}')(time_ms, {conds})"
    return sql


def _row_conditions(model: Model, filters: Filters, steps: list[Step], params: Params) -> list[str]:
    conds = where_filters(model, filters, params)
    if steps:
        if not model.takes_steps:
            raise BadRequest(f"model {model.table} has no replay_id and player_id to match steps on")
        races = filters.get("race")
        conds.append(f"(replay_id, player_id) IN ({sequence_sql(steps, params, races if isinstance(races, list) else None)})")
    return conds


def compile_query(req: QueryRequest, model: Model) -> tuple[str, dict[str, str]]:
    if not req.dimensions and not req.measures:
        raise BadRequest("ask for at least one dimension or measure")
    for d in req.dimensions:
        if d not in model.dimensions:
            raise BadRequest(f"unknown dimension {d!r}")
    for m in req.measures:
        if m not in model.measures:
            raise BadRequest(f"unknown measure {m!r}")
    params = Params()
    select = req.dimensions + [f"{model.measures[m]} AS {m}" for m in req.measures]
    sql = f"SELECT {'DISTINCT ' if not req.measures else ''}{', '.join(select)} FROM {model.table}"
    if conds := _row_conditions(model, req.filters, req.steps, params):
        sql += " WHERE " + " AND ".join(conds)
    if req.measures and req.dimensions:
        sql += " GROUP BY " + ", ".join(req.dimensions)
    order = []
    for o in req.order_by or ([f"-{req.measures[0]}"] if req.measures else req.dimensions):
        name = o.removeprefix("-")
        if name not in req.dimensions and name not in req.measures:
            raise BadRequest(f"order_by {name!r} is not a requested dimension or measure")
        order.append(f"{name} DESC" if o.startswith("-") else name)
    sql += f" ORDER BY {', '.join(order)} LIMIT {req.limit}"
    return sql, params.values


def compile_search(req: SearchRequest, model: Model) -> tuple[str, dict[str, str]]:
    """Replay ids that hold a focus player matching filters+steps, plus every
    `others` player. Answers the focus player's id with each replay."""
    params = Params()
    conds = _row_conditions(model, req.filters, req.steps, params)
    for other in req.others:
        inner = _row_conditions(model, other.filters, other.steps, params)
        where = f" WHERE {' AND '.join(inner)}" if inner else ""
        conds.append(f"replay_id IN (SELECT replay_id FROM {model.table}{where})")
    sql = f"SELECT replay_id, min(player_id) AS focus_player_id FROM {model.table}"
    if conds:
        sql += " WHERE " + " AND ".join(conds)
    sql += f" GROUP BY replay_id ORDER BY replay_id LIMIT {req.limit}"
    return sql, params.values


# The replays a search matched, as the shared replay row (docs/design/api.md 2.5).
ROWS_SQL = """SELECT
    r.replay_id AS replay_id, r.map AS map, r.matchup AS matchup, r.duration_ms AS duration_ms,
    r.winning_team_id AS winning_team_id, r.gnl_series_id AS gnl_series_id, r.gnl_game_no AS gnl_game_no,
    arraySort(groupArray((rp.player_id, rp.name, rp.race, rp.team_id))) AS players
FROM w3g.replays AS r
INNER JOIN w3g.replay_players AS rp ON rp.replay_id = r.replay_id
WHERE has({ids:Array(String)}, r.replay_id)
GROUP BY replay_id, map, matchup, duration_ms, winning_team_id, gnl_series_id, gnl_game_no
ORDER BY gnl_series_id, gnl_game_no, replay_id"""

# One replay for the replay page (api.md 3.8). Every read is keyed by replay_id.
REPLAY_SQL = {
    "header": """SELECT replay_id, map, matchup, duration_ms, winning_team_id, version, gnl_series_id, gnl_game_no
FROM w3g.replays WHERE replay_id = {id:String}""",
    "players": """SELECT p.player_id AS player_id, p.name AS name, p.race AS race, p.team_id AS team_id,
       p.apm AS apm, p.apm_timed AS apm_per_minute, h.heroes AS heroes
FROM (SELECT * FROM w3g.replay_players WHERE replay_id = {id:String}) AS p
LEFT JOIN (
    SELECT player_id, arraySort(groupArray((hero_slot, hero_id, final_level))) AS heroes
    FROM w3g.player_heroes WHERE replay_id = {id:String}
    GROUP BY player_id
) AS h ON h.player_id = p.player_id
ORDER BY p.player_id""",
    # The timeline: orders (custom-map `unknown` codes and repeat clicks left out), skill
    # points under their hero, retrains, and each hero's first skill point as its arrival.
    # seq 0 sorts hero_trained before the first skill at the same ms.
    "events": """SELECT player_id, time_ms, event_type, code, hero_code FROM (
    SELECT player_id, time_ms, kind AS event_type, object_code AS code, CAST(NULL, 'Nullable(String)') AS hero_code, seq
    FROM w3g.player_order_events WHERE replay_id = {id:String} AND kind != 'unknown' AND is_repeat = 0
    UNION ALL
    SELECT player_id, time_ms, if(event_type = 'retraining', 'hero_retrained', 'hero_skill'),
           if(event_type = 'retraining', hero_id, ability_id), hero_id, seq
    FROM w3g.hero_ability_events WHERE replay_id = {id:String}
    UNION ALL
    SELECT player_id, min(time_ms), 'hero_trained', hero_id, NULL, 0
    FROM w3g.hero_ability_events WHERE replay_id = {id:String}
    GROUP BY player_id, hero_id
)
ORDER BY time_ms, player_id, seq""",
    # The page is public, so private chat stays out.
    "chat": """SELECT time_ms, player_id, mode, message FROM w3g.chat
WHERE replay_id = {id:String} AND mode = 'All' ORDER BY time_ms, seq""",
}
