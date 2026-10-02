"use client";
import { useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useId, useOptimistic, useRef, useState, useTransition } from "react";
import type { Filters } from "@/lib/api";
import { BINS, type Catalog, RACE_DIMS, type ValueLabel, type View, viewHref } from "@/lib/explore";
import { RACES } from "@/lib/races";
import { fmt, RaceIcon, Tile } from "@/lib/ui";
import { loadValues } from "../actions";
import { RaceMenu } from "../RaceMenu";

/** The page's navigation: a change of view replaces the URL in a transition, and the result dims while it runs. */
const Nav = createContext<{ go: (v: View, also?: () => void) => void; pending: boolean }>({ go: () => {}, pending: false });
export const usePending = () => useContext(Nav).pending;

export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // `also` runs in the same transition, such as an optimistic update that holds until the page has read
  const go = (v: View, also?: () => void) =>
    start(() => {
      also?.();
      router.replace(viewHref(v), { scroll: false });
    });
  return <Nav.Provider value={{ go, pending }}>{children}</Nav.Provider>;
}

const G = { close: "M6 6l12 12M18 6L6 18", plus: "M12 5v14M5 12h14" };
function Glyph({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden className="shrink-0" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d={d} />
    </svg>
  );
}

/** A popover under its button that closes on Escape or a press outside. */
function Popover({ open, onClose, children, label }: { open: boolean; onClose: () => void; children: ReactNode; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!box.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={box} role="dialog" aria-label={label} className="pop race-menu q-pop" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      {children}
    </div>
  );
}

type Labels = Record<string, Record<string, ValueLabel>>;

/** What a filter reads as on its chip: "Race: Night Elf", "Minutes: 2 or more", "Map: Echo Isles 2.2 or 1 more". */
function filterWords(key: string, view: View, cat: Catalog, labels: Labels) {
  if (key in RACE_DIMS) return `${cat.labels[key]}: ${view.races[key].map((v) => RACES[v][0]).join(" or ")}`;
  if (key === BINS || key === "apm") {
    const [lo, hi] = key === BINS ? [view.ranges.min, view.ranges.max] : [view.ranges.apm_min, view.ranges.apm_max];
    const name = key === BINS ? "Minutes" : "APM";
    return `${name}: ${lo && hi ? `${lo} to ${hi}` : lo ? `${lo} or more` : `${hi} or less`}`;
  }
  const values = view.lists[key];
  const first = labels[key]?.[values[0]]?.label ?? values[0];
  return `${cat.labels[key]}: ${first}${values.length > 1 ? ` or ${values.length - 1} more` : ""}`;
}

/**
 * The query card: what to show, the rows and the column, the filters. Each change replaces the
 * URL, and the server page reads POST /query again.
 */
