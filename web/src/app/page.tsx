import Link from "next/link";
import { type Filters, getObjects, getPresets, type Objects, pickerValues, raceCounts, searchGames, type SidePlayer, stepGroups } from "@/lib/api";
import { parseRaces, raceLabel } from "@/lib/races";
import { apiStep, decodeGroups, HALLS, type Groups, played, type Step, stepObject } from "@/lib/steps";
import { presetSteps, urlStep } from "@/lib/strategies";
import { fmt, mss, parseHidden, RaceIcon, record } from "@/lib/ui";
import { GamesView } from "./GamesView";
import { type DraftStep, type LoadPreset, Sides, type SideState } from "./Sides";
import { SortSelect } from "./SortSelect";

const LIMIT = 25; // games a page lists
const SORTS: Record<string, string> = { "-added": "Recently added", added: "First added", "-duration": "Longest", duration: "Shortest", map: "Map" };
const CODE = /^[A-Za-z0-9_]{1,8}$/;
// The URL keys of each side.
const KEYS = {
  player: { race: "race", name: "player", steps: "steps", opened: "opened" },
  opponent: { race: "opponent_race", name: "opp_player", steps: "opp_steps", opened: "opp_opened" },
} as const;


/** A player of a row on one line: race icon, then name, its battle tag number quiet; `both` tags a game either player fits. */
function Who({ p, both = false }: { p: SidePlayer; both?: boolean }) {
  const i = p.name.indexOf("#");
  return (
    <span className="who">
      <RaceIcon race={p.race} size="18px" />
      <span className="font-name truncate" title={p.name}>
        {i > 0 ? p.name.slice(0, i) : p.name}
        {i > 0 && <span className="tag">{p.name.slice(i)}</span>}
      </span>
      {both && (
        <span className="both" title="Either player fits the Player side">
          both
        </span>
      )}
    </span>
  );
}

