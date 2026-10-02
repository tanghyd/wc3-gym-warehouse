"""Request models and the SQL compiler: catalog names and validated values in,
ClickHouse SQL plus query parameters out. No I/O here, so tests/test_compile.py
pins every shape without a server."""

from collections.abc import Iterable
from typing import Annotated, Literal

from pydantic import BaseModel, Field

EVENTS = "w3g.replay_events"
PLAYER_GAMES = "w3g.player_games"
# A building placement is forward when it lies under this many map units from the opponent's start location.
FORWARD_UNITS = 3000


def forward_condition(bound: str) -> str:
    """A placement (x, y) under `bound` from the opponent's start (opp_start_x, opp_start_y); NULL when either is unknown."""
    return f"sqrt(pow(x - opp_start_x, 2) + pow(y - opp_start_y, 2)) < {bound}"

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


class Model(BaseModel):
    """One semantic model from the dbt manifest, with ClickHouse column types."""

    table: str
    dimensions: dict[str, str]  # name -> ClickHouse type
    measures: dict[str, str]  # name -> aggregate expression
    # What a page shows: a label per offered dimension and measure, and per measure its type
    # (count, distinct, record, average), the summed measures it is made of, and a note.
    labels: dict[str, str] = {}
    types: dict[str, str] = {}
    parts: dict[str, list[str]] = {}
    notes: dict[str, str] = {}

    @property
    def takes_steps(self) -> bool:
        return {"replay_id", "player_id"} <= self.dimensions.keys()


class BadRequest(ValueError):
    pass


RANDOM_OF = {"HU": "RH", "OC": "RO", "NE": "RN", "UD": "RU"}


def race_value(race: str, random: int) -> str:
    """A played race and its random flag as one race value: (NE, 0) is NE, (NE, 1) is RN, and a
    Random player with no played race is R."""
    if race not in RANDOM_OF:
        return "R"
    return RANDOM_OF[race] if random else race


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


def tuples(values: Iterable[tuple[str | int, ...]]) -> str:
    """Tuples in ClickHouse's quoted text form, the value of an Array(Tuple(...)) parameter."""
    return "[" + ",".join("(" + ",".join(_literal(v) for v in t) + ")" for t in values) + "]"


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


# A race value: a picked race (HU, OC, NE, UD), a Random player's played race (RH, RO, RN,
# RU), or R for a Random player with no played race. NE is (race NE, random 0).
type RaceValue = Literal["HU", "OC", "NE", "UD", "RH", "RO", "RN", "RU", "R"]
type Races = Annotated[list[RaceValue], Field(max_length=9)]
BASE_OF = {v: r for r, v in RANDOM_OF.items()}


def race_pair(value: str) -> tuple[str, int]:
    """The played race and random flag of a race value: RN is (NE, 1), R is (RANDOM, 1)."""
    if value in BASE_OF:
        return BASE_OF[value], 1
    return (value, 0) if value in RANDOM_OF else ("RANDOM", 1)


def race_condition(values: list[str], params: Params, race: str = "race", random: str = "random") -> list[str]:
    """The player_games condition for race values: none for any race."""
    if not values:
        return []
    pairs = tuples(dict.fromkeys(map(race_pair, values)))
    return [f"has({params.add('Array(Tuple(String, UInt8))', pairs)}, ({race}, {random}))"]


# The player_games dimensions that scope a replay, not a player.
REPLAY_FILTERS = ("replay_id", "map", "patch", "minutes", "duration_ms")


def replay_filters(model: Model, filters: Filters, params: Params) -> list[str]:
    for name in filters:
        if name not in REPLAY_FILTERS:
            raise BadRequest(f"{name!r} is not a replay filter: use {', '.join(REPLAY_FILTERS)}")
    return where_filters(model, filters, params)


# The replay_events event types of each picker kind; hired names a unit order.
EVENT_TYPES = {
    "building": ["building"], "unit": ["unit"], "hired": ["unit"], "upgrade": ["upgrade"],
    "item": ["item"], "hero": ["hero_trained"], "skill": ["hero_skill"],
}


