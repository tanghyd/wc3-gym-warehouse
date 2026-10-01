import type { Metadata } from "next";
import Link from "next/link";
import { type Filters, getObjects, pickerValues, query, raceCounts } from "@/lib/api";
import { parseRaces, raceFilters, raceLabel } from "@/lib/races";
import { Field, mss, ObjIcon, RaceIcon, record } from "@/lib/ui";
import { RaceField } from "../RaceMenu";

export const metadata: Metadata = { title: "Openers" };

const DEPTH = 6; // player_games keeps a player's first six building orders
const CODE = /^[A-Za-z0-9_]{1,8}$/;
const FLOOR = 10; // games a win share needs to sort first and read in full ink
const SORTS = { popular: "Most played", winrate: "Best win rate" };

/** A row of the tree: one next building after its path. */
type Row = { code: string; games: number; wins: number; losses: number; avgMs: number; branches: number };

/**
 * What players built next after `prefix`. Every figure counts one player's game won or lost, so a
 * mirror game where both players opened this way counts twice. Grouped by the building after it
 * too, so a row knows how many ways it goes on.
 */
async function level(base: Filters, prefix: string[], sort: string): Promise<Row[]> {
  const d = prefix.length;
  const [next, after] = [`opener_${d + 1}`, `opener_${d + 2}`];
  const filters: Filters = { ...base, ...Object.fromEntries(prefix.map((c, i) => [`opener_${i + 1}`, [c]])) };
  type Split = Record<string, string> & { games: number; wins: number; losses: number; minutes_total: number };
  const split = await query<Split>({ dimensions: d + 1 < DEPTH ? [next, after] : [next], measures: ["games", "wins", "losses", "minutes_total"], filters, limit: 10000 });
  const rows = new Map<string, Row & { minutes: number }>();
  for (const r of split) {
    if (!r[next]) continue; // the opener ended before this depth
    const row = rows.get(r[next]) ?? { code: r[next], games: 0, wins: 0, losses: 0, avgMs: 0, branches: 0, minutes: 0 };
    row.games += r.games;
    row.wins += r.wins;
    row.losses += r.losses;
    row.minutes += r.minutes_total;
    if (r[after]) row.branches += 1;
    rows.set(r[next], row);
  }
  const share = (r: Row) => r.wins / r.games;
  // best win rate: rows from FLOOR games up first, so a 1 – 0 row never leads
  const order = (a: Row, b: Row) =>
    (sort === "winrate" ? Number(b.games >= FLOOR) - Number(a.games >= FLOOR) || share(b) - share(a) || b.games - a.games : b.games - a.games || share(b) - share(a)) ||
    a.code.localeCompare(b.code);
  return [...rows.values()].map(({ minutes, ...r }) => ({ ...r, avgMs: (minutes / r.games) * 60000 })).sort(order);
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden className={`shrink-0 text-muted ${open ? "rotate-90" : ""}`}>
      <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default async function OpenersPage({ searchParams }: PageProps<"/openers">) {
  const sp = await searchParams;
  const value = (k: string) => (typeof sp[k] === "string" ? sp[k] : "");
  // race and opponent_race hold race values, such as NE or NE,RN; Random Night Elf (RN) opens Night Elf buildings
  const race = parseRaces(value("race")).length ? parseRaces(value("race")) : ["NE"];
  const opp = parseRaces(value("opponent_race"));
  const sort = value("sort") === "winrate" ? "winrate" : "popular";
  const scope: [string, string][] = ["map", "patch", "player"].filter(value).map((k): [string, string] => [k, value(k)]);
  const pairs: [string, string][] = [["race", race.join(",")], ...(opp.length ? [["opponent_race", opp.join(",")] as [string, string]] : []), ...scope];
  // only games with a known winner, so games equal wins plus losses
  const base: Filters = {
    ...raceFilters(race),
    ...raceFilters(opp, "opponent_race", "opponent_random"),
    ...Object.fromEntries(scope.map(([k, v]) => [k, [v]])),
    result: ["win", "loss"],
  };

  // ?open= once per expanded row, its path of codes joined with "."; a path loads when every row above it is open
  const key = (p: string[]) => p.join(".");
  const open = [sp.open ?? []].flat().map((o) => o.split(".")).filter((p) => p.length < DEPTH && p.every((c) => CODE.test(c)));
  const openKeys = new Set(open.map(key));
  const paths = [[], ...open.filter((p) => p.slice(0, -1).every((_, i) => openKeys.has(key(p.slice(0, i + 1)))))];
  const unique = [...new Map(paths.map((p) => [key(p), p])).values()];
  const [[{ games: total }], counts, maps, patches, players] = await Promise.all([
    query<{ games: number }>({ measures: ["games"], filters: base }),
    // the race menus count player-games on the map and patch
    raceCounts(Object.fromEntries(scope.filter(([k]) => k !== "player").map(([k, v]) => [k, [v]]))),
    pickerValues("map"),
    pickerValues("patch"),
    pickerValues("player"),
  ]);
  const levels = await Promise.all(unique.map((p) => level(base, p, sort)));
  const tree = new Map(unique.map((p, i) => [key(p), levels[i]]));
  const objects = await getObjects([...new Set(levels.flat().map((r) => r.code))]);

  // The rows on screen, depth first: an open row's children sit right under it.
  const rows: { row: Row; path: string[]; isOpen: boolean }[] = [];
  const walk = (prefix: string[]) => {
    for (const row of tree.get(key(prefix)) ?? []) {
      const path = [...prefix, row.code];
      const isOpen = row.branches > 0 && tree.has(key(path));
      rows.push({ row, path, isOpen });
      if (isOpen) walk(path);
    }
  };
  walk([]);
  const shown = rows.filter((r) => r.isOpen).map((r) => key(r.path));
  const href = (page: string, extra: [string, string][]) => `${page}?${new URLSearchParams([...pairs, ...extra])}`;
  const toggle = (path: string[], isOpen: boolean) => {
    const k = key(path);
    const next = isOpen ? shown.filter((o) => o !== k && !o.startsWith(`${k}.`)) : [...shown, k];
    const sorted: [string, string][] = sort === "winrate" ? [["sort", sort]] : [];
    return href("/openers", [...sorted, ...next.map((o): [string, string] => ["open", o])]);
  };

  return (
    <main className="wrap py-6">
      <h1>Openers</h1>

      <form key={JSON.stringify(sp)} className="card mt-4 flex flex-wrap items-end gap-3 overflow-visible p-4">
        <RaceField label="Race" name="race" value={race} counts={counts} any={false} />
        <RaceField label="Opponent race" name="opponent_race" value={opp} counts={counts} />
        <Field label="Map">
          <select name="map" defaultValue={value("map")} className="field">
            <option value="">Any</option>
            {maps.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
        <Field label="Patch">
          <select name="patch" defaultValue={value("patch")} className="field">
            <option value="">Any</option>
            {patches.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </Field>
        <Field label="Player">
          <input name="player" list="players" defaultValue={value("player")} className="field" autoComplete="off" />
          <datalist id="players">
            {players.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </Field>
        <Field label="Sort by">
          <select name="sort" defaultValue={sort} className="field">
            {Object.entries(SORTS).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        {shown.map((o) => (
          <input key={o} type="hidden" name="open" value={o} />
        ))}
        <div className="flex items-center gap-4">
          <button type="submit" className="btn btn-gold">
            Show openers
          </button>
          {pairs.length > 1 && <Link href={`/openers?race=${race.join(",")}`}>Clear</Link>}
        </div>
      </form>

      <section className="card mt-4">
        <div className="bar">
          <RaceIcon race={race[0]} />
          <h2>{raceLabel(race)}</h2>
          <span className="chip bg-primary text-on-primary">{total} games won or lost</span>
        </div>
        {rows.length === 0 ? (
          <p className="p-8 text-center text-muted">No opener matches. Widen the filters.</p>
        ) : (
          <table className="table [--indent:8px] sm:[--indent:20px] max-sm:[&_td]:px-2 max-sm:[&_th]:px-2">
            <thead>
              <tr>
                <th title="First six building orders, farms left out">Opener</th>
                <th className="text-right" title="Games won or lost, one per player: a mirror game counts twice">
                  Games
                </th>
                <th className="text-right">Record</th>
                <th className="hidden text-right sm:table-cell">Avg length</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ row: r, path, isOpen }) => {
                const name = objects[r.code]?.name ?? r.code;
                const icon = <ObjIcon code={r.code} objects={objects} size={28} alt="" />;
                // on a phone the percent drops under the score
                const [score, percent] = record(r.wins, r.losses).split(" (");
                return (
                  <tr key={key(path)}>
                    <td>
                      <div style={{ paddingLeft: `calc(${path.length - 1} * var(--indent))` }}>
                        {r.branches > 0 ? (
                          <Link href={toggle(path, isOpen)} replace scroll={false} aria-expanded={isOpen} className="flex min-w-0 items-center gap-2 text-on-surface">
                            <Chevron open={isOpen} />
                            {icon}
                            <span className="min-w-0 [overflow-wrap:break-word]">{name}</span>
                          </Link>
                        ) : (
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="w-4 shrink-0" />
                            {icon}
                            <span className="min-w-0 [overflow-wrap:break-word]">{name}</span>
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="text-right">
                      <Link href={href("/", path.map((c, i) => [`opener_${i + 1}`, c]))} prefetch={false} aria-label={`List the games of ${name}`} className="font-bold">
                        {r.games}
                      </Link>
                    </td>
                    <td className={`text-right ${r.games < FLOOR ? "text-muted" : ""}`}>
                      <span className="whitespace-nowrap">{score}</span>
                      {percent && <span className="whitespace-nowrap max-sm:block"> ({percent}</span>}
                    </td>
                    <td className="hidden text-right sm:table-cell">{mss(r.avgMs)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
