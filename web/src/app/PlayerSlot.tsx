"use client";
import { useId, useMemo, useRef, useState } from "react";
import type { Filters, PickerKind } from "@/lib/api";
import { encodeSteps, KINDS, type Kind, MAX_WITHIN, parseMss, type Step, type StepObject } from "@/lib/steps";
import { Field, mss, ObjIcon, RaceIcon } from "@/lib/ui";
import { Picker } from "./Picker";
import { RaceMenu } from "./RaceMenu";

/** A step being edited: the field text as typed. */
type Draft = { key: number; kind: Kind; code: string; within: string; from: string; to: string };

// The query keys and labels of each player; Player 1 is the focus, Player 2 his opponent.
const FIELDS = {
  1: { race: ["race", "Race"], player: ["player", "Player"], result: "result", steps: "steps" },
  2: { race: ["opponent_race", "Opponent race"], player: ["opp_player", "Opponent"], result: "opp_result", steps: "opp_steps" },
} as const;
// the picker kind of each step kind
const PICKER_KIND: Record<Kind, PickerKind> = { building: "building", unit: "unit", hired: "hired", upgrade: "upgrade", hero: "hero", hero_skill: "skill", item: "item" };
const OUTCOMES = [["", "Any"], ["won", "Won"], ["lost", "Lost"]] as const;
const MAX_STEPS = 10; // the API's limit per player

// seconds as typed; a number past the API's bound reads as blank
const whole = (v: string) => (v.trim() !== "" && Number(v) >= 0 && Number(v) <= MAX_WITHIN ? Math.round(Number(v)) : null);
const toStep = (d: Draft): Step => ({ code: d.code, within: whole(d.within), from: parseMss(d.from), to: parseMss(d.to) });
const toText = (s: number | null) => (s === null ? "" : mss(s * 1000));

/** A step's timing as an order: "ordered within 20 s of step 1, by 2:00". */
function timing(s: Step, i: number) {
  const parts = [];
  if (s.within !== null && i > 0) parts.push(`within ${s.within} s of step ${i}`);
  const [from, to] = [toText(s.from), toText(s.to)];
  if (from && to) parts.push(`${from} to ${to}`);
  else if (to) parts.push(`by ${to}`);
  else if (from) parts.push(`from ${from}`);
  return parts.length ? `ordered ${parts.join(", ")}` : "";
}

const GLYPHS = {
  clock: "M12 9.5v4l2.5 2M9.5 3h5M12 6a7.5 7.5 0 1 0 0 15a7.5 7.5 0 1 0 0-15",
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  close: "M6 6l12 12M18 6L6 18",
};
function Glyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

/** Focus the first of these elements that can take it, after React has drawn. */
const focus = (...ids: string[]) =>
  requestAnimationFrame(() => ids.map((i) => document.getElementById(i) as HTMLButtonElement | null).find((el) => el && !el.disabled)?.focus());

