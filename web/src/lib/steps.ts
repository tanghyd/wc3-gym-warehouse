// Strategy steps: the step kinds, the URL codec of a side's steps, and the POST /search step.
import type { Objects } from "./api";
import { racePair } from "./races";

/** A step kind: its word, the API kind it searches, and its picker (none for Expanded). */
export const KINDS = {
  built: { label: "Built", api: "building", picker: "building" },
  trained: { label: "Trained", api: "unit", picker: "unit" },
  hired: { label: "Hired", api: "unit", picker: "hired" },
  researched: { label: "Researched", api: "upgrade", picker: "upgrade" },
  hero: { label: "Hero", api: "hero", picker: "hero" },
  skill: { label: "Learned skill", api: "skill", picker: "skill" },
  bought: { label: "Bought", api: "item", picker: "item" },
  expand: { label: "Expanded", api: "building", picker: null },
} as const;
export type Kind = keyof typeof KINDS;

/** Each race's expansion building: a town hall, or the Haunted Gold Mine for Undead. */
export const HALLS: Record<string, string> = { HU: "htow", OC: "ogre", NE: "etol", UD: "ugol" };

/**
 * One step as the URL holds it. `codes` are object codes, or one "@source" for every object of a
 * picker group, such as "@ntav" for any Tavern hero; Expanded has none. Times are whole seconds.
 */
export type Step = {
  kind: Kind;
  codes: string[];
  count: number;
  from: number | null;
  to: number | null;
  link: "and" | "then";
  within: number | null;
  nth: number | null;
  /** The count is exact: no more orders than `count`. */
  exactly: boolean;
  /** The step's orders come before the order that completes this step of the group, from 1. */
  before: number | null;
  negate: boolean;
};
/** A side's steps: groups of steps, any of which may hold. */
export type Groups = Step[][];

export const newStep = (kind: Kind): Step => ({ kind, codes: [], count: 1, from: null, to: null, link: "and", within: null, nth: kind === "hero" ? 1 : null, exactly: false, before: null, negate: false });

// [~[within]][!]kind[:codes][#nth][*count[=]][<before][@from-to]
const TOKEN = /^(~(\d*))?(!)?([a-z]+)(?::([A-Za-z0-9_@.]+))?(?:#([1-3]))?(?:\*([1-9])(=)?)?(?:<([1-8]))?(?:@(\d*)-(\d*))?$/;
const CODE = /^@?[A-Za-z0-9_]{1,8}$/;

/**
 * "hero:Edem#1,trained:earc*5@-360|!expand@-540": groups split by "|", steps by ",". A step is
 * its kind and codes (split by "."), then #nth hero, *count (*1= for exactly one), <2 for before
 * step 2 and @from-to seconds of game time. A leading ~ links it to the step above with "then",
 * ~90 within 90 s; a leading ! is "did not happen".
 */
export function decodeGroups(value: string): Groups {
  const n = (v?: string) => (v ? Number(v) : null);
  return value
    .split("|")
    .map((g) =>
      g.split(",").flatMap((t, i): Step[] => {
        const m = TOKEN.exec(t);
        if (!m || !(m[4] in KINDS)) return [];
        const kind = m[4] as Kind;
        const codes = (m[5] ?? "").split(".").filter((c) => CODE.test(c));
        if (!codes.length && kind !== "expand") return [];
        const then = m[1] !== undefined && i > 0;
        return [
          {
            kind,
            codes,
            count: Number(m[7] ?? 1),
            from: n(m[10]),
            to: n(m[11]),
            link: then ? "then" : "and",
            within: then ? n(m[2]) : null,
            nth: kind === "hero" ? n(m[6]) : null,
            exactly: !!m[8] && !m[3],
            before: then ? null : n(m[9]),
            negate: !then && !!m[3],
          },
        ];
      }),
    )
    .filter((g) => g.length)
    .slice(0, 4);
}

export function encodeGroups(groups: Groups) {
  return groups
    .filter((g) => g.length)
    .map((g) =>
      g
        .map((s, i) => {
          const link = i > 0 && s.link === "then" ? `~${s.within ?? ""}` : "";
          const time = s.from === null && s.to === null ? "" : `@${s.from ?? ""}-${s.to ?? ""}`;
          const count = s.count > 1 || s.exactly ? `*${s.count}${s.exactly ? "=" : ""}` : "";
          return `${link}${s.negate ? "!" : ""}${s.kind}${s.codes.length ? `:${s.codes.join(".")}` : ""}${s.nth ? `#${s.nth}` : ""}${count}${s.before ? `<${s.before}` : ""}${time}`;
        })
        .join(","),
    )
    .join("|");
}

/** A step for POST /search. `groupCodes` gives the codes of an "@source" group; Expanded takes the halls of the side's races. */
export function apiStep(s: Step, races: string[], groupCodes: Record<string, string[]>) {
  const codes =
    s.kind === "expand"
      ? races.length
        ? [...new Set(races.map((r) => HALLS[r]).filter(Boolean))]
        : Object.values(HALLS)
      : s.codes.flatMap((c) => (c.startsWith("@") ? (groupCodes[`${s.kind}${c}`] ?? []) : [c]));
  return {
    kind: KINDS[s.kind].api,
    codes,
    count: s.count,
    from_s: s.from,
    to_s: s.to,
    link: s.link,
    within_s: s.link === "then" ? s.within : null,
    nth: s.nth,
    exactly: s.exactly,
    before: s.before,
    negate: s.negate,
  };
}

// The API's bounds: a then gap of at most 7200 s, game time inside the first 600 minutes.
export const MAX_WITHIN = 7200;
const MAX_TIME = 36000;
/** Steps in one group and groups on one side. */
export const MAX_STEPS = 8;
export const MAX_GROUPS = 4;

/** "5" (minutes) or "5:30" as whole seconds; null when blank, not a time or past 600:00. */
export function parseMss(v: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)(?::([0-5]?\d))?\s*$/.exec(v);
  if (!m || (m[2] !== undefined && m[1].includes("."))) return null;
  const s = Math.round(Number(m[1]) * 60 + Number(m[2] ?? 0));
  return s <= MAX_TIME ? s : null;
}

