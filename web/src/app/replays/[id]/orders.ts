// The build timeline's data: kinds, merged marks and tier-ups, shared by the chart and the list.
import type { GameEvent, Objects } from "@/lib/api";
import { mss } from "@/lib/ui";

export const KINDS = [
  { key: "buildings", label: "Buildings", types: ["building"] },
  { key: "units", label: "Units", types: ["unit"] },
  { key: "upgrades", label: "Upgrades", types: ["upgrade"] },
  { key: "heroes", label: "Heroes", types: ["hero_trained", "hero_skill", "hero_retrained"] },
  { key: "items", label: "Items", types: ["item"] },
];
export const ALL_KINDS = KINDS.map((k) => k.key);

/** Orders of one object up to this long after the first one become one mark. */
export const MERGE_MS = 60_000;

/** One player's orders of one object, from the first one to MERGE_MS after it. */
export type Mark = { event_type: string; code: string; hero_code: string | null; times: number[] };

/** Merges a player's events, in time order, into marks. */
export function merge(events: GameEvent[]): Mark[] {
  const open = new Map<string, Mark>();
  const marks: Mark[] = [];
  for (const e of [...events].sort((a, b) => a.time_ms - b.time_ms)) {
    const key = `${e.event_type}/${e.code}/${e.hero_code}`;
    const m = open.get(key);
    if (m && e.time_ms - m.times[0] <= MERGE_MS) m.times.push(e.time_ms);
    else {
      const n = { event_type: e.event_type, code: e.code, hero_code: e.hero_code, times: [e.time_ms] };
      open.set(key, n);
      marks.push(n);
    }
  }
  return marks;
}

// The main hall of each tier: Keep/Castle, Stronghold/Fortress, Tree of Ages/Eternity, Halls of the Dead/Black Citadel.
const TIER_HALLS: Record<string, number> = { hkee: 2, ostr: 2, etoa: 2, unp1: 2, hcas: 3, ofrt: 3, etoe: 3, unp2: 3 };

export type Tier = { tier: number; code: string; time_ms: number };

/** A player's tier-ups: the first order of each tier's hall. */
export function tiers(events: GameEvent[]): Tier[] {
  const out: Tier[] = [];
  for (const e of [...events].sort((a, b) => a.time_ms - b.time_ms)) {
    const tier = e.event_type === "building" ? TIER_HALLS[e.code] : undefined;
    if (tier && !out.some((t) => t.tier === tier)) out.push({ tier, code: e.code, time_ms: e.time_ms });
  }
  return out.sort((a, b) => a.tier - b.tier);
}

// What a code in no mappings row is called; the parser leaves some heroes' code empty.
const UNKNOWN: Record<string, string> = {
  building: "Unknown building",
  unit: "Unknown unit",
  upgrade: "Unknown upgrade",
  item: "Unknown item",
  hero_trained: "Unknown hero",
  hero_retrained: "Unknown hero",
  hero_skill: "Unknown skill",
};
const nameOf = (objects: Objects, code: string | null, type: string) => objects[code ?? ""]?.name ?? UNKNOWN[type];

/** A mark's name with its count, and what its times mean. */
export function describe(m: Mark, objects: Objects): [string, string] {
  const name = nameOf(objects, m.code, m.event_type) + (m.times.length > 1 ? ` ×${m.times.length}` : "");
  const at = m.times.map(mss).join(", ");
  if (m.event_type === "hero_trained") return [name, `Trained by ${at}`];
  if (m.event_type === "hero_retrained") return [name, `Retrained at ${at}`];
  if (m.event_type === "hero_skill") return [name, `${nameOf(objects, m.hero_code, "hero_trained")} skill at ${at}`];
  return [name, `Ordered at ${at}`];
}