/** One player of the search: race, name, outcome and an ordered build, written to the form's fields. */
export function PlayerSlot(props: { n: 1 | 2; race: string[]; name: string; outcome: string; steps: Step[]; objects: StepObject[]; counts: Record<string, number>; scope: Filters }) {
  const { n, objects } = props;
  const f = FIELDS[n];
  const id = useId();
  const byCode = useMemo(() => Object.fromEntries(objects.map((o) => [o.code, o])), [objects]);
  const [races, setRaces] = useState(props.race);
  const [steps, setSteps] = useState<Draft[]>(() =>
    props.steps.map((s, key) => ({ key, kind: byCode[s.code]?.kind ?? "building", code: s.code, within: s.within === null ? "" : String(s.within), from: toText(s.from), to: toText(s.to) })),
  );
  const nextKey = useRef(props.steps.length);
  const [picking, setPicking] = useState<number | null>(null);
  const [timed, setTimed] = useState<number[]>([]); // steps whose timing fields are open

  const edit = (key: number, patch: Partial<Draft>) => setSteps((ss) => ss.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const sid = (key: number, part: string) => `${id}-${key}-${part}`;
  const add = () => {
    const key = nextKey.current++;
    setSteps((ss) => [...ss, { key, kind: ss.at(-1)?.kind ?? "building", code: "", within: "", from: "", to: "" }]);
    setPicking(key);
  };
  const move = (i: number, by: -1 | 1) => {
    const key = steps[i].key;
    setSteps((ss) => ss.map((s, j) => (j === i ? ss[i + by] : j === i + by ? ss[i] : s)));
    focus(sid(key, by < 0 ? "up" : "down"), sid(key, by < 0 ? "down" : "up"));
  };
  const remove = (key: number) => {
    setSteps((ss) => ss.filter((s) => s.key !== key));
    focus(`${id}-add`);
  };
  const pick = (key: number, code: string) => {
    edit(key, { code });
    setPicking(null);
    focus(sid(key, "obj"));
  };
  const encoded = encodeSteps(steps.filter((s) => s.code).map(toStep));

  return (
    <section aria-labelledby={`${id}-title`} className="card overflow-visible">
      <div className="bar">
        <h2 id={`${id}-title`}>Player {n}</h2>
        <RaceIcon race={races[0] ?? ""} />
      </div>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap gap-3">
          <RaceMenu label={f.race[1]} value={races} onChange={setRaces} counts={props.counts} />
          <input type="hidden" name={races.length ? f.race[0] : undefined} value={races.join(",")} />
          <Field label={f.player[1]}>
            <input name={f.player[0]} list="players" defaultValue={props.name} className="field" autoComplete="off" />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1 text-sm text-muted">Outcome</legend>
          <div className="inline-flex rounded-[0.35rem] border">
            {OUTCOMES.map(([v, label]) => (
              <label key={v} className="seg">
                <input type="radio" name={f.result} value={v} defaultChecked={props.outcome === v} className="sr-only" />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <p id={`${id}-steps`} className="text-sm text-muted">
            Build order
          </p>
          {steps.length > 0 && (
            <ol aria-labelledby={`${id}-steps`} className="mt-1">
              {steps.map((s, i) => {
                const o = byCode[s.code];
                const summary = timing(toStep(s), i);
                const open = timed.includes(s.key);
                return (
                  <li key={s.key} className="border-t py-3 first:border-t-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="w-5 text-right text-sm text-muted">{i + 1}</span>
                      <select
                        aria-label={`Step ${i + 1} order`}
                        className="field w-32"
                        value={s.kind}
                        onChange={(e) => {
                          edit(s.key, { kind: e.target.value as Kind, code: "" });
                          setPicking(s.key);
                        }}
                      >
                        {Object.entries(KINDS).map(([k, [label]]) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        id={sid(s.key, "obj")}
                        aria-label={`Step ${i + 1}: ${o?.name ?? "pick an object"}`}
                        aria-expanded={picking === s.key}
                        className="field flex min-w-0 flex-1 basis-40 cursor-pointer items-center gap-2 text-left"
                        onClick={() => setPicking(picking === s.key ? null : s.key)}
                      >
                        {o ? (
                          <>
                            <ObjIcon code={o.code} objects={byCode} size={24} alt="" />
                            <span className="truncate">{o.name}</span>
                          </>
                        ) : (
                          <span className="text-muted">Pick an object</span>
                        )}
                      </button>
                      <div className="ml-auto flex">
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Timing for step ${i + 1}`}
                          aria-expanded={open}
                          data-on={summary ? "" : undefined}
                          onClick={() => setTimed((t) => (open ? t.filter((k) => k !== s.key) : [...t, s.key]))}
                        >
                          <Glyph d={GLYPHS.clock} />
                        </button>
                        <button type="button" id={sid(s.key, "up")} className="icon-btn" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                          <Glyph d={GLYPHS.up} />
                        </button>
                        <button type="button" id={sid(s.key, "down")} className="icon-btn" aria-label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
                          <Glyph d={GLYPHS.down} />
                        </button>
                        <button type="button" className="icon-btn" aria-label={`Remove step ${i + 1}`} onClick={() => remove(s.key)}>
                          <Glyph d={GLYPHS.close} />
                        </button>
                      </div>
                    </div>
                    {summary && <p className="mt-1 pl-7 text-sm text-muted">{summary}</p>}
                    {open && (
                      <div className="mt-2 grid gap-2 pl-7 sm:grid-cols-3">
                        <Field label="Within previous (s)" className="min-w-0">
                          <input type="number" min={0} max={MAX_WITHIN} step={1} inputMode="numeric" className="field" disabled={i === 0} value={s.within} onChange={(e) => edit(s.key, { within: e.target.value })} />
                        </Field>
                        <Field label="Not before (m:ss)" className="min-w-0">
                          <input className="field" value={s.from} onChange={(e) => edit(s.key, { from: e.target.value })} />
                        </Field>
                        <Field label="Not after (m:ss)" className="min-w-0">
                          <input className="field" value={s.to} onChange={(e) => edit(s.key, { to: e.target.value })} />
                        </Field>
                      </div>
                    )}
                    {picking === s.key && (
                      <Picker
                        label={`Objects for step ${i + 1}`}
                        kind={PICKER_KIND[s.kind]}
                        race={races}
                        filters={props.scope}
                        onPick={(p) => pick(s.key, p.codes[0])}
                        onClose={() => {
                          setPicking(null);
                          focus(sid(s.key, "obj"));
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {steps.length < MAX_STEPS && (
            <button type="button" id={`${id}-add`} className="btn btn-line mt-2" onClick={add}>
              Add step
            </button>
          )}
          <input type="hidden" name={encoded ? f.steps : undefined} value={encoded} />
        </div>
      </div>
    </section>
  );
}
