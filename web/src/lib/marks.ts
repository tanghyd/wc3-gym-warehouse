// Which orders of one game fit a search side's steps, so the replay page can mark them. It reads
// a side as POST /search does (api/compile.py): a group holds when all its chains hold; a chain is
// an "and" step and the "then" steps under it, each a block of `count` orders after the order that
// completes the step above, all within the gap of a "then within" step; nth reads the heroes in pick
// order; a "before" step bounds the step it names; a negated step holds when its chain finds nothing.
import type { GameEvent } from "./api";
import type { apiStep } from "./steps";

type ApiStep = ReturnType<typeof apiStep>;
/** One order a step matched: the step's number in its group and the event. */
export type Hit = { n: number; event_type: string; code: string; time_ms: number };

// The replay page's event types of each step kind.
const TYPES: Record<string, string[]> = {
  building: ["building"],
  unit: ["unit"],
  upgrade: ["upgrade"],
  item: ["item"],
  hero: ["hero_trained"],
  skill: ["hero_skill"],
};

const fits = (e: GameEvent, s: ApiStep, heroes: string[]) =>
  TYPES[s.kind].includes(e.event_type) &&
  s.codes.includes(e.code) &&
  (s.nth == null || e.code === heroes[s.nth - 1]) &&
  (s.from_s == null || e.time_ms >= s.from_s * 1000) &&
  (s.to_s == null || e.time_ms <= s.to_s * 1000);
const hit = (n: number, e: GameEvent): Hit => ({ n, event_type: e.event_type, code: e.code, time_ms: e.time_ms });

/** Whether a "before" step holds before `end` ms: none of its orders when negated, else exactly or at least `count`. */
function holdsBefore(s: ApiStep, end: number, events: GameEvent[], heroes: string[]) {
  const n = events.filter((e) => fits(e, s, heroes) && e.time_ms < end).length;
  return s.negate ? n === 0 : s.exactly ? n === s.count : n >= s.count;
}

/**
 * The orders of one chain, steps numbered from `first`, or null. `bounds` holds the "before" steps
 * naming each chain step. Like the search it tries every end of each block, earliest first.
 */
function chain(steps: ApiStep[], first: number, events: GameEvent[], heroes: string[], bounds: ApiStep[][]): Hit[] | null {
  const s = steps[0];
  if (steps.length === 1 && !bounds[0].length && s.nth && s.from_s == null && s.to_s == null && s.count === 1 && !s.exactly) {
    // "1st hero X" alone is the hero list; the hero's arrival marks it
    if (!s.codes.includes(heroes[s.nth - 1])) return null;
    const e = events.find((x) => x.event_type === "hero_trained" && x.code === heroes[s.nth! - 1]);
    return e ? [hit(first, e)] : [];
  }
  const fit = steps.map((st) => events.filter((e) => fits(e, st, heroes)));
  if (steps.some((st, k) => st.exactly && fit[k].length > st.count)) return null;
  const dead = new Set<string>(); // "step/ms" with no way on from there
  // the orders of steps k onward, each block after `after`, the ms the step above is complete
  const from = (k: number, after: number): Hit[] | null => {
    if (k === steps.length) return [];
    if (dead.has(`${k}/${after}`)) return null;
    const st = steps[k];
    const xs = k === 0 ? fit[0] : fit[k].filter((e) => e.time_ms > after);
    for (let i = st.count - 1; i < xs.length; i++) {
      const end = xs[i].time_ms;
      if (k > 0 && st.within_s != null && end > after + st.within_s * 1000) break;
      if (!bounds[k].every((b) => holdsBefore(b, end, events, heroes))) continue;
      const rest = from(k + 1, end);
      if (rest) return [...xs.slice(i - st.count + 1, i + 1).map((e) => hit(first + k, e)), ...rest];
    }
    dead.add(`${k}/${after}`);
    return null;
  };
  return from(0, -1);
}

/** The orders of one group's steps, or null when the group does not hold. */
function group(steps: ApiStep[], events: GameEvent[], heroes: string[]): Hit[] | null {
  const out: Hit[] = [];
  for (let i = 0; i < steps.length; ) {
    let j = i + 1;
    if (steps[i].before != null) {
      i = j; // a "before" step bounds the step it names
      continue;
    }
    while (j < steps.length && steps[j].link === "then") j++;
    const bounds = steps.slice(i, j).map((_, k) => steps.filter((b) => b.before === i + k + 1));
    const found = chain(steps.slice(i, j), i + 1, events, heroes, bounds);
    if (steps[i].negate ? found !== null : found === null) return null;
    if (!steps[i].negate) out.push(...found!);
    i = j;
  }
  return out;
}

/**
 * The first group of a side that holds in this game, and the orders each of its steps matched.
 * `events` are one player's, in time order; `heroes` his heroes in pick order.
 */
export function matchSide(groups: ApiStep[][], events: GameEvent[], heroes: string[]): { group: number; hits: Hit[] } | null {
  for (const [g, steps] of groups.entries()) {
    const hits = group(steps, events, heroes);
    if (hits) return { group: g, hits };
  }
  return null;
}
