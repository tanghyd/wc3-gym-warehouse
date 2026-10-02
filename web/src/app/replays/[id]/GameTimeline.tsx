"use client";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import type { GameEvent, Objects } from "@/lib/api";
import { mss, ObjIcon, PlayerName, SeriesKey, SkillTrail } from "@/lib/ui";
import { ALL_KINDS, describe, KINDS, merge, stepsOf, tiers, type Mark } from "./orders";
import { type Block, TimelineChart } from "./TimelineChart";

type Player = { player_id: number; name: string; race: string; apm_per_minute: number[] };
type Row = Mark & { skills: GameEvent[]; tier?: number };

const WIDE = "(min-width: 768px)";
const subscribe = (cb: () => void) => {
  const q = matchMedia(WIDE);
  q.addEventListener("change", cb);
  return () => q.removeEventListener("change", cb);
};

/** One player's list: the marks in time order, a hero's skills under it, its tier-ups flagged. */
function rowsFor(b: Block, events: GameEvent[]): Row[] {
  const marks = b.lanes.flatMap((l) => l.marks);
  const heroes = new Set(marks.filter((m) => m.event_type === "hero_trained").map((m) => m.code));
  return marks
    .filter((m) => m.event_type !== "hero_skill" || !heroes.has(m.hero_code ?? ""))
    .map((m) => ({
      ...m,
      skills: m.event_type === "hero_trained" ? events.filter((e) => e.player_id === b.player_id && e.event_type === "hero_skill" && e.hero_code === m.code) : [],
      tier: b.tiers.find((t) => t.code === m.code && t.time_ms === m.times[0])?.tier,
    }))
    .sort((x, y) => x.times[0] - y.times[0]);
}

// Rows whose time is not an order: a retrain, and the first skill point of a hero with no code
const chip = (r: Row) => (r.event_type === "hero_retrained" ? "Retrained" : r.event_type === "hero_trained" && !r.code ? "Trained by" : null);

/** The column head over a list's times. */
function OrdersHead() {
  return <p className="pb-1.5 text-xs text-muted">Ordered</p>;
}

function Orders({ rows, objects, label, hits }: { rows: Row[]; objects: Objects; label: string; hits?: Record<string, number[]> }) {
  return (
    <ol aria-label={label} className="py-1 text-sm">
      {rows.map((r, j) => (
        <li key={j} className="py-1">
          <div className="flex min-h-7 items-center gap-3">
            <span className="w-11 shrink-0 text-muted">{mss(r.times[0])}</span>
            <ObjIcon code={r.code} objects={objects} size={24} alt="" />
            <span className="min-w-0">{describe(r, objects)[0]}</span>
            {stepsOf(r, hits).map((n) => (
              <span key={n} className="step-no static" title={`Step ${n} of the search`}>
                {n}
              </span>
            ))}
            {r.tier && <span className="chip border">T{r.tier}</span>}
            {chip(r) && <span className="chip border">{chip(r)}</span>}
          </div>
          {r.times.length > 1 && <p className="pl-[92px] text-xs text-muted">{r.times.map(mss).join(", ")}</p>}
          <SkillTrail skills={r.skills} objects={objects} className="pt-1 pl-[92px]" />
        </li>
      ))}
    </ol>
  );
}

/**
 * APM and both builds on one game clock: a chart from md up, lists below; ?kinds= holds the kinds
 * that are on. `hits` are the orders a search's steps matched, per player, and `legend` lists those steps.
 */