class ObjectsRequest(BaseModel):
    # The picker kind: Built, Trained, Hired, Researched, Hero, Learned skill, Bought.
    kind: Literal["building", "unit", "hired", "upgrade", "hero", "skill", "item"]
    # The side's race values; the picker lists their races' objects and the neutral ones.
    race: Races = []
    filters: Filters = {}


def compile_objects(req: ObjectsRequest, model: Model) -> tuple[str, dict[str, str]]:
    """The objects of a picker kind for a side's race, each with the games in scope (the race
    values and the replay filters) in which a player of the side ordered it at least once. A
    race's own sources come before the neutral ones (an altar before the Tavern), each most ordered first."""
    params = Params()
    scope = replay_filters(model, req.filters, params) + race_condition(req.race, params)
    races = sorted({race_pair(v)[0] for v in req.race})
    events = [f"has({params.add('Array(String)', array(EVENT_TYPES[req.kind]))}, event_type)"]
    if races:  # race leads replay_events' sort key
        events.append(f"has({params.add('Array(String)', array(races))}, race)")
    events.append(f"(replay_id, player_id) IN (SELECT replay_id, player_id FROM {PLAYER_GAMES}{' WHERE ' + ' AND '.join(scope) if scope else ''})")
    listed = [f"kind = {params.add('String', req.kind)}"]
    if played := [r for r in races if r in RANDOM_OF]:  # a race's objects and the neutral ones
        listed.append(f"has({params.add('Array(String)', array([*played, '']))}, race)")
    sql = f"""SELECT o.source_code AS source_code, o.source_name AS source_name, o.code AS code, o.name AS name, c.games AS games
FROM w3g.objects AS o
LEFT JOIN (
    SELECT subject_code, uniqExact(replay_id) AS games
    FROM {EVENTS}
    WHERE {' AND '.join(events)}
    GROUP BY subject_code
) AS c ON c.subject_code = o.code
WHERE {' AND '.join(listed)}
ORDER BY o.race = '', games DESC, name, code"""
    return sql, params.values


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
        "is_repeat = 0",
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
        if m in model.parts and m not in model.measures:
            raise BadRequest(f"{m} has no SQL of its own: ask for {' and '.join(model.parts[m])}")
        if m not in model.measures:
            raise BadRequest(f"unknown measure {m!r}")
    params = Params()
    select = req.dimensions + [f"{model.measures[m]} AS {m}" for m in req.measures]
    conds = _row_conditions(model, req.filters, req.steps, params)
    source = model.table + (" WHERE " + " AND ".join(conds) if conds else "")
    if req.measures and model.takes_steps:
        # shown is 1 on the lower player slot of each game in a result row, so a game whose two players fall in one row counts once there
        part = ", ".join([*req.dimensions, "replay_id"])
        source = f"(SELECT *, row_number() OVER (PARTITION BY {part} ORDER BY player_id) = 1 AS shown FROM {source})"
    sql = f"SELECT {'DISTINCT ' if not req.measures else ''}{', '.join(select)} FROM {source}"
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


type Code = Annotated[str, Field(pattern=r"^[A-Za-z0-9_]{1,8}$")]


class SearchStep(BaseModel):
    """One step of a side: at least `count` orders of any of `codes`, each inside the game time
    window; `exactly` makes the count exact. A skill step's count is a level: one point that takes
    the skill to level `count` or more, and with `exactly` the skill's highest level. A `then` step
    comes after the step above, all its orders within `within_s` of it when set. `nth` asks a hero
    step for the side's 1st, 2nd or 3rd hero. `before` keeps the orders before the order that
    completes step `before` of the group. `negate` turns an `and` step into "did not happen".
    `forward` keeps a building step's placements under FORWARD_UNITS from the opponent's start."""

    kind: Literal["building", "unit", "upgrade", "item", "hero", "skill"]
    codes: Annotated[list[Code], Field(min_length=1, max_length=40)]
    count: Annotated[int, Field(ge=1, le=9)] = 1
    exactly: bool = False
    from_s: Annotated[int, Field(ge=0, le=36000)] | None = None
    to_s: Annotated[int, Field(ge=0, le=36000)] | None = None
    link: Literal["and", "then"] = "and"
    within_s: Annotated[int, Field(ge=1, le=7200)] | None = None
    nth: Annotated[int, Field(ge=1, le=3)] | None = None
    before: Annotated[int, Field(ge=1, le=8)] | None = None
    negate: bool = False
    forward: bool = False


