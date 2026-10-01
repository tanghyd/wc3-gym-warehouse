"use client";
import { scaleLinear, type ScaleLinear } from "d3-scale";
import { line } from "d3-shape";
import { useEffect, useRef, useState } from "react";
import type { Objects } from "@/lib/api";
import { mss, ObjIcon, PlayerName, SeriesKey, seriesColor, shortName } from "@/lib/ui";
import { describe, type Mark, type Tier } from "./orders";

export type Lane = { key: string; label: string; marks: Mark[] };
export type Block = { player_id: number; name: string; race: string; apm_per_minute: number[]; lanes: Lane[]; tiers: Tier[] };

const MIN_W = 760; // narrower than this, the chart scrolls in its own box
const ML = 88; // the shared gutter: APM ticks and lane labels
const MR = 88; // room for the APM end labels
const APM_T = 12; // headroom for the top tick label
const APM_H = 160;
const AXIS = 28; // a band of minute labels
const HEAD = 40; // a player's name row
const TIER = 24; // the tier-up labels
const ICON = 24;
const PITCH = ICON + 3;
const INK = "rgb(var(--v-theme-on-surface))";
const MUTED = "rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity))";
const HAIRLINE = "rgba(var(--v-border-color), var(--v-border-opacity))";
const SURFACE = "rgb(var(--v-theme-surface))";

type Placed = { m: Mark; x: number; y: number };
type Tip = { mark: Placed; top: number };
/** What the vertical rule marks: a time, an APM minute or one mark. */
type Hover = { ms: number; minute?: number; tip?: Tip };

/** First fit per lane: a mark takes the first row whose last mark ends at least 1 px before it. */
function place(lanes: Lane[], x: (minute: number) => number) {
  let top = TIER;
  const boxes: { key: string; label: string; top: number }[] = [];
  const marks: Placed[] = [];
  for (const lane of lanes) {
    const ends: number[] = [];
    for (const m of lane.marks) {
      const cx = x(m.times[0] / 60000);
      let r = ends.findIndex((e) => e <= cx - ICON / 2 - 1);
      if (r < 0) r = ends.push(0) - 1;
      ends[r] = cx + ICON / 2;
      marks.push({ m, x: cx, y: top + 3 + r * PITCH });
    }
    boxes.push({ key: lane.key, label: lane.label, top });
    top += Math.max(1, ends.length) * PITCH + 5;
  }
  // DOM order is time order, so the arrow keys walk the game
  marks.sort((a, b) => a.m.times[0] - b.m.times[0] || a.y - b.y);
  return { boxes, marks, height: top };
}