export function GameTimeline(props: {
  players: Player[];
  events: GameEvent[];
  objects: Objects;
  durationMs: number;
  kinds?: string;
  hits?: Record<number, Record<string, number[]>>;
  legend?: ReactNode;
}) {
  const { players, events, objects, durationMs, kinds, hits = {} } = props;
  const [on, setOn] = useState(() => (kinds === undefined ? ALL_KINDS : kinds.split(",").filter((k) => ALL_KINDS.includes(k))));
  // null until the reader picks: CSS shows the chart from md up and the list below
  const [view, setView] = useState<"chart" | "list" | null>(null);
  const [tab, setTab] = useState(0);
  const wide = useSyncExternalStore(subscribe, () => matchMedia(WIDE).matches, () => true);
  const shown = view ?? (wide ? "chart" : "list");

  // no key means all kinds
  const toggle = (key: string) => {
    const next = ALL_KINDS.filter((k) => (k === key ? !on.includes(k) : on.includes(k)));
    setOn(next);
    const q = new URLSearchParams(location.search);
    if (next.length === ALL_KINDS.length) q.delete("kinds");
    else q.set("kinds", next.join(","));
    // commas stay as they are, so ?kinds=units,items reads as typed
    window.history.replaceState(null, "", location.pathname + (q.size ? `?${q.toString().replace(/%2C/g, ",")}` : ""));
  };

  const blocks: Block[] = players.map((p) => {
    const mine = events.filter((e) => e.player_id === p.player_id);
    const lanes = KINDS.filter((k) => on.includes(k.key)).map((k) => ({ key: k.key, label: k.label, marks: merge(mine.filter((e) => k.types.includes(e.event_type))) }));
    return { ...p, lanes, tiers: tiers(mine), hits: hits[p.player_id] ?? {} };
  });
  const lists = blocks.map((b) => rowsFor(b, events));
  const minutes = Math.max(0, ...players.map((p) => p.apm_per_minute.length));

  return (
    <section className="card">
      <div className="bar">
        <h2 className="mr-2">Game Timeline</h2>
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
        <div className="ml-auto flex gap-2" role="group" aria-label="View">
          {(["chart", "list"] as const).map((v) => (
            <button key={v} type="button" className="toggle" aria-pressed={shown === v} onClick={() => setView(v)}>
              {v === "chart" ? "Chart" : "List"}
            </button>
          ))}
        </div>
      </div>

      {props.legend}

      {(view ?? "chart") === "chart" && (
        <div className={`p-4 ${view ? "" : "hidden md:block"}`}>
          <TimelineChart blocks={blocks} durationMs={durationMs} objects={objects} />
        </div>
      )}

      {(view ?? "list") === "list" && (
        <div className={view ? "" : "md:hidden"}>
          <div className="p-4">
            <h3 className="mb-2">APM per Minute</h3>
            <div className="overflow-x-auto">
              <table className="table w-auto text-sm">
                <thead>
                  <tr>
                    <th className="sticky left-0 bg-surface">Minute</th>
                    {Array.from({ length: minutes }, (_, m) => (
                      <th key={m} className="text-right">
                        {m + 1}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {players.map((p, i) => (
                    <tr key={p.player_id}>
                      <th scope="row" className="sticky left-0 bg-surface">
                        <span className="inline-flex items-center gap-2">
                          <SeriesKey i={i} />
                          <PlayerName name={p.name} race={p.race} />
                        </span>
                      </th>
                      {Array.from({ length: minutes }, (_, m) => (
                        <td key={m} className="text-right">
                          {p.apm_per_minute[m] ?? "–"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="border-t">
            <h3 className="px-4 pt-4">Build Orders</h3>
            {on.length === 0 ? (
              <p className="p-4 text-muted">Pick a kind.</p>
            ) : (
              <>
                <div className="hidden gap-x-8 px-4 pb-3 md:grid md:grid-cols-2">
                  {blocks.map((b, i) => (
                    <div key={b.player_id} className="min-w-0">
                      <div className="sticky top-0 z-10 border-b bg-surface">
                        <div className="flex h-12 items-center gap-2">
                          <SeriesKey i={i} />
                          <PlayerName name={b.name} race={b.race} />
                        </div>
                        <OrdersHead />
                      </div>
                      <Orders rows={lists[i]} objects={objects} label={`Orders of ${b.name}`} hits={b.hits} />
                    </div>
                  ))}
                </div>

                <div className="md:hidden">
                  <div role="tablist" aria-label="Players" className="mt-2 flex border-b">
                    {blocks.map((p, i) => (
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
                  <div role="tabpanel" className="px-4 pt-3 pb-1">
                    <OrdersHead />
                    {blocks[tab] && <Orders rows={lists[tab]} objects={objects} label={`Orders of ${blocks[tab].name}`} hits={blocks[tab].hits} />}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
