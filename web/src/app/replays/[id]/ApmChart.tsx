"use client";
import { scaleLinear } from "d3-scale";
import { line } from "d3-shape";
import { useEffect, useRef, useState } from "react";
import { PlayerName, SeriesKey, seriesColor, shortName } from "@/lib/ui";

type Series = { player_id: number; name: string; race: string; apm_per_minute: number[] };

const H = 200; // plot
const T = 12; // headroom for the top tick label
const AXIS = 28; // x-axis band
const INK = "rgb(var(--v-theme-on-surface))";
const MUTED = "rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity))";
const HAIRLINE = "rgba(var(--v-border-color), var(--v-border-opacity))";
const SURFACE = "rgb(var(--v-theme-surface))";

/** APM per minute for both players, as a line chart or a table. */
export function ApmChart({ players, durationMs }: { players: Series[]; durationMs: number }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const minutes = Math.max(0, ...players.map((p) => p.apm_per_minute.length));
  return (
    <section className="card">
      <div className="bar">
        <h2>APM per minute</h2>
        <div className="ml-auto flex gap-2" role="group" aria-label="View">
          {(["chart", "table"] as const).map((v) => (
            <button key={v} type="button" className="toggle" aria-pressed={view === v} onClick={() => setView(v)}>
              {v === "chart" ? "Chart" : "Table"}
            </button>
          ))}
        </div>
      </div>
      <div className="p-4">
        {view === "chart" ? (
          <>
            <ul className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
              {players.map((p, i) => (
                <li key={p.player_id} className="inline-flex items-center gap-2">
                  <SeriesKey i={i} />
                  <PlayerName name={p.name} race={p.race} />
                </li>
              ))}
            </ul>
            {minutes > 0 && <Plot players={players} durationMs={durationMs} />}
          </>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-sm [&_td]:px-3 [&_td]:py-1 [&_th]:px-3 [&_th]:py-1.5">
              <thead className="text-muted">
                <tr>
                  <th className="text-right font-medium">Minute</th>
                  {players.map((p) => (
                    <th key={p.player_id} className="text-right font-medium">
                      <PlayerName name={p.name} race={p.race} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: minutes }, (_, m) => (
                  <tr key={m} className="border-t">
                    <td className="text-right">{m + 1}</td>
                    {players.map((p) => (
                      <td key={p.player_id} className="text-right">
                        {p.apm_per_minute[m] ?? "–"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function Plot({ players, durationMs }: { players: Series[]; durationMs: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hi, setHi] = useState<number | null>(null);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(box.current!);
    return () => ro.disconnect();
  }, []);

  const n = Math.max(...players.map((p) => p.apm_per_minute.length));
  const wide = width >= 600; // direct end labels need the right margin
  const ml = 40;
  const mr = wide ? 96 : 12;
  const maxMin = durationMs / 60000;
  const x = scaleLinear([0, maxMin], [ml, width - mr]);
  const y = scaleLinear([0, Math.max(1, ...players.flatMap((p) => p.apm_per_minute))], [T + H, T]).nice(4);
  // minute k spans k:00 to k+1:00, the last one to the game end; its point sits at the middle
  const at = (k: number) => x((k + Math.min(k + 1, maxMin)) / 2);
  const series = players.map((p, i) => {
    const pts = p.apm_per_minute.map((v, k) => [at(k), y(v)] as [number, number]);
    return { p, i, d: line()(pts) ?? "", end: pts[pts.length - 1] };
  });
  const ends = series.filter((s) => s.end);
  const endLabels = wide && ends.length === 2 && Math.abs(ends[0].end[1] - ends[1].end[1]) >= 16;

  // whole-minute ticks, about one per 90 px
  const count = Math.max(2, Math.round((width - ml - mr) / 90));
  const step = [1, 2, 5, 10, 15, 20, 30].find((s) => maxMin / s <= count) ?? 60;
  const xTicks = Array.from({ length: Math.floor(maxMin / step) + 1 }, (_, j) => j * step);

  const pick = (clientX: number, el: Element) => {
    const px = clientX - el.getBoundingClientRect().left;
    setHi(Math.max(0, Math.min(n - 1, Math.round(x.invert(px) - 0.5))));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") setHi((h) => (h == null ? 0 : Math.min(n - 1, h + 1)));
    else if (e.key === "ArrowLeft") setHi((h) => (h == null ? n - 1 : Math.max(0, h - 1)));
    else return;
    e.preventDefault();
  };
  const cx = hi == null ? 0 : at(hi);
  const rows = hi == null ? [] : series.map((s) => ({ ...s, v: s.p.apm_per_minute[hi] })).filter((s) => s.v != null).sort((a, b) => b.v - a.v);

  return (
    <div ref={box} className="relative" style={{ height: T + H + AXIS }}>
      {width > 0 && (
        <svg
          width={width}
          height={T + H + AXIS}
          tabIndex={0}
          role="img"
          aria-label="APM per minute, both players. Left and right arrows step through the minutes."
          className="block touch-pan-y"
          onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
          onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
          onPointerLeave={(e) => e.pointerType === "mouse" && setHi(null)}
          onKeyDown={onKey}
          onBlur={() => setHi(null)}
        >
          {y.ticks(4).map((t) => (
            <g key={t}>
              <line x1={ml} x2={width - mr} y1={y(t)} y2={y(t)} stroke={HAIRLINE} />
              <text x={ml - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={12} fill={MUTED}>
                {t}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={x(t)} y={T + H + 18} textAnchor="middle" fontSize={12} fill={MUTED}>
              {t}:00
            </text>
          ))}
          {hi != null && <line x1={cx} x2={cx} y1={T} y2={T + H} stroke={MUTED} />}
          {series.map((s) => (
            <path key={s.i} d={s.d} fill="none" stroke={seriesColor(s.i)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {ends.map((s) => (
            <circle key={s.i} cx={s.end[0]} cy={s.end[1]} r={4} fill={seriesColor(s.i)} stroke={SURFACE} strokeWidth={2} />
          ))}
          {rows.map((s) => (
            <circle key={s.i} cx={cx} cy={y(s.v)} r={4.5} fill={seriesColor(s.i)} stroke={SURFACE} strokeWidth={2} />
          ))}
          {endLabels &&
            ends.map((s) => (
              <text key={s.i} x={s.end[0] + 10} y={s.end[1]} dy="0.32em" fontSize={13} fill={INK}>
                {shortName(s.p.name)}
              </text>
            ))}
        </svg>
      )}
      <div aria-live="polite">
        {hi != null && (
          <div
            className="pointer-events-none absolute top-2 rounded bg-surface-variant px-3 py-2 text-sm text-on-surface-variant shadow"
            style={cx + 200 > width ? { right: width - cx + 12 } : { left: cx + 12 }}
          >
            <p className="mb-1 opacity-80">Minute {hi + 1}</p>
            {rows.map((s) => (
              <p key={s.i} className="flex items-center gap-2 whitespace-nowrap">
                <SeriesKey i={s.i} />
                <b className="font-bold">{s.v}</b>
                <span>{s.p.name}</span>
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
