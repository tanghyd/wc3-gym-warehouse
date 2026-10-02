// The Explore page's state in the URL, the chart it picks, and how a measure reads from a row.
import { PICKED, RACES, RANDOM_OF, raceFilters } from "./races";
import { mirrorsLine, mss, record } from "./ui";

/** What GET /catalog says of player_games: column types, labels, and each measure's type and parts. */
export type Catalog = {
  dimensions: Record<string, string>;
  measures: string[];
  labels: Record<string, string>;
  types: Record<string, "count" | "distinct" | "record" | "average">;
  parts: Record<string, string[]>;
  notes: Record<string, string>;
};

/** A row of POST /query after the page reads it: dimension values as text, measure parts as numbers, null wins and losses when every game is a mirror. */
export type Row = Record<string, string | number | null>;
/**
 * A view's figures over its whole scope (all), and per value of a heat map's row and of its column
 * dimension. A game counts once in a row, so a game whose players fall in two rows counts in both:
 * a total is read on its own, never added up from the rows.
 */
export type Totals = { all: Row; rows: Row[]; cols: Row[] };

/** The race dimensions, each with the flag column that makes its value a race value such as RN. */
export const RACE_DIMS: Record<string, string> = { race: "random", opponent_race: "opponent_random" };
/** The page's range filters: URL keys, the column, and the factor from what the reader types. */
export const RANGES = { min: ["duration_ms", 60000], max: ["duration_ms", 60000], apm_min: ["apm", 1], apm_max: ["apm", 1] } as const;
/** The 5-minute bins are filtered as a range of minutes on the exact game length. */
export const BINS = "minutes_5";

export const DEFAULT_SHOW = ["games", "record", "avg_minutes"];
const DEFAULT_ROWS = ["race"];
const DEFAULT_COLS = "opponent_race";
export const DEFAULT_MIN = "2";

/** One view of the page: what to show, the rows, the column, the filters. Every key round-trips through the URL. */
export type View = {
  show: string[];
  rows: string[];
  cols: string | null;
  races: Record<string, string[]>;
  lists: Record<string, string[]>;
  ranges: Partial<Record<keyof typeof RANGES, string>>;
};

type Search = Record<string, string | string[] | undefined>;

/** The view of a URL. A missing key takes its default; an empty one (rows=, min=) means none. */
export function readView(sp: Search, cat: Catalog): View {
  const one = (k: string) => (typeof sp[k] === "string" ? sp[k] : Array.isArray(sp[k]) ? sp[k][0] : undefined);
  const list = (k: string) => (one(k) ?? "").split(",").filter(Boolean);
  const isDim = (d: string) => d in cat.dimensions && d in cat.labels;
  const show = sp.show === undefined ? DEFAULT_SHOW : list("show").filter((m) => cat.types[m]);
  const rows = sp.rows === undefined && sp.cols === undefined ? DEFAULT_ROWS : [...new Set(list("rows").filter(isDim))];
  const col = sp.rows === undefined && sp.cols === undefined ? DEFAULT_COLS : one("cols");
  const races = Object.fromEntries(Object.keys(RACE_DIMS).map((d) => [d, list(d).filter((v) => RACES[v])]));
  const lists: Record<string, string[]> = {};
  for (const d of Object.keys(cat.labels)) {
    if (!isDim(d) || d in RACE_DIMS || d === BINS) continue;
    const values = [sp[d] ?? []].flat().filter((v) => v !== undefined);
    if (values.length) lists[d] = [...new Set(values)].slice(0, 100);
  }
  const ranges: View["ranges"] = {};
  for (const k of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
    const v = k === "min" && sp.min === undefined ? DEFAULT_MIN : one(k);
    if (v && Number.isFinite(Number(v)) && Number(v) >= 0) ranges[k] = v;
  }
  return { show: show.length ? show : ["games"], rows, cols: col && isDim(col) && !rows.includes(col) ? col : null, races, lists, ranges };
}

/** The URL of a view: every key written, so a default the reader removed stays removed. */
export function viewHref(v: View) {
  const q = new URLSearchParams();
  q.set("show", v.show.join(","));
  q.set("rows", v.rows.join(","));
  if (v.cols) q.set("cols", v.cols);
  for (const [d, values] of Object.entries(v.races)) if (values.length) q.set(d, values.join(","));
  for (const [d, values] of Object.entries(v.lists)) for (const value of values) q.append(d, value);
  q.set("min", v.ranges.min ?? "");
  for (const k of ["max", "apm_min", "apm_max"] as const) if (v.ranges[k]) q.set(k, v.ranges[k]!);
  return `/explore?${q}`;
}

