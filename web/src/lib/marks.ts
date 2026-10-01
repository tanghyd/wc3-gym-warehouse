// Which orders of one game fit a search side's steps, so the replay page can mark them. It reads
// a side as POST /search does (api/compile.py): a group holds when all its chains hold; a chain is
// an "and" step and the "then" steps under it; a count asks for that many orders; nth reads the
// heroes in pick order; a negated step holds when its chain finds nothing.
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

const fits = (e: GameEvent, s: ApiStep) =>
  TYPES[s.kind].includes(e.event_type) && s.codes.includes(e.code) && (s.from_s == null || e.time_ms >= s.from_s * 1000) && (s.to_s == null || e.time_ms <= s.to_s * 1000);
const hit = (n: number, e: GameEvent): Hit => ({ n, event_type: e.event_type, code: e.code, time_ms: e.time_ms });

/**
 * The orders of one chain, steps numbered from `first`, or null. Like sequenceMatch it tries every
 * pairing: the earliest orders that hold the steps in order, each "then within" step inside its gap.
 */
function chain(steps: ApiStep[], first: number, events: GameEvent[], heroes: string[]): Hit[] | null {
  for (const s of steps) if (s.nth && !s.codes.includes(heroes[s.nth - 1])) return null;
  const s = steps[0];
  if (steps.length === 1 && s.nth && s.from_s == null && s.to_s == null && s.count === 1) {
    // "1st hero X" alone is the hero list; the hero's arrival marks it
    const e = events.find((x) => x.event_type === "hero_trained" && x.code === heroes[s.nth! - 1]);
    return e ? [hit(first, e)] : [];
  }
  if (steps.length === 1) {
    const fit = events.filter((e) => fits(e, s));
    return fit.length >= s.count ? fit.slice(0, s.count).map((e) => hit(first, e)) : null;
  }
  // one slot per counted order: its step, and the most ms after the order before when it opens a "then within" step
  const slots = steps.flatMap((st, k) => Array.from({ length: st.count }, (_, c) => ({ st, k, gap: c === 0 && k > 0 && st.within_s != null ? st.within_s * 1000 : null })));
  const fit = events.filter((e) => steps.some((st) => fits(e, st)));
  const dead = new Set<string>(); // "slot/order before" with no way on from there
  // the fit indexes of slots j onward, each after the order at index `at`
  const pick = (j: number, at: number): number[] | null => {
    if (j === slots.length) return [];
    if (dead.has(`${j}/${at}`)) return null;
    const { st, gap } = slots[j];
    for (let i = at + 1; i < fit.length; i++) {
      if (gap != null && fit[i].time_ms - fit[at].time_ms > gap) break;
      if (!fits(fit[i], st)) continue;
      const rest = pick(j + 1, i);
      if (rest) return [i, ...rest];
    }
    dead.add(`${j}/${at}`);
    return null;
  };
  return pick(0, -1)?.map((i, j) => hit(first + slots[j].k, fit[i])) ?? null;
}

/** The orders of one group's steps, or null when the group does not hold. */
function group(steps: ApiStep[], events: GameEvent[], heroes: string[]): Hit[] | null {
  const out: Hit[] = [];
  for (let i = 0; i < steps.length; ) {
    let j = i + 1;
    while (j < steps.length && steps[j].link === "then") j++;
    const found = chain(steps.slice(i, j), i + 1, events, heroes);
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
