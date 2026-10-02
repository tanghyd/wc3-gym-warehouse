"use client";
import { type ReactNode, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Filters } from "@/lib/api";
import {
  encodeGroups,
  HALLS,
  KINDS,
  type Kind,
  countWords,
  kindWord,
  MAX_GROUPS,
  MAX_STEPS,
  MAX_WITHIN,
  newStep,
  parseMss,
  played,
  type Step,
  timeWords,
} from "@/lib/steps";
import { RaceIcon, Tile } from "@/lib/ui";
import { type Pick, Picker } from "./Picker";
import { RaceMenu } from "./RaceMenu";

/** A step on screen: the URL step, its name and icon, and a key for React. */
export type DraftStep = Step & { key: number; name: string; icon: string | null };
export type Opened = { code: string; name: string; icon: string | null };
/** One side as the page reads it from the URL. */
export type SideState = { race: string[]; name: string; outcome: "" | "won" | "lost"; groups: DraftStep[][]; opened: Opened[] };
/** A strategy preset a side can load: its whole group as steps with their names and icons. */
export type LoadPreset = { id: string; name: string; race: string; depth: number; steps: (Step & { name: string; icon: string | null })[] };
type Who = "player" | "opponent";
type Halls = Record<string, { name: string; icon: string | null }>;

// The URL keys of each side.
const KEYS = {
  player: { race: "race", name: "player", steps: "steps", opened: "opened" },
  opponent: { race: "opponent_race", name: "opp_player", steps: "opp_steps", opened: "opp_opened" },
} as const;
const OUTCOMES = [
  ["", "Any"],
  ["won", "Won"],
  ["lost", "Lost"],
] as const;
const NTH = [
  [null, "Any"],
  [1, "1st"],
  [2, "2nd"],
  [3, "3rd"],
] as const;

const G = {
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  close: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  clock: "M12 9.5v4l2.5 2M9.5 3h5M12 6a7.5 7.5 0 1 0 0 15a7.5 7.5 0 1 0 0-15",
  right: "M9 6l6 6-6 6",
  swapH: "M7 7h12l-3-3M17 17H5l3 3",
  swapV: "M7 4v14l-3-3M17 20V6l3 3",
};
function Glyph({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden className="shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

const mss = (s: number | null) => (s === null ? "" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
// The API's bound on a step count.
const MAX_COUNT = 9;

/** A step's count as a typed whole number; blank or 0 is 1 again on blur, past 9 is 9. */
function CountField({ value, labelledBy, onChange }: { value: number; labelledBy: string; onChange: (n: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      className="field w-14 text-center"
      inputMode="numeric"
      aria-labelledby={labelledBy}
      value={text ?? String(value)}
      // the first click selects the count, so a typed digit replaces it
      onMouseDown={(e) => {
        if (document.activeElement === e.currentTarget) return;
        e.preventDefault();
        e.currentTarget.focus();
      }}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        const t = e.target.value.replace(/\D/g, "").slice(0, 2);
        setText(t);
        if (Number(t) >= 1 && Number(t) <= MAX_COUNT) onChange(Number(t));
      }}
      onBlur={() => {
        if (text === null) return;
        setText(null);
        onChange(Math.min(MAX_COUNT, Number(text) || 1));
      }}
    />
  );
}

/** The format line under a time field, or the fix while its text is no time. */
function TimeHint({ id, bad, max }: { id: string; bad: boolean; max?: number }) {
  return (
    <span id={id} aria-live="polite" className={bad ? "" : "text-muted"}>
      {bad ? `Not a time. Type m:ss, such as 2:30, or seconds${max ? `, up to ${mss(max)}` : ""}.` : "m:ss, such as 2:30, or seconds"}
    </span>
  );
}

/** A time typed as m:ss, mm:ss or seconds; on blur it reads back as m:ss, or `onBad` flags text that is no time. */
function TimeField(props: { label: string; value: number | null; bad: boolean; hintId: string; required?: boolean; ok?: (s: number) => boolean; onChange: (s: number | null) => void; onBad: (bad: boolean) => void }) {
  const [text, setText] = useState<string | null>(null);
  const read = (t: string) => {
    const s = parseMss(t);
    return s !== null && (props.ok?.(s) ?? true) ? s : null;
  };
  return (
    <input
      className="field w-20"
      placeholder="m:ss"
      aria-label={props.label}
      aria-invalid={props.bad || undefined}
      aria-describedby={props.hintId}
      value={text ?? mss(props.value)}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        const s = read(t);
        if (s !== null) props.onChange(s);
        else if (!t.trim() && !props.required) props.onChange(null);
        if (s !== null || !t.trim()) props.onBad(false);
      }}
      onBlur={() => {
        if (text === null) return;
        if (read(text) !== null || !text.trim()) setText(null);
        else props.onBad(true);
      }}
    />
  );
}