class Group(BaseModel):
    """Steps that must all hold. A side matches when any of its groups does."""

    steps: Annotated[list[SearchStep], Field(min_length=1, max_length=8)]


class Side(BaseModel):
    race: Races = []
    name: Annotated[str, Field(max_length=100)] | None = None
    # The first buildings in order, as the opener tree lists them: opener_1, opener_2, ...
    opened_with: Annotated[list[Code], Field(max_length=6)] = []
    groups: Annotated[list[Group], Field(max_length=4)] = []


class PlayerSide(Side):
    # The Player's result; the Opponent's is the reverse, so it has none.
    outcome: Literal["win", "loss"] | None = None


# The orders of a search's list: when the replay was added, its length or its map.
SORTS = {"added": "added_at", "duration": "duration_ms", "map": "map"}


class SearchRequest(BaseModel):
    filters: Filters = {}
    player: PlayerSide = PlayerSide()
    opponent: Side = Side()
    sort: Literal["added", "-added", "duration", "-duration", "map", "-map"] = "-added"
    limit: Annotated[int, Field(ge=1, le=100)] = 25
    offset: Annotated[int, Field(ge=0, le=100000)] = 0


# A time no order reaches: the end of a chain step when the step above has none.
NEVER_MS = 4294967295


def chains(group: Group) -> list[list[int]]:
    """A group split into chains of step indexes: an `and` step starts one, each `then` step joins
    the one above. A `before` step is in no chain: it bounds the step it names."""
    steps = group.steps
    out: list[list[int]] = []
    for i, s in enumerate(steps):
        below_then = i + 1 < len(steps) and steps[i + 1].link == "then"
        if s.link == "then" and i == 0:
            raise BadRequest("the first step of a group has no step above to come after")
        if s.within_s is not None and s.link != "then":
            raise BadRequest("within_s goes with link then")
        if s.nth is not None and s.kind != "hero":
            raise BadRequest("nth goes with kind hero")
        if s.forward and s.kind != "building":
            raise BadRequest("forward goes with kind building")
        if s.negate and s.exactly:
            raise BadRequest("a step that did not happen has no exact count")
        if s.negate and (s.link == "then" or below_then):
            raise BadRequest("a step that did not happen links to no other step")
        if s.before is not None:
            if s.link == "then" or below_then:
                raise BadRequest("a step before another step links to no other step")
            anchor = steps[s.before - 1] if s.before <= len(steps) else None
            if s.before == i + 1 or anchor is None or anchor.negate or anchor.before is not None:
                raise BadRequest("before names another step of the group, one that happened")
        elif s.link == "then":
            out[-1].append(i)
        else:
            out.append([i])
    return out


def _need(s: SearchStep) -> int:
    """The orders that complete a step: `count`, or for a skill step the one point that takes the skill to level `count`."""
    return 1 if s.kind == "skill" else s.count


def _event_condition(s: SearchStep, params: Params, level: int | None = None) -> str:
    """The rows of a step's orders. A skill step reads its points at level `count` or more, or at `level` or more when set."""
    parts = [
        f"has({params.add('Array(String)', array(EVENT_TYPES[s.kind]))}, event_type)",
        f"has({params.add('Array(String)', array(s.codes))}, subject_code)",
    ]
    if s.kind == "skill":
        parts.append(f"level >= {level or s.count}")
    if s.nth is not None:  # a hero_trained row's seq is the hero's place in player_games.heroes
        parts.append(f"seq = {s.nth}")
    if s.from_s is not None:
        parts.append(f"time_ms >= {s.from_s * 1000}")
    if s.to_s is not None:
        parts.append(f"time_ms <= {s.to_s * 1000}")
    if s.forward:  # opp_start_x and opp_start_y come from the player_games join of _chain_sql
        parts.append(forward_condition(params.add("Float64", str(FORWARD_UNITS))))
    return " AND ".join(parts)


