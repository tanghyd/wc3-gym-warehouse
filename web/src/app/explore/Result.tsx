"use client";
import { Fragment, type KeyboardEvent, type ReactNode, useState, useSyncExternalStore } from "react";
import { type Catalog, dimsOf, measureText, measureValue, mirrorsText, ordered, RACE_DIMS, RACE_ORDER, type Row, type Totals, type ValueLabel, type View } from "@/lib/explore";
import { RaceIcon, Tile } from "@/lib/ui";
import { usePending } from "./Query";

type Labels = Record<string, Record<string, ValueLabel>>;
type Chart = { form: "tiles" | "bars" | "columns" | "heat" | "none"; measure: string | null };

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtOr = (n: number | null) => (n === null ? "—" : fmt(n)); // null: an Other that cannot add up
const PHONE = "(max-width: 639px)";
const subscribe = (cb: () => void) => {
  const q = matchMedia(PHONE);
  q.addEventListener("change", cb);
  return () => q.removeEventListener("change", cb);
};
const useNarrow = () => useSyncExternalStore(subscribe, () => matchMedia(PHONE).matches, () => false);
const OTHER = "\u0000other"; // the key of a folded "Other" row or column

/** A dimension value as the page shows it: icon or race icon, then its words. */
function Value({ d, v, labels, iconOnly = false }: { d: string; v: string; labels: Labels; iconOnly?: boolean }) {
  if (v === OTHER) return <span className="text-muted">Other</span>;
  const l = labels[d]?.[v] ?? { label: v };
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {l.race && <RaceIcon race={l.race} size="18px" />}
      {l.icon !== undefined && <Tile icon={l.icon} size={20} alt={iconOnly ? l.label : ""} />}
      {!(iconOnly && (l.race || l.icon)) && <span className="min-w-0 [overflow-wrap:break-word]">{l.label}</span>}
    </span>
  );
}
const words = (d: string, v: string, labels: Labels) => (v === OTHER ? "Other" : (labels[d]?.[v]?.label ?? v));

/** A dimension's values in their order: races as every menu lists them, numbers up, else most first. */
function orderValues(cat: Catalog, d: string, totals: Map<string, number>) {
  const vs = [...totals.keys()];
  if (d in RACE_DIMS) return vs.sort((a, b) => RACE_ORDER.indexOf(a) - RACE_ORDER.indexOf(b));
  if (ordered(cat, d)) return vs.sort((a, b) => Number(a) - Number(b));
  return vs.sort((a, b) => totals.get(b)! - totals.get(a)! || a.localeCompare(b));
}

/** At most `max` values: the largest stay in their order, the rest fold into Other. */
function fold(cat: Catalog, d: string, totals: Map<string, number>, max: number) {
  const all = orderValues(cat, d, totals);
  if (all.length <= max) return { keep: all, other: new Set<string>() };
  const big = new Set([...all].sort((a, b) => totals.get(b)! - totals.get(a)!).slice(0, max - 1));
  return { keep: all.filter((v) => big.has(v)), other: new Set(all.filter((v) => !big.has(v))) };
}

const sumBy = (rows: Row[], key: (r: Row) => string, m: string) => {
  const out = new Map<string, number>();
  for (const r of rows) out.set(key(r), (out.get(key(r)) ?? 0) + Number(r[m] ?? 0));
  return out;
};

/** Whether a dimension's values add up to the scope's figure: then no game falls under two of them, so Other may add up the values it folds. */
function addsUp(byValue: Map<string, number>, total: Row[string]) {
  const [sum, all] = [[...byValue.values()].reduce((s, v) => s + v, 0), Number(total ?? 0)];
  return Math.abs(sum - all) <= 1e-9 * Math.abs(all);
}

/** The hover and focus readout of one mark: the value first, then what it counts. */
function Tip({ value, label, style }: { value: string; label: string; style: React.CSSProperties }) {
  return (
    <div role="status" className="pointer-events-none absolute z-10 max-w-64 rounded bg-surface-variant px-3 py-2 text-sm text-on-surface-variant shadow" style={style}>
      <p className="font-bold">{value}</p>
      <p>{label}</p>
    </div>
  );
}