/** APM per minute above both players' build lanes, on one game-time scale. */
export function TimelineChart({ blocks, durationMs, objects }: { blocks: Block[]; durationMs: number; objects: Objects }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<Hover | null>(null);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(box.current!);
    return () => ro.disconnect();
  }, []);

  const W = Math.max(MIN_W, width);
  const maxMin = Math.max(durationMs, 1000) / 60000;
  const x = scaleLinear([0, maxMin], [ML, W - MR]);
  // whole-minute ticks, about one per 90 px
  const ticks = x.ticks(Math.max(2, Math.round((W - ML - MR) / 90))).filter(Number.isInteger);

  const apmH = APM_T + APM_H + AXIS;
  const laid = blocks.map((b) => place(b.lanes, x));
  const tops = laid.map((_, i) => apmH + laid.slice(0, i).reduce((s, l) => s + HEAD + l.height, 0));
  const total = apmH + laid.reduce((s, l) => s + HEAD + l.height, 0) + AXIS;

  const timeAt = (el: Element, clientX: number) => {
    const m = x.invert(clientX - el.getBoundingClientRect().left);
    return m < 0 || m > maxMin ? null : m * 60000;
  };
  const rx = hover ? x(hover.ms / 60000) : 0;

  return (
    <div ref={box}>
      <ul className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {blocks.map((p, i) => (
          <li key={p.player_id} className="inline-flex items-center gap-2">
            <SeriesKey i={i} />
            <PlayerName name={p.name} race={p.race} />
          </li>
        ))}
      </ul>
      {width > 0 && (
        <div className="overflow-x-auto">
          <div className="relative" style={{ width: W, height: total }} onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}>
            <Apm blocks={blocks} x={x} W={W} maxMin={maxMin} ticks={ticks} hover={hover} setHover={setHover} />

            {blocks.map((b, i) => (
              <div key={b.player_id} style={{ height: HEAD + laid[i].height }}>
                <div className="flex items-center gap-2" style={{ height: HEAD, boxShadow: "inset 0 1px 0 var(--color-border)" }}>
                  <SeriesKey i={i} />
                  <PlayerName name={b.name} race={b.race} />
                </div>
                <div
                  role="group"
                  aria-label={`Orders of ${b.name}`}
                  className="relative"
                  style={{ height: laid[i].height }}
                  onPointerMove={(e) => {
                    if (e.pointerType !== "mouse" || (e.target as Element).closest("[data-mark]")) return;
                    const ms = timeAt(e.currentTarget, e.clientX);
                    setHover(ms == null ? null : { ms });
                  }}
                  onKeyDown={(e) => {
                    const list = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-mark]")];
                    const j = list.indexOf(e.target as HTMLElement);
                    const next = e.key === "ArrowRight" ? list[j + 1] : e.key === "ArrowLeft" ? list[j - 1] : undefined;
                    if (e.key === "Escape") (e.target as HTMLElement).blur();
                    else if (!next) return;
                    next?.focus();
                    e.preventDefault();
                  }}
                >
                  <svg width={W} height={laid[i].height} className="absolute inset-0 block" aria-hidden>
                    {ticks.map((t) => (
                      <line key={t} x1={x(t)} x2={x(t)} y1={TIER} y2={laid[i].height} stroke={HAIRLINE} />
                    ))}
                    {laid[i].boxes.map((l) => (
                      <g key={l.key}>
                        <line x1={0} x2={W} y1={l.top} y2={l.top} stroke={HAIRLINE} />
                        <text x={0} y={l.top + 3 + ICON / 2} dy="0.32em" fontSize={13} fill={MUTED}>
                          {l.label}
                        </text>
                      </g>
                    ))}
                    <TierTicks tiers={b.tiers} x={x} W={W} height={laid[i].height} />
                  </svg>
                  {laid[i].marks.map((p, j) => {
                    const [name, detail] = describe(p.m, objects);
                    const show = () => setHover({ ms: p.m.times[0], tip: { mark: p, top: tops[i] + HEAD } });
                    return (
                      <span
                        key={j}
                        data-mark
                        role="img"
                        aria-label={`${name}. ${detail}`}
                        tabIndex={j === 0 ? 0 : -1}
                        className="absolute block rounded-sm hover:outline-2 hover:outline-on-surface"
                        style={{ left: p.x - ICON / 2, top: p.y, width: ICON, height: ICON }}
                        onFocus={show}
                        onBlur={() => setHover(null)}
                        onPointerEnter={(e) => e.pointerType === "mouse" && show()}
                        onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
                      >
                        <ObjIcon code={p.m.code} objects={objects} size={ICON} alt="" />
                        {p.m.times.length > 1 && (
                          <span className="absolute right-0 bottom-0 rounded-tl-[3px] bg-banner/90 px-[3px] text-[10px] leading-3 font-bold text-on-banner">
                            ×{p.m.times.length}
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}

            <svg width={W} height={AXIS} className="block" aria-hidden>
              {ticks.map((t) => (
                <text key={t} x={x(t)} y={18} textAnchor="middle" fontSize={12} fill={MUTED}>
                  {t}:00
                </text>
              ))}
            </svg>

            {hover && (
              <div data-rule aria-hidden className="pointer-events-none absolute w-px" style={{ left: rx, top: APM_T, height: total - APM_T - AXIS, background: MUTED }} />
            )}
            {hover && hover.minute == null && (
              <span
                aria-hidden
                className="pointer-events-none absolute -translate-x-1/2 rounded bg-surface-variant px-1.5 text-xs leading-5 text-on-surface-variant"
                style={{ left: rx, top: total - AXIS + 4 }}
              >
                {mss(hover.ms)}
              </span>
            )}
            <div aria-live="polite">{hover?.tip && <MarkTip tip={hover.tip} objects={objects} W={W} total={total} />}</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** A labelled tick per tier-up across the block: "T2 ordered 4:12". */
function TierTicks({ tiers, x, W, height }: { tiers: Tier[]; x: (m: number) => number; W: number; height: number }) {
  const LABEL = 104; // the widest label, "T3 ordered 12:34", at 12 px
  const xs = tiers.map((t) => x(t.time_ms / 60000));
  return tiers.map((t, k) => {
    const tx = xs[k];
    // a label runs right of its tick; left of it when the next label or the edge is too close
    const left = tx + 5 + LABEL > W || xs[k + 1] - tx < LABEL + 13;
    return (
      <g key={t.tier}>
        <line x1={tx} x2={tx} y1={4} y2={height} stroke={INK} strokeOpacity={0.6} strokeDasharray="4 3" />
        <text x={left ? tx - 5 : tx + 5} y={16} textAnchor={left ? "end" : "start"} fontSize={12} fill={INK}>
          <tspan fontWeight={700}>T{t.tier}</tspan> ordered {mss(t.time_ms)}
        </text>
      </g>
    );
  });
}

function MarkTip({ tip, objects, W, total }: { tip: Tip; objects: Objects; W: number; total: number }) {
  const { mark, top } = tip;
  const [name, detail] = describe(mark.m, objects);
  const y = top + mark.y;
  const below = y + ICON + 90 < total;
  return (
    <div
      className="pointer-events-none absolute z-10 max-w-64 rounded bg-surface-variant px-3 py-2 text-sm text-on-surface-variant shadow"
      style={{
        ...(mark.x + 260 > W ? { right: W - mark.x - ICON / 2 } : { left: mark.x - ICON / 2 }),
        ...(below ? { top: y + ICON + 6 } : { top: y - 6, transform: "translateY(-100%)" }),
      }}
    >
      <p className="font-bold">{name}</p>
      <p>{detail}</p>
    </div>
  );
}

type ApmProps = {
  blocks: Block[];
  x: ScaleLinear<number, number>;
  W: number;
  maxMin: number;
  ticks: number[];
  hover: Hover | null;
  setHover: (h: Hover | null) => void;
};

/** APM per minute as two lines, with end labels, a crosshair and a keyboard walk. */
function Apm({ blocks, x, W, maxMin, ticks, hover, setHover }: ApmProps) {
  const n = Math.max(0, ...blocks.map((p) => p.apm_per_minute.length));
  const y = scaleLinear([0, Math.max(1, ...blocks.flatMap((p) => p.apm_per_minute))], [APM_T + APM_H, APM_T]).nice(4);
  // minute k spans k:00 to k+1:00, the last one to the game end; its point sits at the middle
  const at = (k: number) => (k + Math.min(k + 1, maxMin)) / 2;
  const series = blocks.map((p, i) => {
    const pts = p.apm_per_minute.map((v, k) => [x(at(k)), y(v)] as [number, number]);
    return { p, i, d: line()(pts) ?? "", end: pts[pts.length - 1] };
  });
  const ends = series.filter((s) => s.end);
  const endLabels = ends.length === 2 && Math.abs(ends[0].end[1] - ends[1].end[1]) >= 16;

  const hi = hover?.minute ?? null;
  const pickMinute = (k: number) => setHover({ ms: at(k) * 60000, minute: k });
  const pick = (clientX: number, el: Element) => {
    if (n === 0) return;
    const m = x.invert(clientX - el.getBoundingClientRect().left);
    pickMinute(Math.max(0, Math.min(n - 1, Math.floor(m))));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (n === 0) return;
    if (e.key === "ArrowRight") pickMinute(hi == null ? 0 : Math.min(n - 1, hi + 1));
    else if (e.key === "ArrowLeft") pickMinute(hi == null ? n - 1 : Math.max(0, hi - 1));
    else return;
    e.preventDefault();
  };
  const cx = hi == null ? 0 : x(at(hi));
  const rows = hi == null ? [] : series.map((s) => ({ ...s, v: s.p.apm_per_minute[hi] })).filter((s) => s.v != null).sort((a, b) => b.v - a.v);

  return (
    <>
      <svg
        width={W}
        height={APM_T + APM_H + AXIS}
        tabIndex={0}
        role="img"
        aria-label="APM per minute, both players. Left and right arrows step through the minutes."
        className="block"
        onPointerMove={(e) => e.pointerType === "mouse" && pick(e.clientX, e.currentTarget)}
        onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        <text x={0} y={APM_T + 6} dy="0.32em" fontSize={13} fill={MUTED}>
          APM
        </text>
        {y.ticks(4).map((t) => (
          <g key={t}>
            <line x1={ML} x2={W - MR} y1={y(t)} y2={y(t)} stroke={HAIRLINE} />
            <text x={ML - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={12} fill={MUTED}>
              {t}
            </text>
          </g>
        ))}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={APM_T} y2={APM_T + APM_H} stroke={HAIRLINE} />
            <text x={x(t)} y={APM_T + APM_H + 18} textAnchor="middle" fontSize={12} fill={MUTED}>
              {t}:00
            </text>
          </g>
        ))}
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
      <div aria-live="polite">
        {hi != null && (
          <div
            className="pointer-events-none absolute top-2 z-10 rounded bg-surface-variant px-3 py-2 text-sm text-on-surface-variant shadow"
            style={cx + 200 > W ? { right: W - cx + 12 } : { left: cx + 12 }}
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
    </>
  );
}