def _before_condition(s: SearchStep, i: int) -> str:
    """The condition that step i, a `before` step, holds before `e`, the time the step it names is complete.
    An exact skill step holds when the skill is at level `count` and no higher (`x`, its points past it)."""
    n = f"arrayCount(y -> y < e, t{i})"
    if s.negate:
        return f"{n} = 0"
    if s.exactly and s.kind == "skill":
        return f"{n} >= 1 AND arrayCount(y -> y < e, x{i}) = 0"
    return f"{n} = {s.count}" if s.exactly else f"{n} >= {_need(s)}"


def _chain_sql(steps: list[SearchStep], chain: list[int], races: list[str], params: Params) -> str:
    """(replay_id, player_id) pairs whose orders hold the chain of step indexes: each step a block
    of `count` orders after the order that completes the step above, all within `within_s` of it
    when set, and each `before` step that names a chain step true before that step completes."""
    bounds = {k: [b for b, s in enumerate(steps) if s.before == k + 1] for k in chain}
    used = chain + [b for k in chain for b in bounds[k]]
    events = EVENTS
    if any(steps[i].forward for i in used):  # each order row gets its player_games row's opponent start
        events += f" INNER JOIN (SELECT replay_id, player_id, opp_start_x, opp_start_y FROM {PLAYER_GAMES}) AS g USING (replay_id, player_id)"
    where = [f"has({params.add('Array(String)', array(races))}, race)"] if races else []  # race leads the sort key
    first = steps[chain[0]]
    if len(chain) == 1 and not bounds[chain[0]]:  # one block of orders: a count
        sql = f"SELECT replay_id, player_id FROM {events} WHERE {' AND '.join([*where, _event_condition(first, params), 'is_repeat = 0'])} GROUP BY replay_id, player_id"
        if first.exactly:  # a skill step names the highest level, any other step the number of orders
            return sql + (f" HAVING max(level) = {first.count}" if first.kind == "skill" else f" HAVING count() = {first.count}")
        return sql + (f" HAVING count() >= {first.count}" if _need(first) > 1 else "")
    where += [
        f"has({params.add('Array(String)', array(sorted({t for i in used for t in EVENT_TYPES[steps[i].kind]})))}, event_type)",
        f"has({params.add('Array(String)', array(sorted({c for i in used for c in steps[i].codes})))}, subject_code)",
        "is_repeat = 0",
    ]
    # Per player: t, the sorted times of each step's orders, and x, those of an exact skill step's
    # points past its level. f, the times at which each chain step can be complete: a block of
    # `count` orders (one point for a skill step) after the earliest f above, or after any f above
    # and within `within_s` of it, where c counts this step's orders up to each f above.
    cols = [f"arraySort(groupArrayIf(time_ms, {_event_condition(steps[i], params)})) AS t{i}" for i in used]
    cols += [f"groupArrayIf(time_ms, {_event_condition(steps[i], params, steps[i].count + 1)}) AS x{i}" for i in used if steps[i].exactly and steps[i].kind == "skill"]
    holds = []
    above = None
    for k in chain:
        s = steps[k]
        if above is None:
            ends = f"arraySlice(t{k}, {_need(s)})"
        elif s.within_s is None:
            ends = f"arraySlice(arrayFilter(x -> x > if(empty(f{above}), {NEVER_MS}, f{above}[1]), t{k}), {_need(s)})"
        else:
            cols.append(f"arrayMap(e -> arrayCount(y -> y <= e, t{k}), f{above}) AS c{k}")
            ends = (
                f"arrayFilter((x, i) -> arrayExists((e, c) -> x > e AND x <= e + {s.within_s * 1000} AND i >= c + {_need(s)},"
                f" f{above}, c{k}), t{k}, arrayEnumerate(t{k}))"
            )
        if bounds[k]:
            ends = f"arrayFilter(e -> {' AND '.join(_before_condition(steps[b], b) for b in bounds[k])}, {ends})"
        cols.append(f"{ends} AS f{k}")
        if s.exactly:
            holds.append(f"empty(x{k})" if s.kind == "skill" else f"length(t{k}) <= {s.count}")
        above = k
    holds.append(f"notEmpty(f{above})")
    return (
        f"SELECT replay_id, player_id FROM (SELECT replay_id, player_id, {', '.join(cols)}"
        f" FROM {events} WHERE {' AND '.join(where)} GROUP BY replay_id, player_id) WHERE {' AND '.join(holds)}"
    )