/** The dimensions of a view, rows first then the column. */
export const dimsOf = (v: View) => [...v.rows, ...(v.cols ? [v.cols] : [])];

/** The measures POST /query reads for the shown ones: each one's parts or itself, games for the total, and mirrors beside a record. */
export const queryMeasures = (v: View, cat: Catalog) => {
  const mirrors = v.show.some((m) => cat.types[m] === "record") && cat.measures.includes("mirrors") ? ["mirrors"] : [];
  return [...new Set(["games", ...v.show.flatMap((m) => cat.parts[m] ?? [m]), ...mirrors])];
};

/** Whether a dimension has an order of its own, so its values are not sorted by count. */
export const ordered = (cat: Catalog, d: string) => /^(U?Int|Float)/.test(cat.dimensions[d] ?? "");

/** The chart the view gets: tiles with no dimension, bars or columns for one, a heat map for two, else none. */
export function chartOf(v: View, cat: Catalog): { form: "tiles" | "bars" | "columns" | "heat" | "none"; measure: string | null } {
  const dims = dimsOf(v);
  if (!dims.length) return { form: "tiles", measure: null };
  // only a count takes a mark: a record and an average read in the table
  const measure = v.show.find((m) => cat.types[m] === "count") ?? null;
  if (!measure || dims.length > 2) return { form: "none", measure };
  if (dims.length === 2) return { form: "heat", measure };
  return { form: ordered(cat, dims[0]) ? "columns" : "bars", measure };
}

/** A measure's value in a row as text: a count with commas, a record, an average as m:ss or a whole number. */
export function measureText(cat: Catalog, m: string, row: Row) {
  const n = (k: string) => Number(row[k] ?? 0);
  const type = cat.types[m];
  // a record is null when every game of the row is a mirror
  if (type === "record") return row[cat.parts[m][0]] == null || row[cat.parts[m][1]] == null ? "—" : record(n(cat.parts[m][0]), n(cat.parts[m][1]));
  if (type === "average") {
    const [total, count] = cat.parts[m];
    if (!n(count)) return "—";
    const avg = n(total) / n(count);
    return total === "minutes_total" ? mss(avg * 60000) : Math.round(avg).toLocaleString("en-US");
  }
  return Math.round(n(m)).toLocaleString("en-US");
}

/** Under a record: the row's mirrors (games with both players in the row), which add no win or loss. */
export function mirrorsText(cat: Catalog, m: string, row: Row) {
  const k = Number(row.mirrors ?? 0);
  return cat.types[m] === "record" && k > 0 ? mirrorsLine(k) : null;
}

/** A measure's value for sorting and the CSV: a record's win share, an average's value. */
export function measureValue(cat: Catalog, m: string, row: Row) {
  const n = (k: string) => Number(row[k] ?? 0);
  const p = cat.parts[m];
  if (cat.types[m] === "record") return n(p[0]) + n(p[1]) ? n(p[0]) / (n(p[0]) + n(p[1])) : 0;
  if (cat.types[m] === "average") return n(p[1]) ? n(p[0]) / n(p[1]) : 0;
  return n(m);
}

/** The race values in the order of every menu, column and legend. */
export const RACE_ORDER = [...PICKED, ...PICKED.map((r) => RANDOM_OF[r]), "R"];

/** "Title Case" of a label, for a card title that names the view. */
export const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** "A", "A and B", "A, B and C". */
export const andList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** How one value of a dimension shows: its words, and an object icon or a race value. */
export type ValueLabel = { label: string; icon?: string | null; race?: string };

/** The player_games filters of a view: race values, checked values and the ranges. */
export function viewFilters(v: View) {
  const f: Record<string, (string | number)[] | { gte?: number; lte?: number }> = {};
  for (const [d, flag] of Object.entries(RACE_DIMS)) Object.assign(f, raceFilters(v.races[d] ?? [], d, flag));
  for (const [d, values] of Object.entries(v.lists)) f[d] = values;
  for (const [k, value] of Object.entries(v.ranges)) {
    const [column, factor] = RANGES[k as keyof typeof RANGES];
    const range = (f[column] ??= {}) as { gte?: number; lte?: number };
    range[k.endsWith("min") ? "gte" : "lte"] = Number(value) * factor;
  }
  return f;
}
