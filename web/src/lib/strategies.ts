// Strategy presets (GET /strategies): a named side of the search, as POST /search steps. Here
// they turn into the Replays URL's steps and into the words of a rule.
import type { Objects } from "./api";
import { countWords, HALLS, KINDS, type Kind, type Step, timeWords } from "./steps";

/** A POST /search step as GET /strategies answers it, defaults left out. */
export type ApiStep = { kind: string; codes: string[]; count?: number; from_s?: number; to_s?: number; link?: "and" | "then"; within_s?: number; nth?: number; exactly?: boolean; before?: number; negate?: boolean; forward?: boolean };
export type Preset = { id: string; name: string; race: string; parent_id: string | null; source: string; vs_races: string[]; steps: ApiStep[] };
/** Games, wins, losses, summed length and the mirrors (both) of a preset; wins and losses are null when every game is a mirror. */
export type Stats = { games: number; wins: number | null; losses: number | null; duration_ms_total: number; both: number };

const HALL_CODES = new Set(Object.values(HALLS));
// Every Tavern hero: a hero step of all of them is the Tavern's picker group, "@ntav".
const TAVERN = ["Nalc", "Nbrn", "Nbst", "Nfir", "Nngs", "Npbm", "Nplh", "Ntin"];
const anyTavern = (s: ApiStep) => s.kind === "hero" && s.codes.length === TAVERN.length && TAVERN.every((c) => s.codes.includes(c));
// The step kind of each API kind; a neutral unit is Hired, a town hall is Expanded.
const KIND_OF: Record<string, Kind> = { building: "built", unit: "trained", upgrade: "researched", hero: "hero", skill: "skill", item: "bought" };

/** A preset step as the Replays URL holds it. */
export function urlStep(s: ApiStep): Step {
  let kind = KIND_OF[s.kind];
  if (kind === "built" && s.codes.every((c) => HALL_CODES.has(c))) kind = "expand";
  if (kind === "trained" && s.codes.every((c) => c.startsWith("n"))) kind = "hired";
  return {
    kind,
    codes: kind === "expand" ? [] : anyTavern(s) ? ["@ntav"] : s.codes,
    count: s.count ?? 1,
    from: s.from_s ?? null,
    to: s.to_s ?? null,
    link: s.link ?? "and",
    within: s.within_s ?? null,
    nth: s.nth ?? null,
    exactly: s.exactly ?? false,
    before: s.before ?? null,
    negate: s.negate ?? false,
    forward: s.forward ?? false,
  };
}

/** A preset's whole group: its parent's steps, then its own. */
export const presetSteps = (p: Preset, byId: Map<string, Preset>) => [...(p.parent_id ? (byId.get(p.parent_id)?.steps ?? []) : []), ...p.steps];

/** A step's objects in words: "Archer", "Archer or 2 more", "any Tavern hero". */
function objectWords(s: ApiStep, names: Objects) {
  const first = names[s.codes[0]]?.name ?? s.codes[0];
  return anyTavern(s) ? "any Tavern hero" : s.codes.length > 1 ? `${first} or ${s.codes.length - 1} more` : first;
}

/**
 * One step in the words of a rule: "1st hero Archmage", "Town Hall by 6:00", "No Town Hall", "Rifleman ×8",
 * "Ancient of War ×1 exactly before Tree of Ages", "Watch Tower ×2 forward by 5:00". `group` is the whole
 * group a "before" step names a step of; a forward step with no "before" after a step of the same objects
 * and window, neither negated, reads as its count, so a rule reads "Scout Tower ×3 by 4:00, 2 forward".
 */
export function stepWords(s: ApiStep, names: Objects, group: ApiStep[] = []) {
  const above = group[group.indexOf(s) - 1];
  const same = (a: ApiStep, b: ApiStep) => a.codes.join() === b.codes.join() && a.from_s === b.from_s && a.to_s === b.to_s;
  if (s.forward && !s.negate && !s.before && s.link !== "then" && above && !above.forward && !above.negate && same(above, s)) return `${s.count ?? 1} forward${s.exactly ? " exactly" : ""}`;
  const name = objectWords(s, names);
  const what = s.kind === "hero" && s.nth ? `${["1st", "2nd", "3rd"][s.nth - 1]} hero ${name}` : s.kind === "skill" ? `${KINDS.skill.label} ${name}` : name;
  const anchor = s.before ? group[s.before - 1] : undefined;
  const words = [`${what}${countWords({ count: s.count ?? 1, exactly: s.exactly ?? false })}${s.forward ? " forward" : ""}`, timeWords({ from: s.from_s ?? null, to: s.to_s ?? null }), anchor ? `before ${objectWords(anchor, names)}` : ""]
    .filter(Boolean)
    .join(" ");
  return s.negate ? `No ${words}` : words;
}

/** A group's steps as one line: "and" steps joined by commas, "then" steps by "then". `group` holds them, after a parent's steps. */
export const ruleWords = (steps: ApiStep[], names: Objects, group: ApiStep[] = steps) =>
  steps.map((s, i) => (i === 0 ? "" : s.link === "then" ? " then " : ", ") + stepWords(s, names, group)).join("");