/** Whether a step may be the step a "before" step names: another step of the group that happened. */
const anchorable = (group: Step[], i: number, before: number) => before !== i + 1 && before <= group.length && !group[before - 1].negate && group[before - 1].before === null;

/**
 * A group made sound: "before" names another step that happened, a negated step has no exact
 * count, and the first step and a step under "did not happen" or "before" follow nothing.
 */
function sound(group: DraftStep[]) {
  const named = group.map((s, i) => ({ ...s, before: s.before !== null && anchorable(group, i, s.before) ? s.before : null, exactly: s.exactly && !s.negate }));
  return named.map((s, i) => {
    const free = (x: DraftStep) => !x.negate && x.before === null;
    const then = s.link === "then" && i > 0 && free(named[i - 1]) && free(s);
    return { ...s, link: then ? "then" : "and", within: then ? s.within : null } as DraftStep;
  });
}

/** The group with step i moved to j, or removed when j is null, its "before" numbers following the steps they name. */
function renumber(group: DraftStep[], i: number, j: number | null) {
  const order = group.map((_, k) => k);
  order.splice(i, 1);
  if (j !== null) order.splice(j, 0, i);
  const at = new Map(order.map((k, n) => [k + 1, n + 1]));
  return order.map((k) => ({ ...group[k], before: group[k].before === null ? null : (at.get(group[k].before!) ?? null) }));
}

/**
 * The two sides of a search, Player and Opponent: race, battle tag, the Player's outcome, the
 * openers from the Openers tab of Strategies, and steps in groups of which any may hold. Swap trades the sides and
 * searches again. Each side writes its fields to the page's GET form.
 */
export function Sides(props: { player: SideState; opponent: SideState; counts: Record<string, number>; scope: Filters; halls: Halls; nextKey: number; presets: LoadPreset[] }) {
  const [sides, setSides] = useState({ player: props.player, opponent: props.opponent });
  const root = useRef<HTMLElement>(null);
  const keys = useRef(props.nextKey);
  const set = (who: Who) => (patch: Partial<SideState>) => setSides((s) => ({ ...s, [who]: { ...s[who], ...patch } }));
  const swap = () => {
    const flip = { won: "lost", lost: "won", "": "" } as const;
    flushSync(() => setSides((s) => ({ player: { ...s.opponent, outcome: flip[s.player.outcome] }, opponent: { ...s.player, outcome: "" } })));
    root.current?.closest("form")?.requestSubmit();
  };

  return (
    <section ref={root} aria-label="Sides" className="card versus overflow-visible">
      <Side who="player" side={sides.player} set={set("player")} counts={props.counts} scope={props.scope} halls={props.halls} presets={props.presets} nextKey={() => keys.current++} />
      <div className="swap">
        <button type="button" className="swap-btn" aria-label="Swap sides" title="Swap sides" onClick={swap}>
          <span className="h">
            <Glyph d={G.swapH} size={20} />
          </span>
          <span className="v">
            <Glyph d={G.swapV} size={20} />
          </span>
        </button>
      </div>
      <Side who="opponent" side={sides.opponent} set={set("opponent")} counts={props.counts} scope={props.scope} halls={props.halls} presets={props.presets} nextKey={() => keys.current++} />
    </section>
  );
}

