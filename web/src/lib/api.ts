// Server-side reads of the warehouse API. The browser never calls the API.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cache } from "react";
import { raceValue } from "./races";
import { KINDS, letterOf, type StepObject } from "./steps";

const API_URL = process.env.API_URL ?? "http://api:8000";

export type Player = { player_id: number; name: string; race: string; team_id: number; won: boolean | null };
export type Hero = { slot: number; code: string; final_level: number };
export type ReplayPlayer = Player & { apm: number; apm_per_minute: number[]; heroes: Hero[] };
/** A player of a search row: his heroes in pick order. */
export type RowPlayer = Player & { heroes: Omit<Hero, "slot">[] };
export type GameEvent = { player_id: number; time_ms: number; event_type: string; code: string; hero_code: string | null };
export type Chat = { time_ms: number; player_id: number; mode: string; message: string };
type Header = { replay_id: string; map: string; matchup: string; duration_ms: number; winning_team_id: number; download_url: string | null };
/** patch: the game patch from the build number, such as "3.0"; "" for a build with no patch row. */
export type Replay = Header & { patch: string; players: ReplayPlayer[]; events: GameEvent[]; chat: Chat[] };
export type ReplayRow = Header & { focus_player_id: number; players: RowPlayer[] };
/** Name and icon path per object code; a code in no mappings row has no name. */
export type Objects = Record<string, { name?: string; icon: string | null }>;

/** A request the API refused (400, 422), with the API's own text. */
class Refused extends Error {}

// A 400 detail is text; FastAPI's 422 detail is a list of {loc, msg}, loc led by "body".
type Detail = string | { loc: (string | number)[]; msg: string }[];
const detailText = (d: Detail) => (typeof d === "string" ? d : d.map((e) => `${e.loc.slice(1).join(".")}: ${e.msg}`).join("; "));

/** One API call; null on 404. */
async function api<T>(path: string, body?: object): Promise<T | null> {
  const res = await fetch(API_URL + path, {
    cache: "no-store",
    ...(body && { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (res.status === 404) return null;
  if (res.status === 400 || res.status === 422) throw new Refused(detailText((await res.json()).detail));
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

// cache(): the page and its metadata share one read per request.
export const getReplay = cache((id: string) => api<Replay>(`/replays/${encodeURIComponent(id)}`));

/** A dimension's allowed values, or a numeric range. */
export type Filters = Record<string, (string | number)[] | { gte?: number; lte?: number }>;
export type ApiStep = { type: string; code: string; within_prev_s: number | null; from_min: number | null; to_min: number | null };

type Search = { replays: ReplayRow[]; sql: string; params: Record<string, string>; refused?: string };

/** POST /search: the focus player's filters and steps, then his opponent's. A refused request answers its reason. */
export async function searchReplays(body: { filters: Filters; steps?: ApiStep[]; others?: { filters: Filters; steps: ApiStep[] }[]; limit: number }): Promise<Search> {
  try {
    return (await api<Search>("/search", body))!;
  } catch (e) {
    if (e instanceof Refused) return { replays: [], sql: "", params: {}, refused: e.message };
    throw e;
  }
}

/** The rows of POST /query. */
export async function query<T>(body: { model?: string; dimensions?: string[]; measures?: string[]; filters?: Filters; order_by?: string[]; limit?: number }) {
  return (await api<{ rows: T[] }>("/query", body))!.rows;
}

/** Every value of one player_games dimension, for a picker; "" is the picker's Any, so it drops out. */
export async function pickerValues(dimension: "map" | "patch" | "player") {
  const rows = await query<Record<string, string>>({ dimensions: [dimension], measures: ["games"], order_by: [dimension], limit: 10000 });
  return rows.map((r) => r[dimension]).filter(Boolean);
}

let iconFiles: Record<string, string> | undefined;

/** An object's command-card icon from public/icons.json, or null. */
function iconOf(code: string) {
  iconFiles ??= JSON.parse(readFileSync(join(process.cwd(), "public/icons.json"), "utf8")) as Record<string, string>;
  return iconFiles[code] ? `/icons/${iconFiles[code]}` : null;
}

/** Every object a build-order step can name, by name. */
export async function stepObjects(): Promise<StepObject[]> {
  const rows = await query<Omit<StepObject, "icon" | "letter">>({
    model: "mappings",
    dimensions: ["code", "name", "kind", "hero"],
    filters: { kind: Object.keys(KINDS) },
    order_by: ["name", "code"],
    limit: 10000,
  });
  const heroCodes = Object.fromEntries(rows.filter((r) => r.kind === "hero").map((r) => [r.name, r.code]));
  return rows.filter((r) => r.name).map((r) => ({ ...r, icon: iconOf(r.code), letter: letterOf(r, heroCodes) }));
}

/** Names from the mappings model in one read, icons from public/icons.json. */
export async function getObjects(codes: string[]): Promise<Objects> {
  if (!codes.length) return {};
  const res = await query<{ code: string; name: string; kind: string }>({
    model: "mappings",
    dimensions: ["code", "name", "kind"],
    filters: { code: codes },
    order_by: ["code"],
    limit: 10000,
  });
  const names = new Map<string, string>();
  // A melee row wins; a custom-map row (kind "unknown", such as ewsp "Glowworm") only fills a gap.
  const rows = [...res].sort((a, b) => Number(a.kind === "unknown") - Number(b.kind === "unknown"));
  for (const r of rows) if (!names.has(r.code)) names.set(r.code, r.name);
  return Object.fromEntries(codes.map((c) => [c, { name: names.get(c) || undefined, icon: iconOf(c) }]));
}

/** Player-games per race value (HU, RN, R, ...) under the filters, for the counts of a race menu. */
export async function raceCounts(filters: Filters): Promise<Record<string, number>> {
  const rows = await query<{ race: string; random: number; games: number }>({ dimensions: ["race", "random"], measures: ["games"], filters, limit: 100 });
  const counts: Record<string, number> = {};
  for (const r of rows) counts[raceValue(r.race, r.random)] = (counts[raceValue(r.race, r.random)] ?? 0) + r.games;
  return counts;
}