def _group_condition(group: Group, races: list[str], params: Params) -> str:
    """The condition a player_games row of the side's player meets when the group holds."""
    parts = []
    for chain in chains(group):
        s = group.steps[chain[0]]
        bounded = any(t.before == chain[0] + 1 for t in group.steps)
        if len(chain) == 1 and not bounded and s.nth and s.from_s is None and s.to_s is None and s.count == 1 and not s.exactly:
            condition = f"has({params.add('Array(String)', array(s.codes))}, heroes[{s.nth}])"  # "1st hero X" alone reads the heroes array, no orders
        else:
            condition = f"(replay_id, player_id) IN ({_chain_sql(group.steps, chain, races, params)})"
        parts.append(f"NOT ({condition})" if s.negate else condition)
    return " AND ".join(parts)


def _own_conditions(side: Side, params: Params) -> list[str]:
    """A side's opener and step conditions on its own player_games row."""
    out = [f"opener_{i} = {params.add('String', c)}" for i, c in enumerate(side.opened_with, start=1)]
    if side.groups:
        races = sorted({race_pair(v)[0] for v in side.race})
        out.append("(" + " OR ".join(f"({_group_condition(g, races, params)})" for g in side.groups) + ")")
    return out


def _side_terms(side: Side) -> tuple[object, ...]:
    """What a side asks of its player, for comparing two sides."""
    return sorted(side.race), side.name or None, side.opened_with, [g.model_dump() for g in side.groups]


def records(req: SearchRequest) -> tuple[bool, bool]:
    """Whether the matches and the scope have a record: only when something tells the Player side
    from the Opponent side. The scope's sides differ by race values or name; the matches' also by
    openers, steps or the outcome. With equal sides a game's two seatings both fit, so a record says nothing."""
    p, o = _side_terms(req.player), _side_terms(req.opponent)
    return req.player.outcome is not None or p != o, p[:2] != o[:2]


def compile_search(req: SearchRequest, model: Model) -> tuple[str, str, dict[str, str]]:
    """Two statements over player_games, one result row per game.

    A player_games row seats one player of a game on the Player side and the other on the Opponent
    side. `scope` holds the replay filters, both sides' races and names. `match` adds the Player's
    outcome, openers and steps, and the Opponent's openers and steps through his own row
    (opponent_id). A game matches when one of its two rows does; when both do it is still one game,
    shown from its lower player slot and marked `both_sides`. The stats statement counts the scope
    and the matches in one pass; the rows statement lists one page of the matches."""
    params = Params()
    scope = replay_filters(model, req.filters, params)
    scope += race_condition(req.player.race, params)
    scope += race_condition(req.opponent.race, params, "opponent_race", "opponent_random")
    if req.player.name:
        scope.append(f"player = {params.add('String', req.player.name)}")
    if req.opponent.name:
        scope.append(f"opponent = {params.add('String', req.opponent.name)}")
    match = [f"result = {params.add('String', req.player.outcome)}"] if req.player.outcome else []
    match += _own_conditions(req.player, params)
    if opponent := _own_conditions(req.opponent, params):
        match.append(f"(replay_id, opponent_id) IN (SELECT replay_id, player_id FROM {PLAYER_GAMES} WHERE {' AND '.join(opponent)})")

    where = f" WHERE {' AND '.join(scope)}" if scope else ""
    m = " AND ".join(match) or "1"
    # per game: its seatings in scope (seated) and the matching ones (hits), each result read from the lower player slot
    stats = f"""SELECT
    countIf(hits > 0) AS games, countIf(hits > 0 AND hit_result = 'win') AS wins, countIf(hits > 0 AND hit_result = 'loss') AS losses,
    sumIf(game_ms, hits > 0) AS duration_ms_total, countIf(hits = 2) AS both_sides,
    count() AS scope_games, countIf(seated_result = 'win') AS scope_wins, countIf(seated_result = 'loss') AS scope_losses,
    sum(game_ms) AS scope_duration_ms_total
FROM (
    SELECT replay_id, any(duration_ms) AS game_ms, argMin(result, player_id) AS seated_result,
           countIf(m) AS hits, argMinIf(result, player_id, m) AS hit_result
    FROM (SELECT replay_id, player_id, result, duration_ms, {m} AS m FROM {PLAYER_GAMES}{where})
    GROUP BY replay_id
)"""
    column = SORTS[req.sort.removeprefix("-")]
    rows = f"""SELECT replay_id, player_id, opponent_id, map, duration_ms, player, race, random, result, heroes, hero_levels, both_sides
FROM (
    SELECT replay_id, player_id, opponent_id, map, duration_ms, added_at, player, race, random, result, heroes, hero_levels,
           count() OVER (PARTITION BY replay_id) = 2 AS both_sides, row_number() OVER (PARTITION BY replay_id ORDER BY player_id) AS seat
    FROM {PLAYER_GAMES}
    WHERE {' AND '.join([*scope, *match]) or '1'}
)
WHERE seat = 1
ORDER BY {column}{' DESC' if req.sort.startswith('-') else ''}, replay_id
LIMIT {req.limit} OFFSET {req.offset}"""
    return stats, rows, params.values