function Side(props: {
  who: Who;
  side: SideState;
  set: (patch: Partial<SideState>) => void;
  counts: Record<string, number>;
  scope: Filters;
  halls: Halls;
  presets: LoadPreset[];
  nextKey: () => number;
}) {
  const { who, side, set } = props;
  const id = useId();
  const k = KEYS[who];
  const title = who === "player" ? "Player" : "Opponent";
  const [editing, setEditing] = useState<{ key: number; before: DraftStep } | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
  const [adding, setAdding] = useState<number | null>(null); // the group whose kind menu is open
  const [loading, setLoading] = useState(false); // the Load a strategy menu is open
  const groups = side.groups.length ? side.groups : [[]];
  const races = played(side.race);
  const steps = encodeGroups(side.groups);
  // the presets of the side's race, or every preset when it has none; loading one replaces the steps
  const loadable = races.length ? props.presets.filter((p) => races.includes(p.race)) : props.presets;
  const load = (p: LoadPreset) => {
    set({ groups: [p.steps.map((st) => ({ ...st, key: props.nextKey() }))], ...(!side.race.length && { race: [p.race] }) });
    setLoading(false);
    focus(`${id}-add`);
  };

  const setGroups = (gs: DraftStep[][]) => set({ groups: gs.map(sound) });
  const change = (key: number, patch: Partial<DraftStep>) => setGroups(groups.map((g) => g.map((s) => (s.key === key ? { ...s, ...patch } : s))));
  const focus = (target: string) => requestAnimationFrame(() => document.getElementById(target)?.focus());
  const stepId = (key: number) => `${id}-step-${key}`;

  /** Expanded names the side's town hall: one race's, or any. */
  const hall = () => {
    const h = races.length === 1 ? props.halls[HALLS[races[0]]] : null;
    return h ? { name: h.name, icon: h.icon } : { name: "Any expansion", icon: null };
  };
  const add = (gi: number, kind: Kind) => {
    const key = props.nextKey();
    const step: DraftStep = { ...newStep(kind), key, ...(kind === "expand" ? hall() : { name: "", icon: null }) };
    setGroups(groups.map((g, i) => (i === gi ? [...g, step] : g)));
    setAdding(null);
    if (kind === "expand") setEditing({ key, before: step });
    else setPicking(key);
  };
  const remove = (key: number) => {
    const at = (g: DraftStep[]) => g.findIndex((s) => s.key === key);
    setGroups(groups.map((g) => (at(g) < 0 ? g : renumber(g, at(g), null))).filter((g, i, all) => g.length || all.length === 1));
    setEditing(null);
    setPicking(null);
    focus(`${id}-add`);
  };
  const move = (gi: number, i: number, by: -1 | 1) => {
    setGroups(groups.map((x, j) => (j === gi ? renumber(x, i, i + by) : x)));
  };
  const pick = (key: number, p: Pick) => {
    change(key, { codes: p.source ? [`@${p.source}`] : p.codes, name: p.name, icon: p.icon });
    setPicking(null);
    const s = groups.flat().find((x) => x.key === key);
    // a new step goes on to its settings
    if (s && !s.codes.length) setEditing({ key, before: { ...s, codes: p.codes, name: p.name, icon: p.icon } });
    else focus(stepId(key));
  };
  const cancelPick = (key: number) => {
    setPicking(null);
    const s = groups.flat().find((x) => x.key === key);
    if (s && !s.codes.length) remove(key);
    else focus(stepId(key));
  };

  return (
    <div className="side" role="region" aria-labelledby={`${id}-title`}>
      <div className="bar">
        <h2 id={`${id}-title`}>{title}</h2>
        {side.race[0] && <RaceIcon race={side.race[0]} size="22px" />}
      </div>
      <div className="side-body">
        <div className="pair">
          <RaceMenu label="Race" value={side.race} onChange={(race) => set({ race })} counts={props.counts} />
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="flex min-h-5 items-center text-muted">Player</span>
            <input name={side.name ? k.name : undefined} list="players" placeholder="Any player" autoComplete="off" className="field" value={side.name} onChange={(e) => set({ name: e.target.value })} />
          </label>
        </div>
        {who === "player" && (
          <fieldset>
            <legend className="mb-1 text-sm text-muted">Outcome</legend>
            <div className="inline-flex rounded-[0.35rem] border">
              {OUTCOMES.map(([v, label]) => (
                <label key={v} className="seg">
                  <input type="radio" name="result" value={v} checked={side.outcome === v} onChange={() => set({ outcome: v })} className="sr-only" />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {side.opened.length > 0 && (
          <div className="flex flex-col gap-1 text-sm">
            <span id={`${id}-opened`} className="text-muted">
              Opened with
            </span>
            <div role="group" aria-labelledby={`${id}-opened`} className="qual w-fit gap-1.5 py-1 pr-1 [height:auto]">
              {side.opened.map((o, i) => (
                <Tile key={i} icon={o.icon} size={22} alt={o.name} />
              ))}
              <button type="button" className="icon-btn h-6 w-6" aria-label="Remove the opener" onClick={() => set({ opened: [] })}>
                <Glyph d={G.close} size={16} />
              </button>
            </div>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <div className="relative flex min-h-5 items-center justify-between gap-3 text-sm">
            <span id={`${id}-steps`} className="text-muted">
              Steps
            </span>
            <button type="button" className="text-primary-text" aria-haspopup="menu" aria-expanded={loading} onClick={() => setLoading(!loading)}>
              Load a strategy
            </button>
            {loading && (
              <ul role="menu" aria-label="Strategies" className="pop race-menu q-list right-0 left-auto" onKeyDown={(e) => e.key === "Escape" && setLoading(false)}>
                {loadable.map((p, i) => (
                  <li key={p.id} role="none">
                    <button type="button" role="menuitem" className="opt" autoFocus={i === 0} style={{ paddingLeft: 8 + p.depth * 16 }} onClick={() => load(p)}>
                      {!races.length && !p.depth && <RaceIcon race={p.race} size="18px" />}
                      {p.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {groups.map((group, gi) => {
            const alone = groups.length === 1;
            return (
              <div key={gi}>
                {gi > 0 && <div className="or">or</div>}
                <div className={alone ? "" : "alt"} role={alone ? undefined : "group"} aria-label={alone ? undefined : `Alternative ${gi + 1}`}>
                  {group.length > 0 && (
                    <ol aria-labelledby={`${id}-steps`} className="steps">
                      {group.map((s, i) => (
                        <StepLine
                          key={s.key}
                          s={s}
                          i={i}
                          group={group}
                          domId={stepId(s.key)}
                          editing={editing?.key === s.key}
                          picking={picking === s.key}
                          onEdit={() => setEditing(editing?.key === s.key ? null : { key: s.key, before: s })}
                          onLink={(link) => change(s.key, { link, within: null })}
                          onChange={(patch) => change(s.key, patch)}
                          onMove={(by) => move(gi, i, by)}
                          onRemove={() => remove(s.key)}
                          onPicker={() => setPicking(s.key)}
                          onCancel={() => {
                            if (editing) change(s.key, editing.before);
                            setEditing(null);
                            focus(stepId(s.key));
                          }}
                          onDone={() => {
                            setEditing(null);
                            focus(stepId(s.key));
                          }}
                          picker={
                            s.kind !== "expand" && (
                              <Picker
                                label={`Objects for step ${i + 1}`}
                                kind={KINDS[s.kind].picker!}
                                race={side.race}
                                filters={props.scope}
                                nth={s.nth}
                                onNth={s.kind === "hero" ? (nth) => change(s.key, { nth }) : undefined}
                                groupPick
                                onPick={(p) => pick(s.key, p)}
                                onClose={() => cancelPick(s.key)}
                              />
                            )
                          }
                        />
                      ))}
                    </ol>
                  )}
                  <div className="relative mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
                    <button
                      type="button"
                      id={gi === 0 ? `${id}-add` : undefined}
                      className="btn btn-line"
                      aria-haspopup="menu"
                      aria-expanded={adding === gi}
                      disabled={group.length >= MAX_STEPS}
                      onClick={() => setAdding(adding === gi ? null : gi)}
                    >
                      <Glyph d={G.plus} size={16} />
                      Add step
                    </button>
                    {gi === groups.length - 1 && groups.length < MAX_GROUPS && group.length > 0 && (
                      <button
                        type="button"
                        className="btn-quiet"
                        onClick={() => {
                          setGroups([...groups, []]);
                          setAdding(groups.length);
                        }}
                      >
                        Add alternative
                      </button>
                    )}
                    {!alone && group.length === 0 && (
                      <button type="button" className="btn-quiet" onClick={() => setGroups(groups.filter((_, j) => j !== gi))}>
                        Remove alternative
                      </button>
                    )}
                    {adding === gi && (
                      <ul
                        role="menu"
                        aria-label="Step kinds"
                        className="pop race-menu"
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setAdding(null);
                        }}
                      >
                        {(Object.keys(KINDS) as Kind[]).map((kind, j) => (
                          <li key={kind} role="none">
                            <button type="button" role="menuitem" className="opt" autoFocus={j === 0} onClick={() => add(gi, kind)}>
                              {KINDS[kind].label}
                              <span className="ml-auto text-muted">
                                <Glyph d={G.right} size={16} />
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {side.race.length > 0 && <input type="hidden" name={k.race} value={side.race.join(",")} />}
      {steps && <input type="hidden" name={k.steps} value={steps} />}
      {side.opened.length > 0 && <input type="hidden" name={k.opened} value={side.opened.map((o) => o.code).join(".")} />}
    </div>
  );
}

/** One step: its line, the and/then switch above it, its settings and its picker. */
function StepLine(props: {
  s: DraftStep;
  i: number;
  group: DraftStep[];
  domId: string;
  editing: boolean;
  picking: boolean;
  picker: ReactNode;
  onEdit: () => void;
  onLink: (link: "and" | "then") => void;
  onChange: (patch: Partial<DraftStep>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  onPicker: () => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { s, i, group } = props;
  const n = i + 1;
  const time = timeWords(s);
  const name = (s.name || "Pick an object") + countWords(s);
  const aboveNegated = i > 0 && group[i - 1].negate;
  // a step that did not happen or comes before another step links to no other step
  const unlinked = aboveNegated || s.negate || (i > 0 && group[i - 1].before !== null) || s.before !== null;
  const unlinkedWhy = aboveNegated || s.negate ? "A step that did not happen has no order" : "A step before another step links to no other step";
  const belowThen = i + 1 < group.length && group[i + 1].link === "then";
  const id = useId();
  // a time field whose text is no time
  const [bad, setBad] = useState({ from: false, to: false, within: false });
  return (
    <>
      {i > 0 && (
        <li className="link" aria-label={`Step ${n} after step ${i}`}>
          <span className="seg-xs" role="group" aria-label={`Link of step ${n}`}>
            <button type="button" aria-pressed={s.link === "and"} onClick={() => props.onLink("and")}>
              and
            </button>
            <button type="button" aria-pressed={s.link === "then"} disabled={unlinked} title={unlinked ? unlinkedWhy : undefined} onClick={() => props.onLink("then")}>
              {s.link === "then" && s.within !== null ? `then within ${mss(s.within)}` : "then"}
            </button>
          </span>
        </li>
      )}
      <li className="step">
        <span className="num" aria-hidden>
          {n}
        </span>
        <button type="button" id={props.domId} className="step-main" aria-expanded={props.editing} aria-label={`Step ${n}: ${kindWord(s)} ${name}`} onClick={props.onEdit}>
          <Tile icon={s.icon} size={36} />
          <span className="st">
            <span className="kind">{kindWord(s)}</span>
            <span className="obj">{name}</span>
          </span>
        </button>
        <span className="quals">
          {time && (
            <span className="qual">
              <span className="text-muted">
                <Glyph d={G.clock} size={14} />
              </span>
              {time}
            </span>
          )}
          {s.forward && <span className="qual">Forward</span>}
          {s.before !== null && <span className="qual">Before step {s.before}</span>}
          {s.negate && <span className="qual">Did not happen</span>}
        </span>
        <span className="tools">
          <button type="button" className="icon-btn move" aria-label={`Move step ${n} up`} disabled={i === 0} onClick={() => props.onMove(-1)}>
            <Glyph d={G.up} />
          </button>
          <button type="button" className="icon-btn move" aria-label={`Move step ${n} down`} disabled={i === group.length - 1} onClick={() => props.onMove(1)}>
            <Glyph d={G.down} />
          </button>
          <button type="button" className="icon-btn" aria-label={`Remove step ${n}`} onClick={props.onRemove}>
            <Glyph d={G.close} />
          </button>
        </span>
      </li>
      {props.picking && <li className="mt-1 mb-2">{props.picker}</li>}
      {props.editing && !props.picking && (
        <li className="pop settings mt-1 mb-2" role="group" aria-label={`Settings of step ${n}`}>
          {s.kind !== "expand" && (
            <button type="button" className="field flex w-full cursor-pointer items-center gap-2.5 text-left [height:auto] py-1.5" onClick={props.onPicker}>
              <Tile icon={s.icon} size={28} />
              <span className="st">
                <span className="kind">{kindWord(s)}</span>
                <span className="obj">{s.name}</span>
              </span>
              <span className="ml-auto text-muted">Change</span>
            </button>
          )}
          {s.kind === "hero" && (
            <div className="flex flex-col gap-1 text-sm">
              <span id={`${id}-nth`} className="text-muted">
                Which hero
              </span>
              <div role="radiogroup" aria-labelledby={`${id}-nth`} className="inline-flex w-fit rounded-[0.35rem] border">
                {NTH.map(([v, label]) => (
                  <label key={label} className="seg">
                    <input type="radio" name={`${id}-nth`} className="sr-only" checked={s.nth === v} onChange={() => props.onChange({ nth: v })} />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          )}
          {s.kind !== "hero" && (
            <div className="flex flex-col gap-1 text-sm">
              <span id={`${id}-count`} className="text-muted">
                {s.kind === "skill" ? `Skill level ${s.exactly ? "exactly" : "at least"}` : s.exactly ? "Exactly" : "At least"}
              </span>
              <span className="flex items-center gap-1" role="group" aria-labelledby={`${id}-count`}>
                <button type="button" className="icon-btn" aria-label="Fewer" disabled={s.count <= 1} onClick={() => props.onChange({ count: s.count - 1 })}>
                  <Glyph d={G.minus} size={16} />
                </button>
                <CountField value={s.count} labelledBy={`${id}-count`} onChange={(count) => props.onChange({ count })} />
                <button type="button" className="icon-btn" aria-label="More" disabled={s.count >= MAX_COUNT} onClick={() => props.onChange({ count: s.count + 1 })}>
                  <Glyph d={G.plus} size={16} />
                </button>
                <label className={`ml-2 flex items-center gap-2 ${s.negate ? "opacity-50" : "cursor-pointer"}`}>
                  <input type="checkbox" className="check" checked={s.exactly} disabled={s.negate} onChange={(e) => props.onChange({ exactly: e.target.checked })} />
                  Exactly
                </label>
              </span>
            </div>
          )}
          {s.kind === "built" && (
            <div className="flex flex-col gap-1 text-sm">
              <label className="flex cursor-pointer items-center gap-2.5">
                <input type="checkbox" className="check" checked={s.forward} aria-describedby={`${id}-forward`} onChange={(e) => props.onChange({ forward: e.target.checked })} />
                Forward
              </label>
              <span id={`${id}-forward`} className="text-muted">
                Under 3,000 units from the opponent&apos;s start
              </span>
            </div>
          )}
          <div role="group" aria-labelledby={`${id}-time`} className="flex flex-col gap-1 text-sm">
            <span id={`${id}-time`} className="text-muted">
              Game time
            </span>
            <span className="flex items-center gap-2">
              <span aria-hidden>From</span>
              <TimeField label="From (m:ss)" value={s.from} bad={bad.from} hintId={`${id}-time-hint`} onChange={(from) => props.onChange({ from })} onBad={(b) => setBad((x) => ({ ...x, from: b }))} />
              <span aria-hidden>to</span>
              <TimeField label="To (m:ss)" value={s.to} bad={bad.to} hintId={`${id}-time-hint`} onChange={(to) => props.onChange({ to })} onBad={(b) => setBad((x) => ({ ...x, to: b }))} />
            </span>
            <TimeHint id={`${id}-time-hint`} bad={bad.from || bad.to} />
          </div>
          {group.length > 1 && (
            <div className="flex flex-col gap-1 text-sm">
              <label htmlFor={`${id}-before`} className="text-muted">
                Before step
              </label>
              <select
                id={`${id}-before`}
                className="field w-fit"
                value={s.before ?? ""}
                disabled={s.link === "then" || belowThen}
                onChange={(e) => props.onChange({ before: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">Any time</option>
                {group.map((x, j) =>
                  anchorable(group, i, j + 1) ? (
                    <option key={x.key} value={j + 1}>
                      {`Step ${j + 1}: ${x.name}`}
                    </option>
                  ) : null,
                )}
              </select>
            </div>
          )}
          {i > 0 && (
            <div className="flex flex-col gap-1 text-sm">
              <span id={`${id}-after`} className="text-muted">
                After the step above
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <span role="radiogroup" aria-labelledby={`${id}-after`} className="inline-flex w-fit rounded-[0.35rem] border">
                  {(
                    [
                      ["and", "Any time"],
                      ["then", "Then"],
                      ["within", "Then within"],
                    ] as const
                  ).map(([v, label]) => (
                    <label key={v} className={`seg ${unlinked && v !== "and" ? "pointer-events-none opacity-40" : ""}`}>
                      <input
                        type="radio"
                        name={`${id}-after`}
                        className="sr-only"
                        disabled={unlinked && v !== "and"}
                        checked={v === "and" ? s.link === "and" : v === "then" ? s.link === "then" && s.within === null : s.link === "then" && s.within !== null}
                        onChange={() => props.onChange(v === "and" ? { link: "and", within: null } : { link: "then", within: v === "within" ? (s.within ?? 30) : null })}
                      />
                      {label}
                    </label>
                  ))}
                </span>
                {s.link === "then" && s.within !== null && (
                  <TimeField
                    label="Within (m:ss)"
                    value={s.within}
                    bad={bad.within}
                    hintId={`${id}-within-hint`}
                    required
                    ok={(v) => v > 0 && v <= MAX_WITHIN}
                    onChange={(within) => props.onChange({ within })}
                    onBad={(b) => setBad((x) => ({ ...x, within: b }))}
                  />
                )}
              </span>
              {s.link === "then" && s.within !== null && <TimeHint id={`${id}-within-hint`} bad={bad.within} max={MAX_WITHIN} />}
            </div>
          )}
          <label className={`flex items-center gap-2.5 ${s.link === "then" || belowThen ? "opacity-50" : "cursor-pointer"}`}>
            <input type="checkbox" className="check" checked={s.negate} disabled={s.link === "then" || belowThen} onChange={(e) => props.onChange({ negate: e.target.checked })} />
            Did not happen
          </label>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto flex sm:hidden">
              <button type="button" className="btn-quiet" disabled={i === 0} onClick={() => props.onMove(-1)}>
                Move up
              </button>
              <button type="button" className="btn-quiet" disabled={i === group.length - 1} onClick={() => props.onMove(1)}>
                Move down
              </button>
            </span>
            <button type="button" className="btn-quiet" onClick={props.onCancel}>
              Cancel
            </button>
            <button type="button" className="btn btn-gold" onClick={props.onDone}>
              Done
            </button>
          </div>
        </li>
      )}
    </>
  );
}
