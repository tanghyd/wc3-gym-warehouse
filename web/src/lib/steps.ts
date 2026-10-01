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

/** An object a step can name: a mappings row of a step kind, with its icon path. */
export type StepObject = { code: string; name: string; kind: Kind; hero: string; icon: string | null };

/** The race letter in an object code, per GNL race; Night Elf is e. */
export const LETTERS: Record<string, string> = { HU: "h", OC: "o", NE: "e", UD: "u" };

/** The letter that names a code's race: first for a building, unit or hero, after R or A for an upgrade or skill. */
export const letterOf = (code: string, kind: Kind) => code[kind === "upgrade" || kind === "hero_skill" ? 1 : 0]?.toLowerCase() ?? "";

/** Whether a race can order a code. An item, n (neutral) and any other letter fit every race; so does no race or Random. */
export function fits(code: string, kind: Kind, race: string) {
  const own = LETTERS[race];
  if (!own || kind === "item") return true;
  const letter = letterOf(code, kind);
  return letter === own || !Object.values(LETTERS).includes(letter);
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

/** "5" (minutes) or "5:30" as whole seconds; null when blank or not a time. */
export function parseMss(v: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)(?::([0-5]?\d))?\s*$/.exec(v);
  if (!m || (m[2] !== undefined && m[1].includes("."))) return null;
  return Math.round(Number(m[1]) * 60 + Number(m[2] ?? 0));
}
