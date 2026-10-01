"use client";
import { type ReactNode, useEffect, useRef } from "react";
import { Field } from "@/lib/ui";
import { RaceField } from "../RaceMenu";

/**
 * The filter row of both Strategies tabs: race, opponent race, map and minutes, then the tab's
 * own fields. A GET form that sends itself on each change, so the page has no button. Hidden
 * fields come first, so the last field keeps its width.
 */
export function StrategyFilters(props: {
  race: string[];
  opp: string[];
  map: string;
  min: string;
  max: string;
  counts: Record<string, number>;
  maps: string[];
  // keys the form sends unchanged, such as the open rows
  keep?: [string, string][];
  children?: ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const f = form.current!;
    // a named field sent its change; the race fields send their own
    const send = (e: Event) => (e.target as HTMLInputElement).name && f.requestSubmit();
    f.addEventListener("change", send);
    return () => f.removeEventListener("change", send);
  }, []);
  return (
    <form ref={form} className="card filters overflow-visible">
      {props.keep?.map(([k, v], i) => (
        <input key={i} type="hidden" name={k} value={v} />
      ))}
      <RaceField label="Race" name="race" value={props.race} counts={props.counts} any={false} submit />
      <RaceField label="Opponent race" name="opponent_race" value={props.opp} counts={props.counts} submit />
      <Field label="Map">
        <select name="map" defaultValue={props.map} className="field">
          <option value="">Any</option>
          {props.maps.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </Field>
      <div role="group" aria-labelledby="minutes" className="flex min-w-0 grow-0 flex-col gap-1 text-sm">
        <span id="minutes" className="text-muted">
          Minutes
        </span>
        <div className="range">
          <input name="min" type="number" min={0} step="any" inputMode="decimal" placeholder="from" aria-label="Minutes from" defaultValue={props.min} className="field" />
          <span aria-hidden className="text-muted">
            –
          </span>
          <input name="max" type="number" min={0} step="any" inputMode="decimal" placeholder="to" aria-label="Minutes to" defaultValue={props.max} className="field" />
        </div>
      </div>
      {props.children}
    </form>
  );
}