export function Query(props: { view: View; cat: Catalog; counts: Record<string, number>; labels: Labels; filters: Filters }) {
  const { view, cat } = props;
  const { go } = useContext(Nav);
  const [open, setOpen] = useState<string | null>(null); // the open popover: "rows", "cols", "add" or a filter key
  const close = () => setOpen(null);
  const dims = Object.keys(cat.labels).filter((d) => d in cat.dimensions);
  const used = [...view.rows, ...(view.cols ? [view.cols] : [])];
  const free = dims.filter((d) => !used.includes(d));
  const shown = Object.keys(cat.types).filter((m) => cat.labels[m]);

  const toggle = (m: string) => {
    const show = view.show.includes(m) ? view.show.filter((x) => x !== m) : shown.filter((x) => x === m || view.show.includes(x));
    if (show.length) go({ ...view, show });
  };
  // a second dimension goes to Columns, a third and more to Rows
  const addDim = (d: string, to: "rows" | "cols") => {
    close();
    if (to === "cols" || (view.rows.length === 1 && !view.cols)) go({ ...view, cols: d });
    else go({ ...view, rows: [...view.rows, d] });
  };

  // the filters set now, in a fixed order: races, lists, minutes, APM
  const set = [
    ...Object.keys(RACE_DIMS).filter((d) => view.races[d]?.length),
    ...Object.keys(view.lists),
    ...(view.ranges.min || view.ranges.max ? [BINS] : []),
    ...(view.ranges.apm_min || view.ranges.apm_max ? ["apm"] : []),
  ];
  const removeFilter = (key: string) => {
    close();
    if (key in RACE_DIMS) go({ ...view, races: { ...view.races, [key]: [] } });
    else if (key === BINS) go({ ...view, ranges: { ...view.ranges, min: undefined, max: undefined } });
    else if (key === "apm") go({ ...view, ranges: { ...view.ranges, apm_min: undefined, apm_max: undefined } });
    else go({ ...view, lists: Object.fromEntries(Object.entries(view.lists).filter(([d]) => d !== key)) });
  };
  // the filters that can be added: each labelled dimension once, the 5-minute bins as a minutes range, and APM
  const addable = [...dims.filter((d) => !set.includes(d)), ...(set.includes("apm") ? [] : ["apm"])];
  const filterName = (k: string) => (k === "apm" ? "APM" : cat.labels[k]);

  return (
    <section aria-label="Query" className="card q-card overflow-visible">
      <div className="q-row">
        <span className="q-label" id="q-show">
          Show
        </span>
        <div className="q-chips" role="group" aria-labelledby="q-show">
          {shown.map((m) => (
            <button key={m} type="button" className="q-chip q-toggle" aria-pressed={view.show.includes(m)} onClick={() => toggle(m)}>
              {cat.labels[m]}
            </button>
          ))}
        </div>
      </div>

      {(["rows", "cols"] as const).map((to) => {
        const chips = to === "rows" ? view.rows : view.cols ? [view.cols] : [];
        const label = to === "rows" ? "Rows" : "Columns";
        return (
          <div key={to} className="q-row">
            <span className="q-label" id={`q-${to}`}>
              {label}
            </span>
            <div className="q-chips" role="group" aria-labelledby={`q-${to}`}>
              {chips.map((d) => (
                <span key={d} className="q-chip q-set">
                  {cat.labels[d]}
                  <button
                    type="button"
                    className="q-x"
                    aria-label={`Remove ${cat.labels[d]} from ${label.toLowerCase()}`}
                    onClick={() => go(to === "rows" ? { ...view, rows: view.rows.filter((x) => x !== d) } : { ...view, cols: null })}
                  >
                    <Glyph d={G.close} />
                  </button>
                </span>
              ))}
              {(to === "rows" || !view.cols) && free.length > 0 && (
                <span className="relative">
                  <button type="button" className="q-chip q-add" aria-haspopup="dialog" aria-expanded={open === to} onClick={() => setOpen(open === to ? null : to)}>
                    <Glyph d={G.plus} />
                    {to === "rows" ? "Add" : "Add a column"}
                  </button>
                  <Popover open={open === to} onClose={close} label={`Add to ${label.toLowerCase()}`}>
                    <ul className="q-list">
                      {free.map((d, i) => (
                        <li key={d}>
                          <button type="button" className="opt" autoFocus={i === 0} onClick={() => addDim(d, to)}>
                            {cat.labels[d]}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </Popover>
                </span>
              )}
            </div>
          </div>
        );
      })}

      <div className="q-row">
        <span className="q-label" id="q-filters">
          Filters
        </span>
        <div className="q-chips" role="group" aria-labelledby="q-filters">
          {set.map((k) => (
            <span key={k} className="relative">
              <span className="q-chip q-set">
                <button type="button" className="q-open" aria-haspopup="dialog" aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)}>
                  {k in RACE_DIMS && <RaceIcon race={view.races[k][0]} size="16px" />}
                  {filterWords(k, view, cat, props.labels)}
                </button>
                <button type="button" className="q-x" aria-label={`Remove the ${filterName(k)} filter`} onClick={() => removeFilter(k)}>
                  <Glyph d={G.close} />
                </button>
              </span>
              <Popover open={open === k} onClose={close} label={`${filterName(k)} filter`}>
                <FilterEditor k={k} {...props} />
              </Popover>
            </span>
          ))}
          <span className="relative">
            <button type="button" className="q-chip q-add q-dashed" aria-haspopup="dialog" aria-expanded={open === "add"} onClick={() => setOpen(open === "add" ? null : "add")}>
              <Glyph d={G.plus} />
              Add filter
            </button>
            <Popover open={open === "add"} onClose={close} label="Add filter">
              <ul className="q-list">
                {addable.map((k, i) => (
                  <li key={k}>
                    <button type="button" className="opt" autoFocus={i === 0} onClick={() => setOpen(k)}>
                      {filterName(k)}
                    </button>
                  </li>
                ))}
              </ul>
            </Popover>
          </span>
          {/* a filter picked from Add filter opens its editor before it holds a value */}
          {open && !set.includes(open) && addable.includes(open) && (
            <span className="relative">
              <Popover open onClose={close} label={`${filterName(open)} filter`}>
                <FilterEditor k={open} {...props} />
              </Popover>
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

/** The editor of one filter: the race menu, a minutes or APM range, or a checklist of values with a search. */
function FilterEditor(props: { k: string; view: View; cat: Catalog; counts: Record<string, number>; filters: Filters }) {
  const { k, view, cat } = props;
  const { go } = useContext(Nav);
  const id = useId();
  if (k in RACE_DIMS)
    return (
      <div className="w-64 p-1">
        <RaceMenu label={cat.labels[k]} value={view.races[k] ?? []} counts={props.counts} onChange={(race) => go({ ...view, races: { ...view.races, [k]: race } })} />
      </div>
    );
  if (k === BINS || k === "apm") {
    const [lo, hi] = k === BINS ? (["min", "max"] as const) : (["apm_min", "apm_max"] as const);
    const commit = (key: typeof lo | typeof hi, v: string) => go({ ...view, ranges: { ...view.ranges, [key]: v && Number(v) >= 0 ? v : undefined } });
    return (
      <div role="group" aria-labelledby={`${id}-r`} className="flex flex-col gap-1 p-2 text-sm">
        <span id={`${id}-r`} className="text-muted">
          {k === BINS ? "Minutes" : "APM"}
        </span>
        <div className="range">
          {([lo, hi] as const).map((key, i) => (
            <input
              key={key}
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              className="field"
              placeholder={i ? "to" : "from"}
              aria-label={`${k === BINS ? "Minutes" : "APM"} ${i ? "to" : "from"}`}
              defaultValue={view.ranges[key] ?? ""}
              autoFocus={i === 0}
              onBlur={(e) => e.target.value !== (view.ranges[key] ?? "") && commit(key, e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && commit(key, e.currentTarget.value)}
            />
          ))}
        </div>
      </div>
    );
  }
  return <Checklist {...props} />;
}

/** A list dimension's values in scope, most games first, each with a box; the search narrows them by name. */
function Checklist({ k, view, cat, filters }: { k: string; view: View; cat: Catalog; filters: Filters }) {
  const { go } = useContext(Nav);
  const [values, setValues] = useState<{ value: string; label: string; icon: string | null; games: number }[] | null>(null);
  const [q, setQ] = useState("");
  // the scope without this filter, so every value can be checked; read again only when it changes
  const scope = JSON.stringify(Object.fromEntries(Object.entries(filters).filter(([d]) => d !== k)));
  useEffect(() => {
    let live = true;
    loadValues(k, JSON.parse(scope)).then((v) => live && setValues(v));
    return () => {
      live = false;
    };
  }, [k, scope]);
  // a box shows its new state at once, while the page reads the new view
  const [checked, setChecked] = useOptimistic(view.lists[k] ?? []);
  const flip = (v: string) => {
    const next = checked.includes(v) ? checked.filter((x) => x !== v) : [...checked, v];
    const lists = { ...view.lists, [k]: next };
    if (!next.length) delete lists[k];
    go({ ...view, lists }, () => setChecked(next));
  };
  const t = q.trim().toLowerCase();
  const shown = (values ?? []).filter((v) => !t || v.label.toLowerCase().includes(t));
  return (
    <div className="flex w-72 max-w-full flex-col gap-2 p-1">
      <input type="search" className="field" placeholder="Find by name" aria-label={`Find a ${cat.labels[k].toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {values === null ? (
        <p className="px-2 py-1 text-sm text-muted">Loading…</p>
      ) : (
        <ul className="picker-list" aria-label={cat.labels[k]}>
          {shown.map((v) => (
            <li key={v.value}>
              <label className="opt">
                <input type="checkbox" className="check" checked={checked.includes(v.value)} onChange={() => flip(v.value)} />
                {v.icon !== undefined && v.icon !== null && <Tile icon={v.icon} size={20} />}
                <span className="min-w-0 truncate">{v.label}</span>
                <span className="opt-count">{fmt(v.games)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
