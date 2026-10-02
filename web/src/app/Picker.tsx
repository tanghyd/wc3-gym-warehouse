"use client";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { Filters, PickerGroup, PickerKind, PickerObject } from "@/lib/api";
import { Chevron, fmt, RaceIcon, Tile } from "@/lib/ui";
import { loadPicker } from "./actions";

/** What a pick sends back: one object, or every object of one group. */
export type Pick = { codes: string[]; name: string; icon: string | null; source?: string };

// A cascade's column heads, [group, object]; Hero and Built list their groups as headed sections.
const HEADS: Partial<Record<PickerKind, [string, string]>> = {
  unit: ["Building", "Unit"],
  hired: ["Camp", "Mercenary"],
  upgrade: ["Building", "Upgrade"],
  skill: ["Hero", "Skill"],
  item: ["Shop", "Item"],
};
const NTH = [
  [null, "Any"],
  [1, "1st"],
  [2, "2nd"],
  [3, "3rd"],
] as const;


/**
 * The objects of one picker kind for a side's race, read once when the picker opens: a group
 * column (the source building, altar, camp, shop or hero) and its objects, each with the
 * games in scope in which a player of the side ordered it. A name search covers both columns. On a phone the
 * groups and the objects are two screens. A group can be picked whole when `groupPick` is on.
 */
export function Picker(props: {
  label: string;
  kind: PickerKind;
  race: string[];
  filters: Filters;
  nth?: number | null;
  onNth?: (n: number | null) => void;
  groupPick?: boolean;
  onPick: (pick: Pick) => void;
  onClose: () => void;
}) {
  const { kind, race, filters, onPick } = props;
  const id = useId();
  const [groups, setGroups] = useState<PickerGroup[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [drilled, setDrilled] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // On a phone a drill hides the row that has focus, so focus moves to the other column's head.
  const refocus = (selector: string) => requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(selector)?.focus());

  useEffect(() => {
    let live = true;
    loadPicker(kind, race, filters).then(
      (g) => live && setGroups(g),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [kind, race, filters]);

  const t = q.trim().toLowerCase();
  // with a search, a group whose name matches keeps every object, any other only its matches
  const shown = (groups ?? [])
    .map((g) => (t && !g.source.name.toLowerCase().includes(t) ? { ...g, objects: g.objects.filter((o) => o.name.toLowerCase().includes(t)) } : g))
    .filter((g) => g.objects.length);
  const current = shown.find((g) => g.source.code === active) ?? shown[0];
  const heads = HEADS[kind];
  const pickObject = (o: PickerObject) => onPick({ codes: [o.code], name: o.name, icon: o.icon });
  const pickGroup = (g: PickerGroup) =>
    onPick({ codes: g.objects.map((o) => o.code), name: `Any from ${g.source.name}`, icon: g.source.icon ?? g.objects[0]?.icon ?? null, source: g.source.code });
  // the right column: the open group's objects, or every match of a search
  const listed = heads && t ? shown.flatMap((g) => g.objects.map((o) => [o, g.source.name] as const)) : (current?.objects ?? []).map((o) => [o, ""] as const);

  const objectRow = (o: PickerObject, from: string) => (
    <li key={`${from}-${o.code}`}>
      <button type="button" className={`opt ${o.games ? "" : "zero"}`} onClick={() => pickObject(o)}>
        <Tile icon={o.icon} size={24} />
        <span className="min-w-0 flex-1">
          <span className="opt-name block truncate">{o.name}</span>
          {from && <span className="block truncate text-xs text-muted">{from}</span>}
        </span>
        <span className={`opt-count ${o.games ? "" : "zero"}`}>{fmt(o.games)}</span>
      </button>
    </li>
  );
  const groupMark = (g: PickerGroup) => (g.source.icon ? <Tile icon={g.source.icon} size={24} /> : kind === "building" ? <RaceIcon race={g.source.code} size="20px" /> : null);
  const anyRow = (g: PickerGroup) =>
    props.groupPick &&
    g.objects.length > 1 && (
      <li>
        <button type="button" className="opt" onClick={() => pickGroup(g)}>
          <span className="opt-name">Any from {g.source.name}</span>
        </button>
      </li>
    );

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    props.onClose();
  };

  return (
    <div ref={root} role="group" aria-label={props.label} className="pop picker flex flex-col gap-2.5 p-2.5" onKeyDown={onKey}>
      {kind === "hero" && props.onNth && (
        <div className="flex flex-col gap-1 text-sm">
          <span id={`${id}-nth`} className="text-muted">
            Which hero
          </span>
          <div role="radiogroup" aria-labelledby={`${id}-nth`} className="inline-flex w-fit rounded-[0.35rem] border">
            {NTH.map(([n, label]) => (
              <label key={label} className="seg">
                <input type="radio" name={`${id}-nth`} className="sr-only" checked={(props.nth ?? null) === n} onChange={() => props.onNth!(n)} />
                {label}
              </label>
            ))}
          </div>
        </div>
      )}
      <input
        type="search"
        autoFocus
        aria-label="Find by name"
        placeholder="Find by name"
        className="field w-full"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault(); // Enter picks the first match, it does not submit the search
          const first = heads ? listed[0]?.[0] : shown[0]?.objects[0];
          if (first) pickObject(first);
        }}
      />
      {failed ? (
        <p role="alert" className="p-2 text-sm">
          Could not load the objects. Close and open the picker again.
        </p>
      ) : !groups ? (
        <p aria-busy="true" className="p-2 text-sm text-muted">
          Loading…
        </p>
      ) : !shown.length ? (
        <p className="p-2 text-sm text-muted">Nothing matches. Clear the search.</p>
      ) : heads ? (
        <div className="cascade" data-drilled={drilled || t ? "" : undefined}>
          <div className="col-left min-w-0">
            <div className="colhead">{heads[0]}</div>
            <ul className="picker-list">
              {shown.map((g) => (
                <li key={g.source.code}>
                  <button
                    type="button"
                    className="opt"
                    aria-current={!t && g === current ? "true" : undefined}
                    onClick={(e) => {
                      const hides = getComputedStyle(e.currentTarget.closest(".cascade")!).gridTemplateColumns.split(" ").length === 1;
                      setQ("");
                      setActive(g.source.code);
                      setDrilled(true);
                      if (hides) refocus(".col-right .back");
                    }}
                  >
                    {groupMark(g)}
                    <span className="min-w-0 truncate">{g.source.name}</span>
                    <Chevron />
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="col-right min-w-0">
            <div className="colhead">
              <button
                type="button"
                className="back items-center gap-1 font-bold text-primary-text"
                onClick={() => {
                  setDrilled(false);
                  refocus('.col-left [aria-current="true"]');
                }}
              >
                <Chevron dir="left" />
                {t ? "Groups" : current?.source.name}
              </button>
              <span className="desk mr-auto">{heads[1]}</span>
              <span>Games</span>
            </div>
            <ul className="picker-list">
              {!t && current && anyRow(current)}
              {listed.map(([o, from]) => objectRow(o, from))}
            </ul>
          </div>
        </div>
      ) : (
        <div className="picker-list">
          {shown.map((g) => (
            <div key={g.source.code}>
              <div className="colhead pt-2">
                <span className="mr-auto">{g.source.name}</span>
                {g === shown[0] && <span>Games</span>}
              </div>
              <ul>
                {anyRow(g)}
                {g.objects.map((o) => objectRow(o, ""))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