# The opponent row of each listed game.
OPPONENTS_SQL = """SELECT replay_id, player_id, player, race, random, result, heroes, hero_levels
FROM w3g.player_games
WHERE has({pairs:Array(Tuple(String, UInt8))}, (replay_id, player_id))"""


# One replay for the replay page (api.md 3.8). Every read is keyed by replay_id.
REPLAY_SQL = {
    "header": """SELECT replay_id, map, matchup, duration_ms, winning_team_id, version, patch
FROM w3g.replays WHERE replay_id = {id:String}""",
    "players": """SELECT p.player_id AS player_id, p.name AS name, p.race AS race, p.random AS random, p.team_id AS team_id,
       p.apm AS apm, p.apm_timed AS apm_per_minute, h.heroes AS heroes
FROM (SELECT * FROM w3g.replay_players WHERE replay_id = {id:String}) AS p
LEFT JOIN (
    SELECT player_id, arraySort(groupArray((hero_slot, hero_id, final_level))) AS heroes
    FROM w3g.player_heroes WHERE replay_id = {id:String}
    GROUP BY player_id
) AS h ON h.player_id = p.player_id
ORDER BY p.player_id""",
    # The timeline: orders (custom-map `unknown` codes and repeat clicks left out), skill
    # points under their hero (repeat clicks left out), retrains, and each hero at the order
    # that trained it, as replay_events times it. seq 0 sorts hero_trained before a skill at the same ms.
    # level is the skill level a skill point gives, 0 on every other row. forward is 1 on a building
    # placement a forward step keeps, read as the search reads it (player_games.opp_start_x, _y), else 0.
    "events": """SELECT player_id, time_ms, event_type, code, hero_code, level, forward FROM (
    SELECT player_id, time_ms, kind AS event_type, object_code AS code, CAST(NULL, 'Nullable(String)') AS hero_code, toUInt8(0) AS level, seq,
           toUInt8(ifNull(""" + forward_condition("{forward_units:Float64}") + """, 0)) AS forward
    FROM w3g.player_order_events
    LEFT JOIN (SELECT player_id, opp_start_x, opp_start_y FROM w3g.player_games WHERE replay_id = {id:String}) AS g USING (player_id)
    WHERE replay_id = {id:String} AND kind != 'unknown' AND is_repeat = 0
    UNION ALL
    SELECT player_id, time_ms, if(event_type = 'retraining', 'hero_retrained', 'hero_skill'),
           if(event_type = 'retraining', hero_id, ability_id), hero_id, level, seq, 0
    FROM w3g.hero_ability_events WHERE replay_id = {id:String} AND is_repeat = 0
    UNION ALL
    SELECT player_id, trained_ms, 'hero_trained', hero_id, NULL, 0, 0, 0
    FROM w3g.player_heroes WHERE replay_id = {id:String}
)
ORDER BY time_ms, player_id, seq""",
    # The page is public, so private chat stays out.
    "chat": """SELECT time_ms, player_id, mode, message FROM w3g.chat
WHERE replay_id = {id:String} AND mode = 'All' ORDER BY time_ms, seq""",
}


