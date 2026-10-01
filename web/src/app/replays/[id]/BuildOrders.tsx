"use client";
import { useState } from "react";
import type { GameEvent, Objects } from "@/lib/api";
import { mss, ObjIcon, PlayerName, SeriesKey, SkillTrail } from "@/lib/ui";

type Player = { player_id: number; name: string; race: string };
type Row = GameEvent & { skills: GameEvent[] };

const KINDS = [
  { key: "buildings", label: "Buildings", types: ["building"] },
  { key: "units", label: "Units", types: ["unit"] },
  { key: "upgrades", label: "Upgrades", types: ["upgrade"] },
  { key: "heroes", label: "Heroes", types: ["hero_trained", "hero_skill", "hero_retrained"] },
  { key: "items", label: "Items", types: ["item"] },
];
const ALL = KINDS.map((k) => k.key);

/** One player's orders of the kinds that are on, in time order; a skill sits under its hero's row. */
function rowsFor(events: GameEvent[], playerId: number, types: Set<string>): Row[] {
  const mine = events.filter((e) => e.player_id === playerId && types.has(e.event_type));
  const rows: Row[] = mine.filter((e) => e.event_type !== "hero_skill").map((e) => ({ ...e, skills: [] }));
  const heroes = new Map<string, Row>();
  for (const r of rows) if (r.event_type === "hero_trained" && !heroes.has(r.code)) heroes.set(r.code, r);
  for (const e of mine) {
    if (e.event_type !== "hero_skill") continue;
    const hero = e.hero_code ? heroes.get(e.hero_code) : undefined;
    if (hero) hero.skills.push(e);
    else rows.push({ ...e, skills: [] });
  }
  return rows.sort((a, b) => a.time_ms - b.time_ms);
}

function Order({ row, objects, right }: { row: Row; objects: Objects; right?: boolean }) {
  const name = objects[row.code]?.name ?? row.code;
  return (
    <>
      <div className={`flex min-h-[30px] items-center gap-2 ${right ? "justify-end text-right" : ""}`}>
        {right && <span>{name}</span>}
        <ObjIcon code={row.code} objects={objects} size={24} alt="" />
        {!right && <span>{name}</span>}
      </div>
      <SkillTrail skills={row.skills} objects={objects} className={`pb-1.5 ${right ? "justify-end pr-8" : "pl-8"}`} />
    </>
  );
}

/** Both build orders as a list: two columns on one time axis from md up, a tab per player below. */
export function BuildOrders({ players, events, objects, kinds }: { players: Player[]; events: GameEvent[]; objects: Objects; kinds?: string }) {
  const [on, setOn] = useState(() => (kinds === undefined ? ALL : kinds.split(",").filter((k) => ALL.includes(k))));
  const [tab, setTab] = useState(0);

  // ?kinds= holds the kinds that are on; no key means all of them
  const toggle = (key: string) => {
    const next = ALL.filter((k) => (k === key ? !on.includes(k) : on.includes(k)));
    setOn(next);
    window.history.replaceState(null, "", location.pathname + (next.length === ALL.length ? "" : `?kinds=${next.join(",")}`));
  };

  const types = new Set(KINDS.filter((k) => on.includes(k.key)).flatMap((k) => k.types));
  const lists = players.map((p) => rowsFor(events, p.player_id, types));
  // orders at the same time share a row
  const byTime = new Map<number, Row[][]>();
  lists.forEach((rows, i) =>
    rows.forEach((r) => {
      if (!byTime.has(r.time_ms)) byTime.set(r.time_ms, players.map(() => []));
      byTime.get(r.time_ms)![i].push(r);
    }),
  );
  const times = [...byTime.keys()].sort((a, b) => a - b);

  return (
    <section className="card">
      <div className="bar">
        <h2 className="mr-2">Build orders</h2>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Kinds">
          {KINDS.map((k) => (
            <button key={k.key} type="button" className="toggle" aria-pressed={on.includes(k.key)} onClick={() => toggle(k.key)}>
              {on.includes(k.key) && (
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                  <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              {k.label}
            </button>
          ))}
        </div>
      </div>

      {on.length === 0 ? (
        <p className="p-4 text-muted">Pick a kind.</p>
      ) : (
        <>
          <div className="hidden overflow-x-auto px-4 pb-3 md:block">
            <table className="w-full table-fixed text-[15px]">
              <thead className="text-sm">
                <tr className="border-b">
                  <th className="py-3 text-right font-medium">
                    <span className="inline-flex items-center gap-2">
                      <PlayerName name={players[0].name} race={players[0].race} />
                      <SeriesKey i={0} />
                    </span>
                  </th>
                  <th className="w-20 py-3 font-medium text-muted">Ordered</th>
                  {players[1] && (
                    <th className="py-3 text-left font-medium">
                      <span className="inline-flex items-center gap-2">
                        <SeriesKey i={1} />
                        <PlayerName name={players[1].name} race={players[1].race} />
                      </span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {times.map((t) => {
                  const [a, b] = byTime.get(t)!;
                  return (
                    <tr key={t} className="align-top">
                      <td className="py-0.5">
                        {a.map((r, j) => (
                          <Order key={j} row={r} objects={objects} right />
                        ))}
                      </td>
                      <td className="pt-1.5 text-center text-[13px] text-muted">{mss(t)}</td>
                      {players[1] && (
                        <td className="py-0.5">
                          {b.map((r, j) => (
                            <Order key={j} row={r} objects={objects} />
                          ))}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="md:hidden">
            <div role="tablist" aria-label="Players" className="flex border-b">
              {players.map((p, i) => (
                <button
                  key={p.player_id}
                  type="button"
                  role="tab"
                  aria-selected={tab === i}
                  onClick={() => setTab(i)}
                  className={`flex min-w-0 flex-1 items-center justify-center gap-2 border-b-2 px-2 py-3 text-sm ${tab === i ? "border-primary" : "border-transparent text-muted"}`}
                >
                  <SeriesKey i={i} />
                  <PlayerName name={p.name} race={p.race} />
                </button>
              ))}
            </div>
            <ol role="tabpanel" className="px-4 py-2">
              {lists[tab].map((r, j) => (
                <li key={j}>
                  <div className="flex min-h-8 items-center gap-3 text-sm">
                    <span className="w-11 shrink-0 text-muted">{mss(r.time_ms)}</span>
                    <ObjIcon code={r.code} objects={objects} size={24} alt="" />
                    <span className="min-w-0">{objects[r.code]?.name ?? r.code}</span>
                  </div>
                  <SkillTrail skills={r.skills} objects={objects} className="pb-1.5 pl-[92px]" />
                </li>
              ))}
            </ol>
          </div>
        </>
      )}
    </section>
  );
}
