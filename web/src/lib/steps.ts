// Build-order steps: the order kinds, which objects fit a race, and the step codec of the URL.

/** The kinds a step can name: mappings kind -> [label, replay_events event_type]. */
export const KINDS = {
  building: ["Built", "building"],
  unit: ["Trained", "unit"],
  upgrade: ["Researched", "upgrade"],
  hero: ["Got hero", "hero_trained"],
  hero_skill: ["Used skill", "hero_skill"],
  item: ["Bought", "item"],
} as const;
export type Kind = keyof typeof KINDS;

/** An object a step can name: a mappings row of a step kind, with its icon path and race letter. */
export type StepObject = { code: string; name: string; kind: Kind; hero: string; icon: string | null; letter: string };

/** The race letter in an object code, per race code; Night Elf is e. */
export const LETTERS: Record<string, string> = { HU: "h", OC: "o", NE: "e", UD: "u" };

// Codes whose letter names no race: War Drums Damage Increase (w) is Orc's.
const OWN_LETTER: Record<string, string> = { Rwdm: "o" };

/**
 * The letter of an object's race: first in a building, unit or hero code, after R in an upgrade code.
 * A skill takes its hero's letter, so Searing Arrows (AHfa) is the Priestess of the Moon's.
 */
export function letterOf(o: Omit<StepObject, "icon" | "letter">, heroCodes: Record<string, string>) {
  const code = o.kind === "hero_skill" ? (heroCodes[o.hero] ?? "") : o.code;
  return OWN_LETTER[code] ?? code[o.kind === "upgrade" ? 1 : 0]?.toLowerCase() ?? "";
}

/** Whether a race can order an object. An item, n (neutral) and any other letter fit every race; so does no race or Random. */
export function fits(o: StepObject, race: string) {
  const own = LETTERS[race];
  if (!own || o.kind === "item") return true;
  return o.letter === own || !Object.values(LETTERS).includes(o.letter);
}

/** A step as the URL holds it: whole seconds, null for no limit. */
export type Step = { code: string; within: number | null; from: number | null; to: number | null };

const TOKEN = /^([A-Za-z0-9_]{1,8})(?:~(\d+))?(?:@(\d*)-(\d*))?$/;

/** "eate@-120,eaom~20": a code, then ~ seconds after the step before, then @ from-to seconds of game time. */
export function decodeSteps(value: string): Step[] {
  const n = (v?: string) => (v ? Number(v) : null);
  return value.split(",").flatMap((t) => {
    const m = TOKEN.exec(t);
    return m ? [{ code: m[1], within: n(m[2]), from: n(m[3]), to: n(m[4]) }] : [];
  });
}

export function encodeSteps(steps: Step[]) {
  return steps
    .map((s) => s.code + (s.within === null ? "" : `~${s.within}`) + (s.from === null && s.to === null ? "" : `@${s.from ?? ""}-${s.to ?? ""}`))
    .join(",");
}

// The API's bounds on a step: at most 7200 s after the previous one, inside the first 600 minutes.
export const MAX_WITHIN = 7200;
const MAX_TIME = 36000;

/** "5" (minutes) or "5:30" as whole seconds; null when blank, not a time or past 600:00. */
export function parseMss(v: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)(?::([0-5]?\d))?\s*$/.exec(v);
  if (!m || (m[2] !== undefined && m[1].includes("."))) return null;
  const s = Math.round(Number(m[1]) * 60 + Number(m[2] ?? 0));
  return s <= MAX_TIME ? s : null;
}