/** A player's heroes in pick order, each a command-card icon with its final level on the corner. */
function Heroes({ p, objects }: { p: SidePlayer; objects: Objects }) {
  if (!p.heroes.length) return null;
  return (
    <ul aria-label={`Heroes of ${p.name}`} className="heroes">
      {p.heroes.map((h, i) => {
        const label = `${objects[h.code]?.name ?? "Unknown hero"}, level ${h.level}`;
        return (
          <li key={i} title={label}>
            {objects[h.code]?.icon ? <img src={objects[h.code].icon!} width={24} height={24} alt={label} /> : <span role="img" aria-label={label} className="none" />}
            <span className="lv" aria-hidden>
              {h.level}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** A result from the Player's view: a win or loss square and the word. */
function ResultMark({ won }: { won: boolean | null }) {
  if (won === null) return <span className="text-muted">No result</span>;
  return (
    <span className="res">
      <span aria-hidden className={`sq ${won ? "bg-win" : "bg-loss"}`} />
      {won ? "Won" : "Lost"}
    </span>
  );
}

export default async function ReplaysPage({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const value = (k: string) => (typeof sp[k] === "string" ? sp[k] : "");
  const sort = SORTS[value("sort")] ? value("sort") : "-added";
  const page = Math.max(1, Math.floor(Number(value("page"))) || 1);
  /** This page's URL with some keys changed; null drops a key. */
  const href = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (typeof v === "string" && v ? [[k, v]] : [])));
    for (const [k, v] of Object.entries(patch)) if (v === null) q.delete(k);
    else q.set(k, v);
    return `/?${q}`;
  };

  // The replay filters: map, patch and length in minutes, both ends included, on exact ms.
  const filters: Filters = {};
  for (const k of ["map", "patch"]) if (value(k)) filters[k] = [value(k)];
  const [min, max] = [value("min"), value("max")].map((v) => (v && Number.isFinite(Number(v)) ? Number(v) * 60000 : undefined));
  if (min !== undefined || max !== undefined) filters.duration_ms = { gte: min, lte: max };

  const read = (who: keyof typeof KEYS) => {
    const k = KEYS[who];
    return {
      race: parseRaces(value(k.race)),
      name: value(k.name),
      groups: decodeGroups(value(k.steps)),
      opened: value(k.opened).split(".").filter((c) => CODE.test(c)).slice(0, 6),
    };
  };
  const [player, opponent] = [read("player"), read("opponent")];
  const outcome = ({ won: "win", lost: "loss" } as const)[value("result") as "won" | "lost"] ?? null;

  // the names and icons of every object the sides and the strategy presets name, and the objects of each "@source" group
  const presetList = await getPresets();
  const steps = [...player.groups.flat(), ...opponent.groups.flat()];
  const codes = [
    ...new Set([
      ...steps.flatMap((s) => s.codes.filter((c) => !c.startsWith("@"))),
      ...player.opened,
      ...opponent.opened,
      ...Object.values(HALLS),
      ...presetList.flatMap((p) => p.steps.flatMap((s) => s.codes)),
    ]),
  ];
  const groupKeys = [...new Map([...steps, ...presetList.flatMap((p) => p.steps.map(urlStep))].flatMap((s) => s.codes.filter((c) => c.startsWith("@")).map((c) => [`${s.kind}${c}`, { kind: s.kind, source: c.slice(1) }]))).values()];
  const [names, groups, maps, patches, players, counts] = await Promise.all([
    getObjects(codes),
    stepGroups(groupKeys),
    pickerValues("map"),
    pickerValues("patch"),
    pickerValues("player"),
    raceCounts(filters),
  ]);
  const groupCodes = Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, g.codes]));
  const apiSide = (s: typeof player) => ({
    race: s.race,
    name: s.name || null,
    opened_with: s.opened,
    groups: s.groups.map((g) => ({ steps: g.map((st) => apiStep(st, played(s.race), groupCodes)) })),
  });
  const answer = await searchGames({ filters, player: { ...apiSide(player), outcome }, opponent: apiSide(opponent), sort, limit: LIMIT, offset: (page - 1) * LIMIT });
  const heroes = await getObjects([...new Set(answer.replays.flatMap((r) => [...r.player.heroes, ...r.opponent.heroes].map((h) => h.code)))]);

  // the sides as the editor starts them, each step with its name and icon
  let key = 0;
  const label = (s: Step, race: string[]) => stepObject(s, race, names, groups);
  const draft = (s: typeof player, outcomeWord: SideState["outcome"]): SideState => ({
    race: s.race,
    name: s.name,
    outcome: outcomeWord,
    groups: (s.groups as Groups).map((g) => g.map((st): DraftStep => ({ ...st, key: key++, ...label(st, s.race) }))),
    opened: s.opened.map((c) => ({ code: c, name: names[c]?.name ?? c, icon: names[c]?.icon ?? null })),
  });
  const sides = { player: draft(player, value("result") === "won" ? "won" : value("result") === "lost" ? "lost" : ""), opponent: draft(opponent, "") };
  const halls = Object.fromEntries(Object.values(HALLS).map((c) => [c, { name: names[c]?.name ?? c, icon: names[c]?.icon ?? null }]));
  // "Load a strategy": each preset's whole group, a variant under its parent
  const byId = new Map(presetList.map((p) => [p.id, p]));
  const presets: LoadPreset[] = presetList.map((p) => ({
    id: p.id,
    name: p.name,
    race: p.race,
    depth: p.parent_id ? 1 : 0,
    steps: presetSteps(p, byId).map((st) => ({ ...urlStep(st), ...stepObject(urlStep(st), [p.race], names, groups) })),
  }));

  const { summary: sum, scope, total, replays, sql, params, refused } = answer;
  // the steps, the outcome and the openers narrow the scope; races, names and replay filters set it
  const narrowed = steps.length > 0 || outcome !== null || player.opened.length > 0 || opponent.opened.length > 0;
  const scopeWords = player.race.length || opponent.race.length ? `${raceLabel(player.race)} v ${raceLabel(opponent.race)} games` : "games";
  const first = (page - 1) * LIMIT;
  // the columns the reader hid: a view setting, so Search, Clear and the pager keep it and a game link drops it
  const hidden = parseHidden(value("hide"));
  const set = Object.entries(sp).some(([k, v]) => v && k !== "hide");
  // a game opened from a search with steps carries the search (q) and its Player (side), so its page marks the steps
  const searchQs = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (typeof v === "string" && v && k !== "page" && k !== "sort" && k !== "hide" ? [[k, v]] : []))).toString();
  const gameHref = (r: (typeof replays)[number]) =>
    `/replays/${r.replay_id}` + (steps.length ? `?${new URLSearchParams({ q: searchQs, side: r.player.name })}` : "");
  const sortLink = (col: "map" | "duration") => {
    const next = col === "map" ? (sort === "map" ? "-map" : "map") : sort === "-duration" ? "duration" : "-duration";
    return href({ sort: next, page: null });
  };
  const ariaSort = (col: string) => (sort.replace("-", "") === col ? (sort.startsWith("-") ? "descending" : "ascending") : undefined);

  return (
    <main className="wrap flex flex-col gap-4 py-6">
      <h1>Replays</h1>

      {/* keyed by the query, so a link or Back redraws the fields from the URL */}
      <form key={JSON.stringify({ ...sp, hide: undefined })} className="flex flex-col gap-4">
        <div className="card filters">
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="text-muted">Map</span>
            <select name="map" defaultValue={value("map")} className="field">
              <option value="">Any</option>
              {maps.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="text-muted">Patch</span>
            <select name="patch" defaultValue={value("patch")} className="field">
              <option value="">Any</option>
              {patches.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <div role="group" aria-labelledby="minutes" className="flex min-w-0 flex-col gap-1 text-sm">
            <span id="minutes" className="text-muted">
              Minutes
            </span>
            <div className="range">
              <input name="min" type="number" min={0} step="any" inputMode="decimal" placeholder="from" aria-label="Minutes from" defaultValue={value("min")} className="field" />
              <span aria-hidden className="text-muted">
                –
              </span>
              <input name="max" type="number" min={0} step="any" inputMode="decimal" placeholder="to" aria-label="Minutes to" defaultValue={value("max")} className="field" />
            </div>
          </div>
        </div>
        <Sides player={sides.player} opponent={sides.opponent} counts={counts} scope={filters} halls={halls} nextKey={key} presets={presets} />
        {sort !== "-added" && <input type="hidden" name="sort" value={sort} />}
        {hidden.length > 0 && <input type="hidden" name="hide" value={hidden.join(".")} />}
        <div className="flex items-center justify-end gap-5">
          {set && <Link href={hidden.length ? `/?hide=${hidden.join(".")}` : "/"}>Clear</Link>}
          <button type="submit" className="btn btn-gold">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <circle cx="11" cy="11" r="6.5" />
              <path d="M16 16l4 4" />
            </svg>
            Search
          </button>
        </div>
      </form>
      <datalist id="players">
        {players.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>

      <section className="card" aria-labelledby="games-title">
        <div className="bar">
          <h2 id="games-title">Games</h2>
          {!refused && <span className="chip bg-primary text-on-primary">{fmt(total)}</span>}
          <span className="ml-auto flex items-center gap-2">
            <span aria-hidden className="text-sm text-banner-muted">
              Sort
            </span>
            <SortSelect value={sort} options={Object.entries(SORTS).map(([v, l]) => [v, l, href({ sort: v === "-added" ? null : v, page: null })])} />
          </span>
        </div>
        {refused ? (
          <p role="alert" className="p-8 text-center">
            The API refused this search: {refused}
          </p>
        ) : (
          <>
            <div className="stats">
              <div className="stat">
                <span className="s-l">Games</span>
                <span className="s-v">{fmt(sum.games)}</span>
                <span className="s-n">{narrowed && scope.games ? `${Math.round((100 * sum.games) / scope.games)}% of ${fmt(scope.games)} ${scopeWords}` : scopeWords === "games" ? "All games" : scopeWords.replace(/ games$/, "")}</span>
                {/* games either player fits add no result; said only when some games fit one way */}
                {sum.both > 0 && sum.both < sum.games && <span className="s-n">{fmt(sum.both)} fit both ways</span>}
              </div>
              {/* a record of the games that fit one way: the API answers null when every game fits both ways */}
              {sum.wins !== null && sum.losses !== null && (
                <div className="stat">
                  <span className="s-l">Player record</span>
                  <span className="s-v">{record(sum.wins, sum.losses)}</span>
                  {narrowed && scope.wins !== null && scope.losses !== null && (
                    <span className="s-n">
                      Of {fmt(scope.games - scope.both)} one way: {record(scope.wins, scope.losses)}
                    </span>
                  )}
                </div>
              )}
            </div>
            {replays.length === 0 ? (
              <p className="p-8 text-center text-muted">No game matches. {steps.length ? "Drop a step or widen the filters." : "Widen the filters."}</p>
            ) : (
              <GamesView hidden={hidden}>
                <table className="games">
                  <thead>
                    <tr>
                      <th scope="col" className="c-p">Player</th>
                      <th scope="col" className="c-ph">Heroes</th>
                      <th scope="col" className="c-r">Result</th>
                      <th scope="col" className="c-o">Opponent</th>
                      <th scope="col" className="c-oh">Heroes</th>
                      <th scope="col" className="c-m" aria-sort={ariaSort("map")}>
                        <Link href={sortLink("map")}>
                          Map
                        </Link>
                      </th>
                      <th scope="col" className="c-l" aria-sort={ariaSort("duration")}>
                        <Link href={sortLink("duration")}>
                          Length
                        </Link>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {replays.map((r) => (
                      <tr key={`${r.replay_id}-${r.player.name}`}>
                        <td className="c-p">
                          {/* the tag only beside a record: with every game fitting both ways it says nothing */}
                          <Who p={r.player} both={r.both && sum.wins !== null} />
                        </td>
                        <td className="c-ph">
                          <Heroes p={r.player} objects={heroes} />
                        </td>
                        <td className="c-r">
                          <ResultMark won={r.player.won} />
                        </td>
                        <td className="c-o">
                          <span className="vs">v</span>
                          <Who p={r.opponent} />
                        </td>
                        <td className="c-oh">
                          <Heroes p={r.opponent} objects={heroes} />
                        </td>
                        <td className="c-m">
                          {/* no prefetch: it runs generateMetadata, a full replay read per row */}
                          <Link href={gameHref(r)} prefetch={false} title={r.map || undefined}>
                            {r.map || "Unknown map"}
                          </Link>
                        </td>
                        <td className="c-l">{mss(r.duration_ms)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </GamesView>
            )}
            {total > 0 && (
              <nav aria-label="Games pages" className="pager">
                <span>
                  {fmt(first + 1)}–{fmt(first + replays.length)} of {fmt(total)}
                </span>
                {page > 1 ? (
                  <Link href={href({ page: page === 2 ? null : String(page - 1) })} className="btn btn-line">
                    Previous
                  </Link>
                ) : (
                  <span aria-disabled="true" className="btn btn-line opacity-50">
                    Previous
                  </span>
                )}
                {first + LIMIT < total ? (
                  <Link href={href({ page: String(page + 1) })} className="btn btn-line">
                    Next
                  </Link>
                ) : (
                  <span aria-disabled="true" className="btn btn-line opacity-50">
                    Next
                  </span>
                )}
              </nav>
            )}
          </>
        )}
        {sql && (
          <details className="border-t">
            <summary className="cursor-pointer px-4 py-3 text-sm text-muted">Show SQL</summary>
            <pre className="overflow-x-auto px-4 pb-4 text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
              {sql + Object.entries(params).map(([k, v]) => `\n-- ${k} = ${v}`).join("")}
            </pre>
          </details>
        )}
      </section>
    </main>
  );
}
