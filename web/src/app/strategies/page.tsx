import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { getObjects, getPresets, pickerValues, raceCounts, strategyStats } from "@/lib/api";
import { RACES } from "@/lib/races";
import { encodeGroups, played } from "@/lib/steps";
import { type Preset, presetSteps, ruleWords, type Stats, urlStep } from "@/lib/strategies";
import { Chevron, fmt, mss, ObjIcon, RaceIcon, record } from "@/lib/ui";
import { StrategyFilters } from "./Filters";
import { readScope } from "./scope";
import { Tabs } from "./Tabs";

export const metadata: Metadata = { title: "Strategies" };

const FLOOR = 10; // games a record needs to read in full ink
const MIN_GAMES = 5; // a preset with fewer games in scope is hidden


function SearchGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </svg>
  );
}

/**
 * Named strategies of one race: each preset's games in scope, its share of the scope (a
 * variant's of its parent), its record and the average length, in one POST
 * /strategies/stats. A row's games open Replays with the preset in the Player side.
 */
export default async function StrategiesPage({ searchParams }: PageProps<"/strategies">) {
  const sp = await searchParams;
  const s = readScope(sp);
  const races = played(s.race);
  const [presets, stats, counts, maps] = await Promise.all([
    getPresets(),
    strategyStats({ race: s.race, opponent_race: s.opp, filters: s.filters }),
    raceCounts(s.filters),
    pickerValues("map"),
  ]);
  const byId = new Map(presets.map((p) => [p.id, p]));
  const figures = new Map(stats.strategies.map((f) => [f.id, f]));
  const named = presets.filter((p) => races.includes(p.race));
  const mine = named.filter((p) => (figures.get(p.id)?.games ?? 0) >= MIN_GAMES);
  const names = await getObjects([...new Set(mine.flatMap((p) => p.steps.flatMap((st) => st.codes)))]);

  // ?open= once per parent whose variants show
  const open = new Set([sp.open ?? []].flat());
  const games = (p: Preset) => figures.get(p.id)?.games ?? 0;
  const byGames = (a: Preset, b: Preset) => games(b) - games(a) || a.name.localeCompare(b.name);
  const variants = (p: Preset) => mine.filter((v) => v.parent_id === p.id).sort(byGames);
  const rows = mine
    .filter((p) => !p.parent_id)
    .sort(byGames)
    .flatMap((p) => [{ p, depth: 0 }, ...(open.has(p.id) ? variants(p).map((v) => ({ p: v, depth: 1 })) : [])]);
  const toggle = (id: string) => {
    const next = open.has(id) ? [...open].filter((o) => o !== id) : [...open, id];
    return `/strategies?${new URLSearchParams([...s.pairs, ...next.map((o): [string, string] => ["open", o])])}`;
  };
  // Replays with the preset's whole group in the Player side, and the page's race, opponent race, map and minutes
  const replays = (p: Preset) => `/?${new URLSearchParams([...s.pairs, ["steps", encodeGroups([presetSteps(p, byId).map(urlStep)])]])}`;
  const share = (f: Stats, of: number) => (of ? (100 * f.games) / of : 0);
  // a guide's "vs" races show only when the opponent race picked is one of them, so the counts are those games
  const opp = played(s.opp);
  const guideFits = (p: Preset) => p.vs_races.length > 0 && opp.length > 0 && opp.every((r) => p.vs_races.includes(r));

  return (
    <main className="wrap flex flex-col gap-4 py-6">
      <h1>Strategies</h1>
      <Tabs on="named" pairs={s.pairs} />
      <StrategyFilters key={JSON.stringify(sp)} race={s.race} opp={s.opp} map={s.map} min={s.min} max={s.max} counts={counts} maps={maps} keep={[...open].map((o): [string, string] => ["open", o])} />

      <section className="card" aria-labelledby="named-title">
        <div className="bar">
          <RaceIcon race={s.race[0]} />
          <h2 id="named-title">{s.race.map((v) => RACES[v][0]).join(" and ")}</h2>
          <span className="chip bg-primary text-on-primary">{fmt(stats.scope.games)} games</span>
        </div>
        {rows.length === 0 ? (
          <p className="p-8 text-center text-muted">{named.length ? `No strategy has ${MIN_GAMES} games here.` : "No strategy is named for this race."}</p>
        ) : (
          <table className="table named">
            <thead>
              <tr>
                <th scope="col">Strategy</th>
                <th scope="col" className="text-right">
                  Games
                </th>
                <th scope="col" className="text-right">
                  Share
                </th>
                <th scope="col" className="text-right">
                  Record
                </th>
                <th scope="col" className="c-len text-right">
                  Avg length
                </th>
                <th scope="col" className="c-go">
                  <span className="sr-only">Search</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, depth }) => {
                const f = figures.get(p.id) ?? { games: 0, wins: null, losses: null, duration_ms_total: 0, both: 0 };
                const parent = p.parent_id ? figures.get(p.parent_id) : undefined;
                const pct = share(f, parent ? parent.games : stats.scope.games);
                const kids = depth === 0 ? variants(p).length : 0;
                // a mirror adds no result; null wins (every game is one) prints the em dash
                const [score, percent] = record(f.wins ?? 0, f.losses ?? 0).split(" (");
                const first = p.steps[0];
                const rule = (
                  <p className="rule">
                    {first.kind !== "hero" || first.codes.length === 1 ? <ObjIcon code={first.codes[0]} objects={names} size={18} alt="" /> : null}
                    <span>{ruleWords(p.steps, names, presetSteps(p, byId))}</span>
                  </p>
                );
                return (
                  <Fragment key={p.id}>
                    <tr className={depth ? "variant" : ""}>
                      <td>
                        <div className="flex items-start gap-2" style={{ paddingLeft: depth ? "var(--indent)" : kids ? 0 : 24 }}>
                          {kids > 0 && (
                            <Link href={toggle(p.id)} replace scroll={false} aria-expanded={open.has(p.id)} aria-label={`${open.has(p.id) ? "Hide" : "Show"} the variants of ${p.name}`} className="mt-0.5">
                              <Chevron open={open.has(p.id)} />
                            </Link>
                          )}
                          <div className="min-w-0">
                            <p className={depth ? "" : "font-bold"}>
                              {p.name}
                              {guideFits(p) && <span className="ml-2 text-sm font-normal text-muted">vs {p.vs_races.map((r) => RACES[r][0]).join(", ")}</span>}
                            </p>
                            {rule}
                          </div>
                        </div>
                      </td>
                      <td className="text-right">
                        <Link href={replays(p)} prefetch={false} className="font-bold" aria-label={`List the ${fmt(f.games)} games of ${p.name}`}>
                          {fmt(f.games)}
                        </Link>
                      </td>
                      <td className="text-right whitespace-nowrap" title={parent ? `Of ${fmt(parent.games)} games of ${byId.get(p.parent_id!)!.name}` : undefined}>
                        <span className="meter" aria-hidden>
                          <span style={{ width: `${pct}%` }} />
                        </span>
                        <span className="inline-block min-w-[3.25rem] text-right">{pct.toFixed(1)}%</span>
                      </td>
                      <td className={`text-right ${f.games < FLOOR ? "text-muted" : ""}`}>
                        <span className="whitespace-nowrap">{score}</span>
                        {percent && <span className="whitespace-nowrap max-sm:block"> ({percent}</span>}
                      </td>
                      <td className="c-len text-right">{f.games ? mss(f.duration_ms_total / f.games) : "—"}</td>
                      <td className="c-go">
                        <Link href={replays(p)} prefetch={false} className="inline-flex items-center gap-1.5" aria-label={`Search with ${p.name}`}>
                          <SearchGlyph />
                          Search
                        </Link>
                      </td>
                    </tr>
                    {/* a phone shows the rule here, across the row, so the figures keep their width */}
                    <tr className={`rule-row ${depth ? "variant" : ""}`}>
                      <td colSpan={6} style={{ paddingLeft: `calc(8px + ${depth ? "var(--indent)" : "24px"})` }}>
                        {rule}
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        {rows.length > 0 && <p className="border-t px-4 py-2.5 text-sm text-muted">A strategy under {MIN_GAMES} games is hidden.</p>}
        <details className="border-t">
          <summary className="cursor-pointer px-4 py-3 text-sm text-muted">Show SQL</summary>
          <pre className="overflow-x-auto px-4 pb-4 text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
            {stats.sql + Object.entries(stats.params).map(([k, v]) => `\n-- ${k} = ${v}`).join("")}
          </pre>
        </details>
      </section>
    </main>
  );
}
