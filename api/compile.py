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
    """The objects of a picker kind for a side's race, each with the player-games in scope (the
    race values and the replay filters) that ordered it at least once. A race's own sources
    come before the neutral ones (an altar before the Tavern), each most ordered first."""
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
    SELECT subject_code, uniqExact(replay_id, player_id) AS games
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


type Code = Annotated[str, Field(pattern=r"^[A-Za-z0-9_]{1,8}$")]


class SearchStep(BaseModel):
    """One step of a side: at least `count` orders of any of `codes`, each inside the game time
    window. A `then` step comes after the step above, within `within_s` when set. `nth` asks a
    hero step for the side's 1st, 2nd or 3rd hero. `negate` turns an `and` step into "did not
    happen"."""

    kind: Literal["building", "unit", "upgrade", "item", "hero", "skill"]
    codes: Annotated[list[Code], Field(min_length=1, max_length=40)]
    count: Annotated[int, Field(ge=1, le=9)] = 1
    from_s: Annotated[int, Field(ge=0, le=36000)] | None = None
    to_s: Annotated[int, Field(ge=0, le=36000)] | None = None
    link: Literal["and", "then"] = "and"
    within_s: Annotated[int, Field(ge=1, le=7200)] | None = None
    nth: Annotated[int, Field(ge=1, le=3)] | None = None
    negate: bool = False


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


# sequenceMatch takes at most 32 conditions; a chain's pattern stays under that many orders.
MAX_CHAIN_ORDERS = 32


def chains(group: Group) -> list[list[SearchStep]]:
    """A group split into chains: an `and` step starts one, each `then` step joins the one above."""
    out: list[list[SearchStep]] = []
    for i, s in enumerate(group.steps):
        if s.link == "then" and i == 0:
            raise BadRequest("the first step of a group has no step above to come after")
        if s.within_s is not None and s.link != "then":
            raise BadRequest("within_s goes with link then")
        if s.nth is not None and s.kind != "hero":
            raise BadRequest("nth goes with kind hero")
        if s.negate and (s.link == "then" or (i + 1 < len(group.steps) and group.steps[i + 1].link == "then")):
            raise BadRequest("a step that did not happen links to no other step")
        if s.link == "then":
            out[-1].append(s)
        else:
            out.append([s])
    for chain in out:
        if len(chain) > 1 and sum(s.count for s in chain) > MAX_CHAIN_ORDERS:
            raise BadRequest(f"a then chain counts at most {MAX_CHAIN_ORDERS} orders")
    return out


def chain_pattern(chain: list[SearchStep]) -> str:
    """sequenceMatch's pattern: each step's condition once per counted order, joined by `.*`
    (any gap), and `(?t<=ms)` before a step that must follow the one above within that time.
    A repeated condition matches another order each time."""
    pattern = ""
    for i, s in enumerate(chain, start=1):
        if i > 1:
            pattern += ".*" if s.within_s is None else f"(?t<={s.within_s * 1000})"
        pattern += ".*".join([f"(?{i})"] * s.count)
    return pattern


def _event_condition(s: SearchStep, params: Params) -> str:
    parts = [
        f"has({params.add('Array(String)', array(EVENT_TYPES[s.kind]))}, event_type)",
        f"has({params.add('Array(String)', array(s.codes))}, subject_code)",
    ]
    if s.from_s is not None:
        parts.append(f"time_ms >= {s.from_s * 1000}")
    if s.to_s is not None:
        parts.append(f"time_ms <= {s.to_s * 1000}")
    return " AND ".join(parts)


def _chain_sql(chain: list[SearchStep], races: list[str], params: Params) -> str:
    """(replay_id, player_id) pairs whose orders hold the chain: one step `count` times, or the
    steps in order."""
    where = [f"has({params.add('Array(String)', array(races))}, race)"] if races else []  # race leads the sort key
    if len(chain) == 1:
        s = chain[0]
        sql = f"SELECT replay_id, player_id FROM {EVENTS} WHERE {' AND '.join([*where, _event_condition(s, params)])} GROUP BY replay_id, player_id"
        return sql + (f" HAVING count() >= {s.count}" if s.count > 1 else "")
    where += [
        f"has({params.add('Array(String)', array(sorted({t for s in chain for t in EVENT_TYPES[s.kind]})))}, event_type)",
        f"has({params.add('Array(String)', array(sorted({c for s in chain for c in s.codes})))}, subject_code)",
    ]
    conditions = ", ".join(_event_condition(s, params) for s in chain)
    return (
        f"SELECT replay_id, player_id FROM {EVENTS} WHERE {' AND '.join(where)} GROUP BY replay_id, player_id"
        f" HAVING sequenceMatch('{chain_pattern(chain)}')(time_ms, {conditions})"
    )


def _group_condition(group: Group, races: list[str], params: Params) -> str:
    """The condition a player_games row of the side's player meets when the group holds."""
    parts = []
    for chain in chains(group):
        s = chain[0]
        heroes = [f"has({params.add('Array(String)', array(h.codes))}, heroes[{h.nth}])" for h in chain if h.nth]
        if len(chain) == 1 and s.nth and s.from_s is None and s.to_s is None and s.count == 1:
            condition = heroes[0]  # "1st hero X" alone reads the heroes array, no orders
        else:
            condition = " AND ".join([*heroes, f"(replay_id, player_id) IN ({_chain_sql(chain, races, params)})"])
        parts.append(f"NOT ({condition})" if s.negate else condition)
    return " AND ".join(parts)


def _own_conditions(side: Side, params: Params) -> list[str]:
    """A side's opener and step conditions on its own player_games row."""
    out = [f"opener_{i} = {params.add('String', c)}" for i, c in enumerate(side.opened_with, start=1)]
    if side.groups:
        races = sorted({race_pair(v)[0] for v in side.race})
        out.append("(" + " OR ".join(f"({_group_condition(g, races, params)})" for g in side.groups) + ")")
    return out


def compile_search(req: SearchRequest, model: Model) -> tuple[str, str, dict[str, str]]:
    """Two statements over player_games, one row per player-game of the Player side.

    `scope` holds the replay filters, both sides' races and names. `match` adds the Player's
    outcome, openers and steps, and the Opponent's openers and steps through his own row
    (opponent_id). The stats statement counts the scope and the matches in one pass; the rows
    statement lists one page of the matches."""
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
    stats = f"""SELECT
    countIf(m) AS games, countIf(m AND result = 'win') AS wins, countIf(m AND result = 'loss') AS losses,
    sumIf(duration_ms, m) AS duration_ms_total, uniqExactIf(replay_id, m) AS replays,
    count() AS scope_games, countIf(result = 'win') AS scope_wins, countIf(result = 'loss') AS scope_losses,
    sum(duration_ms) AS scope_duration_ms_total
FROM (SELECT replay_id, result, duration_ms, {m} AS m FROM {PLAYER_GAMES}{where})"""
    column = SORTS[req.sort.removeprefix("-")]
    rows = f"""SELECT replay_id, player_id, opponent_id, map, duration_ms, player, race, random, result, heroes, hero_levels
FROM {PLAYER_GAMES}
WHERE {' AND '.join([*scope, *match]) or '1'}
ORDER BY {column}{' DESC' if req.sort.startswith('-') else ''}, replay_id, player_id
LIMIT {req.limit} OFFSET {req.offset}"""
    return stats, rows, params.values


# The opponent row of each listed player-game.
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
