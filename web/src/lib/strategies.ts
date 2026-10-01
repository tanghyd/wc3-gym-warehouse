// Strategy presets (GET /strategies): a named side of the search, as POST /search steps. Here
// they turn into the Replays URL's steps and into the words of a rule.
import type { Objects } from "./api";
import { HALLS, KINDS, type Kind, type Step, timeWords } from "./steps";

/** A POST /search step as GET /strategies answers it, defaults left out. */
export type ApiStep = { kind: string; codes: string[]; count?: number; from_s?: number; to_s?: number; link?: "and" | "then"; within_s?: number; nth?: number; negate?: boolean };
export type Preset = { id: string; name: string; race: string; parent_id: string | null; source: string; vs_races: string[]; steps: ApiStep[] };
/** Games, wins, losses and summed length of a preset or of the scope. */
export type Stats = { games: number; wins: number; losses: number; duration_ms_total: number };

const HALL_CODES = new Set(Object.values(HALLS));
// The step kind of each API kind; a neutral unit is Hired, a town hall is Expanded.
const KIND_OF: Record<string, Kind> = { building: "built", unit: "trained", upgrade: "researched", hero: "hero", skill: "skill", item: "bought" };

/** A preset step as the Replays URL holds it. */
export function urlStep(s: ApiStep): Step {
  let kind = KIND_OF[s.kind];
  if (kind === "built" && s.codes.every((c) => HALL_CODES.has(c))) kind = "expand";
  if (kind === "trained" && s.codes.every((c) => c.startsWith("n"))) kind = "hired";
  return {
    kind,
    codes: kind === "expand" ? [] : s.codes,
    count: s.count ?? 1,
    from: s.from_s ?? null,
    to: s.to_s ?? null,
    link: s.link ?? "and",
    within: s.within_s ?? null,
    nth: s.nth ?? null,
    negate: s.negate ?? false,
  };
}

/** A preset's whole group: its parent's steps, then its own. */
export const presetSteps = (p: Preset, byId: Map<string, Preset>) => [...(p.parent_id ? (byId.get(p.parent_id)?.steps ?? []) : []), ...p.steps];

/** One step in the words of a rule: "1st hero Archmage", "Town Hall by 6:00", "No Town Hall", "Rifleman ×8". */
export function stepWords(s: ApiStep, names: Objects) {
  const first = names[s.codes[0]]?.name ?? s.codes[0];
  const tavern = s.kind === "hero" && s.codes.length > 1 && s.codes.every((c) => c.startsWith("N"));
  const name = tavern ? "any Tavern hero" : s.codes.length > 1 ? `${first} or ${s.codes.length - 1} more` : first;
  const what = s.kind === "hero" && s.nth ? `${["1st", "2nd", "3rd"][s.nth - 1]} hero ${name}` : s.kind === "skill" ? `${KINDS.skill.label} ${name}` : name;
  const words = `${what}${(s.count ?? 1) > 1 ? ` ×${s.count}` : ""} ${timeWords({ from: s.from_s ?? null, to: s.to_s ?? null })}`.trim();
  return s.negate ? `No ${words}` : words;
}

/** A group's steps as one line: "and" steps joined by commas, "then" steps by "then". */
export const ruleWords = (steps: ApiStep[], names: Objects) =>
  steps.map((s, i) => (i === 0 ? "" : s.link === "then" ? " then " : ", ") + stepWords(s, names)).join("");