/** A step's game time in words: "by 6:00", "from 3:00", "3:00 to 6:00", or "". */
export function timeWords(s: Pick<Step, "from" | "to">) {
  const t = (x: number) => `${Math.floor(x / 60)}:${String(x % 60).padStart(2, "0")}`;
  if (s.from !== null && s.to !== null) return `${t(s.from)} to ${t(s.to)}`;
  if (s.to !== null) return `by ${t(s.to)}`;
  return s.from !== null ? `from ${t(s.from)}` : "";
}

/** A step's count in words: " ×3", " ×1 exactly", or "". */
export const countWords = (s: Pick<Step, "count" | "exactly">) => (s.count > 1 || s.exactly ? ` ×${s.count}${s.exactly ? " exactly" : ""}` : "");

/** "1st hero" for a hero step with nth, else the kind's word. */
export const kindWord = (s: Pick<Step, "kind" | "nth">) => (s.kind === "hero" && s.nth ? `${["1st", "2nd", "3rd"][s.nth - 1]} hero` : KINDS[s.kind].label);

/** The races a side's values play, for its town halls: NE for NE and RN, none for any race. */
export const played = (race: string[]) => [...new Set(race.map((v) => racePair(v)[0]).filter((r) => HALLS[r]))];

/**
 * A step's object as words and an icon: one object, "Archer or 2 more", "Any from Tavern" for an
 * "@source" group, or the town hall of the side's race for Expanded.
 */
export function stepObject(s: Step, race: string[], names: Objects, groups: Record<string, { name: string; icon: string | null }>) {
  const one = (c: string) => ({ name: names[c]?.name ?? c, icon: names[c]?.icon ?? null });
  if (s.kind === "expand") return played(race).length === 1 ? one(HALLS[played(race)[0]]) : { name: "Any town hall", icon: null };
  const g = s.codes[0]?.startsWith("@") ? groups[`${s.kind}${s.codes[0]}`] : null;
  if (g) return { name: `Any from ${g.name}`, icon: g.icon };
  return s.codes.length > 1 ? { ...one(s.codes[0]), name: `${one(s.codes[0]).name} or ${s.codes.length - 1} more` } : one(s.codes[0]);
}
