"use client";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { ANY_RACE, ANY_RANDOM, PICKED, RACES, RANDOM_OF } from "@/lib/races";
import { Chevron, fmt, RaceIcon } from "@/lib/ui";

const RANDOMS = PICKED.map((r) => RANDOM_OF[r]);


/**
 * One race control: a button with the race's icon and name, a menu of Any race, the four races
 * and a Random submenu of the four Random races, each with its games in scope, and an
 * "Include Random" switch in the label line of a picked race. The value is [] (any), one race value, or
 * a race with its Random value.
 */
export function RaceMenu(props: { label: string; value: string[]; onChange: (v: string[]) => void; counts: Record<string, number>; any?: boolean }) {
  const { value, onChange, counts, any = true } = props;
  const id = useId();
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const base = value[0] ?? "";
  const picked = (PICKED as readonly string[]).includes(base);
  const withRandom = picked && value.includes(RANDOM_OF[base]);

  const items = () => [...(root.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
  const close = (focus = true) => {
    setOpen(false);
    setSub(false);
    if (focus) button.current?.focus();
  };
  const pick = (v: string) => {
    // a picked race keeps the Random switch as it was
    onChange(!v ? [] : withRandom && RANDOM_OF[v] ? [v, RANDOM_OF[v]] : [v]);
    close();
  };

  // Opening focuses the chosen row, so the arrow keys start there. A press outside closes.
  useEffect(() => {
    const el = root.current;
    if (!open || !el) return;
    requestAnimationFrame(() => (el.querySelector<HTMLElement>('[aria-checked="true"]') ?? el.querySelector<HTMLElement>('[role^="menuitem"]'))?.focus());
    const outside = (e: PointerEvent) => {
      if (el.contains(e.target as Node)) return;
      setOpen(false);
      setSub(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    if (!open) return;
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => list[(i + list.length) % list.length]?.focus();
    const onRandom = (document.activeElement as HTMLElement)?.dataset.random !== undefined;
    const inSub = (document.activeElement as HTMLElement)?.dataset.sub !== undefined;
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "Escape") close();
    else if (e.key === "ArrowRight" && onRandom) {
      setSub(true);
      requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("[data-sub]")?.focus());
    } else if (e.key === "ArrowLeft" && inSub) {
      setSub(false);
      root.current?.querySelector<HTMLElement>("[data-random]")?.focus();
    } else if (e.key === "Tab") return close(false);
    else return;
    e.preventDefault();
  };

  const row = (v: string, name: string, count: number) => (
    <>
      {v && <RaceIcon race={v} size="20px" />}
      <span className={`min-w-0 truncate ${v ? "" : "text-muted"}`}>{name}</span>
      <span className="opt-count">{fmt(count)}</span>
    </>
  );
  const option = (v: string, extra = {}) => (
    <li key={v} role="none">
      <button type="button" role="menuitemradio" aria-checked={base === v} className="opt" onClick={() => pick(v)} {...extra}>
        {row(v, RACES[v][0], counts[v] ?? 0)}
      </button>
    </li>
  );
  const total = counts[ANY_RACE] ?? 0;
  const randoms = counts[ANY_RANDOM] ?? 0;

  return (
    <div className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
      {/* the label line; a picked race adds its Random switch at the end */}
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-x-3">
        <span className="text-muted" aria-hidden>
          {props.label}
        </span>
        {picked && (
          <label className="flex cursor-pointer items-center gap-1.5" title={`Include Random ${RACES[base][0]}`}>
            <input
              type="checkbox"
              className="check"
              aria-label={`Include Random ${RACES[base][0]}`}
              checked={withRandom}
              onChange={(e) => onChange(e.target.checked ? [base, RANDOM_OF[base]] : [base])}
            />
            Include Random
          </label>
        )}
      </div>
      <div ref={root} className="relative" onKeyDown={onKey}>
        <button
          ref={button}
          type="button"
          id={`${id}-button`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${props.label}: ${base ? RACES[base][0] : "Any race"}`}
          className="field flex w-full cursor-pointer items-center gap-2 text-left"
          onClick={() => {
            if (open) return close();
            setSub(RANDOMS.includes(base)); // a Random value shows its submenu open
            setOpen(true);
          }}
        >
          {base && <RaceIcon race={base} size="20px" />}
          <span className="min-w-0 truncate">{base ? RACES[base][0] : "Any race"}</span>
          <Chevron dir="down" />
        </button>
        {open && (
          <ul role="menu" aria-label={props.label} className="pop race-menu">
            {any && (
              <li role="none">
                <button type="button" role="menuitemradio" aria-checked={!base} className="opt" onClick={() => pick("")}>
                  {row("", "Any race", total)}
                </button>
              </li>
            )}
            {PICKED.map((v) => option(v))}
            <li role="none" className="relative">
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={sub}
                data-random=""
                className={`opt ${RANDOMS.includes(base) ? "font-bold" : ""}`}
                onClick={() => setSub(true)}
                onPointerEnter={(e) => e.pointerType === "mouse" && setSub(true)}
              >
                {row("R", "Random", randoms)}
                <Chevron dir="right" />
              </button>
              {sub && (
                <ul role="menu" aria-label="Random" className="pop race-sub">
                  {RANDOMS.map((v) => option(v, { "data-sub": "" }))}
                </ul>
              )}
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}

/** A race control inside a GET form: the menu plus a hidden field with its value, such as race=NE,RN. With `submit`, a change sends the form. */
export function RaceField(props: { label: string; name: string; value: string[]; counts: Record<string, number>; any?: boolean; submit?: boolean }) {
  const [value, setValue] = useState(props.value);
  const input = useRef<HTMLInputElement>(null);
  const changed = useRef(false);
  useEffect(() => {
    if (changed.current) input.current?.form?.requestSubmit();
  }, [value]);
  return (
    <>
      <RaceMenu
        label={props.label}
        value={value}
        onChange={(v) => {
          changed.current = !!props.submit;
          setValue(v);
        }}
        counts={props.counts}
        any={props.any}
      />
      <input ref={input} type="hidden" name={value.length ? props.name : undefined} value={value.join(",")} />
    </>
  );
}