/** Arrow keys walk a strip of `n` marks as one keyboard stop. */
function walk(e: KeyboardEvent, at: number | null, n: number, cols = n): number | null {
  const i = at ?? -1;
  const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "ArrowDown" ? i + cols : e.key === "ArrowUp" ? i - cols : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
  if (next === null) return at;
  e.preventDefault();
  return Math.max(0, Math.min(n - 1, at === null ? 0 : next));
}

/**
 * Two dimensions and a count: rows the first, columns the second, the count in every cell in
 * three gold bins and a zero cell, a total column and a total row. At most 8 rows and 9 columns,
 * 5 on a phone; the smallest fold into Other.
 */
function HeatMap({ rows, dr, dc, m, cat, labels, totals }: { rows: Row[]; dr: string; dc: string; m: string; cat: Catalog; labels: Labels; totals: Totals }) {
  const narrow = useNarrow();
  const [at, setAt] = useState<number | null>(null);
  // a game counts once in a row or a column, so the totals are read apart, not added up from the cells
  const byRow = sumBy(totals.rows, (r) => String(r[dr]), m);
  const byCol = sumBy(totals.cols, (r) => String(r[dc]), m);
  const R = fold(cat, dr, byRow, 8);
  const C = fold(cat, dc, byCol, narrow ? 5 : 9);
  const rk = (v: string) => (R.other.has(v) ? OTHER : v);
  const ck = (v: string) => (C.other.has(v) ? OTHER : v);
  const cells = sumBy(rows, (r) => `${rk(String(r[dr]))}\u0001${ck(String(r[dc]))}`, m);
  const rKeys = [...R.keep, ...(R.other.size ? [OTHER] : [])];
  const cKeys = [...C.keep, ...(C.other.size ? [OTHER] : [])];
  // Other adds up the values it folds, or is null when a game can fall under two of them (a race, say)
  const [rowsAdd, colsAdd] = [addsUp(byRow, totals.all[m]), addsUp(byCol, totals.all[m])];
  const cell = (r: string, c: string) => ((r === OTHER && !rowsAdd) || (c === OTHER && !colsAdd) ? null : (cells.get(`${r}\u0001${c}`) ?? 0));
  const rowTotal = (r: string) => (r !== OTHER ? (byRow.get(r) ?? 0) : rowsAdd ? [...R.other].reduce((s, v) => s + (byRow.get(v) ?? 0), 0) : null);
  const colTotal = (c: string) => (c !== OTHER ? (byCol.get(c) ?? 0) : colsAdd ? [...C.other].reduce((s, v) => s + (byCol.get(v) ?? 0), 0) : null);
  const total = Number(totals.all[m] ?? 0);
  // bins 1 to t1-1, t1 to t2-1, t2 and up: 10 and 50 until a cell passes 999, then by tens
  const max = Math.max(0, ...rKeys.flatMap((r) => cKeys.map((c) => cell(r, c) ?? 0)));
  const k = Math.max(1, Math.floor(Math.log10(Math.max(1, max))) - 1);
  const [t1, t2] = [10 ** k, 5 * 10 ** k];
  const bin = (v: number | null) => (v === null || v <= 0 ? 0 : v < t1 ? 1 : v < t2 ? 2 : 3);
  const unit = cat.labels[m].toLowerCase();
  const n = rKeys.length * cKeys.length;
  const tip = at === null ? null : { r: rKeys[Math.floor(at / cKeys.length)], c: cKeys[at % cKeys.length] };
  const id = (i: number) => `heat-${i}`;

  return (
    <div className="heat-wrap">
      <div
        role="grid"
        tabIndex={0}
        aria-label={`${cat.labels[m]} by ${cat.labels[dr]} and ${cat.labels[dc]}. Arrow keys walk the cells.`}
        aria-activedescendant={at === null ? undefined : id(at)}
        className="heat"
        style={{ gridTemplateColumns: `minmax(0, ${narrow ? "7.5rem" : "11rem"}) repeat(${cKeys.length}, minmax(0, 1fr)) ${narrow ? "" : "minmax(3rem, auto)"}` }}
        onKeyDown={(e) => setAt(walk(e, at, n, cKeys.length))}
        onBlur={() => setAt(null)}
        onPointerLeave={() => setAt(null)}
      >
        <div role="row" className="contents">
          <span role="columnheader" />
          {cKeys.map((c) => (
            <span key={c} role="columnheader" className="heat-col">
              {c !== OTHER && labels[dc]?.[c]?.race && <RaceIcon race={labels[dc][c].race!} size="18px" />}
              {!(narrow && labels[dc]?.[c]?.race) && <span>{words(dc, c, labels)}</span>}
            </span>
          ))}
          {!narrow && (
            <span role="columnheader" className="heat-col heat-total">
              Total
            </span>
          )}
        </div>
        {rKeys.map((r, i) => (
          <div key={r} role="row" className="contents">
            <span role="rowheader" className="heat-row">
              <Value d={dr} v={r} labels={labels} />
            </span>
            {cKeys.map((c, j) => {
              const v = cell(r, c);
              const idx = i * cKeys.length + j;
              return (
                <span
                  key={c}
                  id={id(idx)}
                  role="gridcell"
                  aria-label={`${words(dr, r, labels)}, ${words(dc, c, labels)}: ${fmtOr(v)} ${unit}`}
                  className={`heat-cell bin-${bin(v)} ${at === idx ? "on" : ""}`}
                  onPointerEnter={(e) => e.pointerType === "mouse" && setAt(idx)}
                  onPointerDown={() => setAt(idx)}
                >
                  {fmtOr(v)}
                  {at === idx && tip && (
                    <Tip value={`${fmtOr(v)} ${unit}`} label={`${words(dr, r, labels)}, ${words(dc, c, labels)}`} style={{ top: "calc(100% + 6px)", ...(j > cKeys.length / 2 ? { right: 0 } : { left: 0 }) }} />
                  )}
                </span>
              );
            })}
            {!narrow && <span className="heat-sum">{fmtOr(rowTotal(r))}</span>}
          </div>
        ))}
        {!narrow && (
          <div role="row" className="contents">
            <span role="rowheader" className="heat-sum heat-total text-right">
              Total
            </span>
            {cKeys.map((c) => (
              <span key={c} className="heat-sum text-center">
                {fmtOr(colTotal(c))}
              </span>
            ))}
            <span className="heat-sum font-bold">{fmt(total)}</span>
          </div>
        )}
      </div>
      <ul className="heat-legend" aria-label="Legend">
        <li className="font-bold">{cat.labels[m]}</li>
        {[
          [0, "0"],
          [1, t1 === 10 ? "1–9" : `1–${fmt(t1 - 1)}`],
          [2, `${fmt(t1)}–${fmt(t2 - 1)}`],
          [3, `${fmt(t2)} or more`],
        ].map(([b, l]) => (
          <li key={b}>
            <span aria-hidden className={`sw bin-${b}`} />
            {l}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One dimension and a count: horizontal bars in one gold step, the largest first, the top 12 and
 * Other, each value at its bar's tip. An ordered dimension (minutes) gets columns in its order.
 */
function Bars({ rows, d, m, cat, labels, columns, all }: { rows: Row[]; d: string; m: string; cat: Catalog; labels: Labels; columns: boolean; all: Row }) {
  const narrow = useNarrow();
  const [at, setAt] = useState<number | null>(null);
  const totals = sumBy(rows, (r) => String(r[d]), m);
  const F = columns ? { keep: orderValues(cat, d, totals), other: new Set<string>() } : fold(cat, d, totals, 13);
  // Other adds up the values it folds, or is null when a game can fall under two of them (a race, say)
  const other = addsUp(totals, all[m]) ? [...F.other].reduce((s, v) => s + totals.get(v)!, 0) : null;
  const marks: (readonly [string, number | null])[] = [...F.keep.map((v) => [v, totals.get(v)!] as const), ...(F.other.size ? [[OTHER, other] as const] : [])];
  const max = Math.max(1, ...marks.map(([, v]) => v ?? 0));
  // a share of the whole scope: a game counts under each value one of its players has
  const sum = Number(all[m] ?? 0);
  const unit = cat.labels[m].toLowerCase();
  const pct = (n: number) => `${sum ? Math.round((100 * n) / sum) : 0}%`;
  const TWO = "a game can fall under two of its values";
  const label = (v: string, n: number | null) => `${words(d, v, labels)}: ${fmtOr(n)} ${unit}, ${n === null ? TWO : pct(n)}`;
  const capLabels = !narrow || marks.length <= 10;
  return (
    <div
      role="list"
      tabIndex={0}
      aria-label={`${cat.labels[m]} by ${cat.labels[d]}. Arrow keys walk the ${columns ? "columns" : "bars"}.`}
      className={columns ? "cols" : "bars"}
      style={columns ? { gridTemplateColumns: `repeat(${marks.length}, minmax(0, 1fr))` } : undefined}
      onKeyDown={(e) => setAt(walk(e, at, marks.length))}
      onBlur={() => setAt(null)}
      onPointerLeave={() => setAt(null)}
    >
      {marks.map(([v, n], i) => (
        <div
          key={v}
          role="listitem"
          aria-label={label(v, n)}
          className={`mark ${at === i ? "on" : ""}`}
          onPointerEnter={(e) => e.pointerType === "mouse" && setAt(i)}
          onPointerDown={() => setAt(i)}
        >
          {columns ? (
            <>
              <span className="col-track">
                {capLabels && <span className="cap">{fmtOr(n)}</span>}
                <span className="col-fill" style={{ height: `${(100 * (n ?? 0)) / max}%` }} />
              </span>
              <span className="col-label">{words(d, v, labels).split("–")[0]}</span>
            </>
          ) : (
            <>
              <span className="bar-label">
                <Value d={d} v={v} labels={labels} />
              </span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `calc((100% - 3.5rem) * ${(n ?? 0) / max})` }} />
                <span className="tip-value">{fmtOr(n)}</span>
              </span>
            </>
          )}
          {at === i && <Tip value={`${fmtOr(n)} ${unit}`} label={`${words(d, v, labels)}, ${n === null ? TWO : `${pct(n)} of ${fmt(sum)}`}`} style={{ top: "calc(100% + 4px)", ...(columns && i > marks.length / 2 ? { right: 0 } : { left: columns ? 0 : "30%" }) }} />}
        </div>
      ))}
      {columns && <p className="col-axis">{cat.labels[d]}</p>}
    </div>
  );
}

/** The result card: the chart the view's form picks, the table of every row, the CSV and the SQL. */
export function Result(props: { view: View; cat: Catalog; rows: Row[]; totals: Totals; labels: Labels; title: string; chart: Chart; truncated: boolean; sql: string }) {
  const { view, cat, rows, labels, chart } = props;
  const pending = usePending();
  const narrow = useNarrow();
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const dims = dimsOf(view);
  const games = Number(props.totals.all.games ?? 0);
  // the table: every row, the first chosen count first, largest first
  const by = view.show.find((m) => cat.types[m] === "count") ?? view.show[0];
  const sorted = [...rows].sort((a, b) => measureValue(cat, by, b) - measureValue(cat, by, a));
  const shown = all ? sorted : sorted.slice(0, 10);
  // a phone shows four columns: the dimensions, then the measures in order, at least one; the CSV keeps all
  const phoneHides = (i: number) => i > 0 && dims.length + i >= 4;

  const copy = async () => {
    await navigator.clipboard.writeText(location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const csv = () => {
    const cell = (s: string | number) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
    const head = [...dims.map((d) => cat.labels[d]), ...view.show.flatMap((m) => (cat.types[m] === "record" ? [`${cat.labels[m]} wins`, `${cat.labels[m]} losses`] : [cat.labels[m]]))];
    const lines = sorted.map((r) => [
      ...dims.map((d) => words(d, String(r[d]), labels)),
      ...view.show.flatMap((m) => (cat.types[m] === "record" ? cat.parts[m].map((p) => (r[p] == null ? "" : Number(r[p]))) : [cat.types[m] === "average" ? measureValue(cat, m, r).toFixed(1) : Number(r[m] ?? 0)])),
    ]);
    const blob = new Blob([[head, ...lines].map((l) => l.map(cell).join(",")).join("\n") + "\n"], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${props.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  let figure: ReactNode = null;
  if (chart.form === "tiles")
    figure = (
      <div className="stats tiles">
        {view.show.map((m) => (
          <div key={m} className="stat">
            <span className="s-l">{cat.labels[m]}</span>
            <span className="s-v">{rows[0] ? measureText(cat, m, rows[0]) : "—"}</span>
            {rows[0] && mirrorsText(cat, m, rows[0]) && <span className="s-n">{mirrorsText(cat, m, rows[0])}</span>}
          </div>
        ))}
      </div>
    );
  else if (chart.form === "heat") figure = <HeatMap rows={rows} dr={dims[0]} dc={dims[1]} m={chart.measure!} cat={cat} labels={labels} totals={props.totals} />;
  else if (chart.form === "bars" || chart.form === "columns") figure = <Bars rows={rows} d={dims[0]} m={chart.measure!} cat={cat} labels={labels} columns={chart.form === "columns"} all={props.totals.all} />;

  return (
    <section className="card" aria-labelledby="result-title">
      <div className="bar">
        <h2 id="result-title">{props.title}</h2>
        <span className="chip bg-primary text-on-primary">
          {fmt(games)} {games === 1 ? "game" : "games"}
        </span>
        <span className="ml-auto flex gap-2">
          <button type="button" className="btn btn-line on-bar" onClick={copy} aria-label={copied ? "Copied the link" : "Copy link"}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
            </svg>
            <span className="max-sm:hidden">{copied ? "Copied" : "Copy link"}</span>
          </button>
          <button type="button" className="btn btn-line on-bar" onClick={csv} aria-label="Download CSV" disabled={!rows.length}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
            </svg>
            <span className="max-sm:hidden">CSV</span>
          </button>
        </span>
      </div>

      <div className={`transition-opacity ${pending ? "opacity-50" : ""}`} aria-busy={pending}>
        {!rows.length ? (
          <p className="p-8 text-center text-muted">No game matches. Remove a filter.</p>
        ) : (
          <>
            {figure && <div className={chart.form === "tiles" ? "" : "border-b p-4"}>{figure}</div>}
            <div className="overflow-x-auto">
              <table className="table x-table">
                <thead>
                  <tr>
                    {dims.map((d) => (
                      <th key={d} scope="col">
                        {cat.labels[d]}
                      </th>
                    ))}
                    {view.show.map((m, i) => (
                      <th key={m} scope="col" className={`text-right ${phoneHides(i) ? "max-sm:hidden" : ""}`}>
                        {cat.labels[m]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r, i) => (
                    <tr key={i}>
                      {dims.map((d) => (
                        <td key={d}>
                          <Value d={d} v={String(r[d])} labels={labels} iconOnly={narrow && d in RACE_DIMS} />
                        </td>
                      ))}
                      {view.show.map((m, i) => (
                        <td key={m} className={`text-right ${phoneHides(i) ? "max-sm:hidden" : ""}`}>
                          {/* a record breaks only before its percent */}
                          {measureText(cat, m, r)
                            .split(/ (?=\()/)
                            .map((part, k) => (
                              <Fragment key={k}>
                                {k > 0 && " "}
                                <span className="whitespace-nowrap">{part}</span>
                              </Fragment>
                            ))}
                          {mirrorsText(cat, m, r) && <span className="block text-xs text-muted">{mirrorsText(cat, m, r)}</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {view.show.some((m) => cat.notes[m]) && (
              <p className="border-t px-4 py-2.5 text-sm text-muted">
                {view.show.filter((m) => cat.notes[m]).map((m) => `${cat.labels[m]}: ${cat.notes[m][0].toLowerCase()}${cat.notes[m].slice(1)}.`).join(" ")}
              </p>
            )}
            {rows.length > 10 && (
              <div className="pager">
                <span>
                  {fmt(shown.length)} of {fmt(rows.length)} rows{props.truncated ? ", the first 10,000" : ""}
                </span>
                <button type="button" className="btn btn-line" onClick={() => setAll(!all)}>
                  {all ? "Show 10" : `Show all ${fmt(rows.length)}`}
                </button>
              </div>
            )}
          </>
        )}
      </div>
      <details className="border-t">
        <summary className="cursor-pointer px-4 py-3 text-sm text-muted">Show SQL</summary>
        <pre className="overflow-x-auto px-4 pb-4 text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{props.sql}</pre>
      </details>
    </section>
  );
}