class Preset(BaseModel):
    """A named side of the search, from api/strategies.yaml. A variant holds its parent's steps, then its own."""

    id: Annotated[str, Field(pattern=r"^[a-z0-9-]{1,80}$")]
    name: str
    race: Literal["HU", "OC", "NE", "UD"]
    parent_id: str | None = None
    source: str
    vs_races: list[Literal["HU", "OC", "NE", "UD"]] = []
    steps: Annotated[list[SearchStep], Field(min_length=1, max_length=8)]


def preset_steps(p: Preset, presets: dict[str, Preset]) -> list[SearchStep]:
    """A preset's whole group: its parent's steps, then its own."""
    return [*(presets[p.parent_id].steps if p.parent_id else []), *p.steps]


def check_presets(presets: list[Preset]) -> dict[str, Preset]:
    """The presets by id, after the checks a search makes: unique ids, a parent of the same race
    with no parent of its own, and every whole group a valid one."""
    by_id: dict[str, Preset] = {}
    for p in presets:
        if p.id in by_id:
            raise BadRequest(f"preset {p.id} is listed twice")
        by_id[p.id] = p
    for p in presets:
        parent = by_id.get(p.parent_id) if p.parent_id else None
        if p.parent_id and (parent is None or parent.race != p.race or parent.parent_id):
            raise BadRequest(f"preset {p.id}: parent {p.parent_id} is not a top preset of race {p.race}")
        chains(Group(steps=preset_steps(p, by_id)))
    return by_id


class StrategiesRequest(BaseModel):
    # The Player's race values: one race, or a race with its Random value. Its presets are counted.
    race: Annotated[Races, Field(min_length=1)]
    opponent_race: Races = []
    filters: Filters = {}


def compile_strategies(req: StrategiesRequest, presets: dict[str, Preset], model: Model) -> tuple[str, list[str], dict[str, str]]:
    """One statement over the games in scope with a player of the race: games, wins, losses and
    length, for the scope and for each preset of the race. A preset's condition is its whole group,
    as a Player side of POST /search reads it, and a game counts once with its result read as the
    search reads it, so a preset's figures are the search's summary."""
    races = sorted({race_pair(v)[0] for v in req.race})
    if len(races) != 1 or races[0] not in RANDOM_OF:
        raise BadRequest("race takes one race: HU, OC, NE or UD, alone or with its Random value")
    params = Params()
    scope = replay_filters(model, req.filters, params)
    scope += race_condition(req.race, params)
    scope += race_condition(req.opponent_race, params, "opponent_race", "opponent_random")
    ids = [i for i, p in presets.items() if p.race == races[0]]
    conds = [f"({_group_condition(Group(steps=preset_steps(presets[i], presets)), races, params)}) AS s{n}" for n, i in enumerate(ids)]
    # per game: whether a seating holds each preset (gN) and its result from the lower such player slot (rN)
    games = ["any(duration_ms) AS game_ms", "argMin(result, player_id) AS seated_result"]
    figures = ["count() AS games", "countIf(seated_result = 'win') AS wins", "countIf(seated_result = 'loss') AS losses", "sum(game_ms) AS duration_ms_total"]
    for n in range(len(ids)):
        games += [f"max(s{n}) AS g{n}", f"argMinIf(result, player_id, s{n}) AS r{n}"]
        figures += [
            f"countIf(g{n}) AS s{n}_games", f"countIf(g{n} AND r{n} = 'win') AS s{n}_wins",
            f"countIf(g{n} AND r{n} = 'loss') AS s{n}_losses", f"sumIf(game_ms, g{n}) AS s{n}_duration_ms_total",
        ]
    inner = ", ".join(["replay_id", "player_id", "result", "duration_ms", *conds])
    rows = ",\n    ".join(figures)
    sql = (
        f"SELECT\n    {rows}\nFROM (\n    SELECT {', '.join(games)}\n"
        f"    FROM (SELECT {inner} FROM {PLAYER_GAMES} WHERE {' AND '.join(scope)})\n    GROUP BY replay_id\n)"
    )
    return sql, ids, params.values
