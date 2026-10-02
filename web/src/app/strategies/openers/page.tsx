import type { Metadata } from "next";
import Link from "next/link";
import { type Filters, getObjects, pickerValues, query, raceCounts } from "@/lib/api";
import { raceFilters, raceLabel } from "@/lib/races";
import { Chevron, Field, mss, ObjIcon, RaceIcon, record } from "@/lib/ui";
import { StrategyFilters } from "../Filters";
import { readScope } from "../scope";
import { Tabs } from "../Tabs";

export const metadata: Metadata = { title: "Openers" };

const DEPTH = 6; // player_games keeps a player's first six building orders
const CODE = /^[A-Za-z0-9_]{1,8}$/;
const FLOOR = 10; // games a win share needs to sort first and read in full ink
const SORTS = { popular: "Most played", winrate: "Best win rate" };

/** A row of the tree: one next building after its path. */
type Row = { code: string; games: number; wins: number | null; losses: number | null; avgMs: number; branches: number };

/**
 * What players built next after `prefix`. Every figure counts games won or lost in which a player
 * opened this way, a game where both did once: a mirror, which adds no win or loss. The buildings
 * after it, read apart, tell a row how many ways it goes on.
 */
async function level(base: Filters, prefix: string[], sort: string): Promise<Row[]> {
  const d = prefix.length;
  const [next, after] = [`opener_${d + 1}`, `opener_${d + 2}`];
  const filters: Filters = { ...base, ...Object.fromEntries(prefix.map((c, i) => [`opener_${i + 1}`, [c]])) };
  type Figures = Record<string, string> & { games: number; wins: number | null; losses: number | null; minutes_total: number };
  const [figures, splits] = await Promise.all([
    query<Figures>({ dimensions: [next], measures: ["games", "wins", "losses", "minutes_total"], filters, limit: 10000 }),
    d + 1 < DEPTH ? query<Record<string, string>>({ dimensions: [next, after], filters, limit: 10000 }) : [],
  ]);
  const branches = new Map<string, number>();
  for (const s of splits) if (s[after]) branches.set(s[next], (branches.get(s[next]) ?? 0) + 1);
  // a row with no code: the opener ended before this depth
  const rows: Row[] = figures
    .filter((r) => r[next])
    .map((r) => ({ code: r[next], games: r.games, wins: r.wins, losses: r.losses, avgMs: (r.minutes_total / r.games) * 60000, branches: branches.get(r[next]) ?? 0 }));
  // a mirror (a game where both players opened this way) adds no win or loss, so the share reads the other games
  const share = (r: Row) => (r.wins ?? 0) / Math.max(1, (r.wins ?? 0) + (r.losses ?? 0));
  // best win rate: rows from FLOOR games up first, so a 1 – 0 row never leads
  const order = (a: Row, b: Row) =>
    (sort === "winrate" ? Number(b.games >= FLOOR) - Number(a.games >= FLOOR) || share(b) - share(a) || b.games - a.games : b.games - a.games || share(b) - share(a)) ||
    a.code.localeCompare(b.code);
  return rows.sort(order);
}


export default async function OpenersPage({ searchParams }: PageProps<"/strategies/openers">) {
  const sp = await searchParams;
  // race and opponent_race hold race values, such as NE or NE,RN; Random Night Elf (RN) opens Night Elf buildings
  const s = readScope(sp);
  const { value, race, opp } = s;
  const sort = value("sort") === "winrate" ? "winrate" : "popular";
  // the tab's own filters: patch and player
  const own: [string, string][] = ["patch", "player"].filter(value).map((k): [string, string] => [k, value(k)]);
  const pairs: [string, string][] = [...s.pairs, ...own];
  // only games with a known winner, so a row's games are its wins, its losses and its mirrors
  const base: Filters = {
    ...raceFilters(race),
    ...raceFilters(opp, "opponent_race", "opponent_random"),
    ...s.filters,
    ...Object.fromEntries(own.map(([k, v]) => [k, [v]])),
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
    // the race menus count games on the map and patch
    raceCounts({ ...s.filters, ...(value("patch") && { patch: [value("patch")] }) }),
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
    return href("/strategies/openers", [...sorted, ...next.map((o): [string, string] => ["open", o])]);
  };

  return (
    <main className="wrap flex flex-col gap-4 py-6">
      <h1>Strategies</h1>
      <Tabs on="openers" pairs={s.pairs} />

      <StrategyFilters key={JSON.stringify(sp)} race={race} opp={opp} map={s.map} min={s.min} max={s.max} counts={counts} maps={maps} keep={shown.map((o): [string, string] => ["open", o])}>
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
        <Field label="Sort by" className="grow-0">
          <select name="sort" defaultValue={sort} className="field">
            {Object.entries(SORTS).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </StrategyFilters>

      <section className="card">
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
                <th className="text-right" title="Games won or lost in which a player opened this way">
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
                const [score, percent] = record(r.wins ?? 0, r.losses ?? 0).split(" (");
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
                      <Link href={href("/", [["opened", path.join(".")]])} prefetch={false} aria-label={`List the games of ${name}`} className="font-bold">
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
