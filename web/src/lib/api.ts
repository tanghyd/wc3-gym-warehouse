// Server-side reads of the warehouse API. The browser never calls the API.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cache } from "react";
import { BINS, type Catalog, RACE_DIMS, type ValueLabel } from "./explore";
import { RACES, raceValue } from "./races";
import type { Preset, Stats } from "./strategies";
import { apiStep, KINDS, type Kind } from "./steps";

const API_URL = process.env.API_URL ?? "http://api:8000";

export type Player = { player_id: number; name: string; race: string; team_id: number; won: boolean | null };
export type Hero = { slot: number; code: string; final_level: number };
export type ReplayPlayer = Player & { apm: number; apm_per_minute: number[]; heroes: Hero[] };
// level is the skill level a skill point gives, 0 on every other event.
export type GameEvent = { player_id: number; time_ms: number; event_type: string; code: string; hero_code: string | null; level: number };
export type Chat = { time_ms: number; player_id: number; mode: string; message: string };
type Header = { replay_id: string; map: string; matchup: string; duration_ms: number; winning_team_id: number; download_url: string | null };
/** patch: the game patch from the build number, such as "3.0"; "" for a build with no patch row. */
export type Replay = Header & { patch: string; players: ReplayPlayer[]; events: GameEvent[]; chat: Chat[] };
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

/** One player of a listed player-game: his race value, his result and his heroes in pick order. */
export type SidePlayer = { name: string; race: string; won: boolean | null; heroes: { code: string; level: number }[] };
export type GameRow = { replay_id: string; map: string; duration_ms: number; player: SidePlayer; opponent: SidePlayer };
/** Player-games counted: games, wins, losses and their summed length. */
export type Tally = { games: number; wins: number; losses: number; duration_ms_total: number };
export type SearchSide = { race: string[]; name: string | null; opened_with: string[]; groups: { steps: ReturnType<typeof apiStep>[] }[]; outcome?: "win" | "loss" | null };
export type SearchRequest = { filters: Filters; player: SearchSide; opponent: SearchSide; sort: string; limit: number; offset: number };
/** both_players: games where both players fit the Player side, so each counts once per player. */
export type SearchAnswer = { total: number; summary: Tally & { both_players: number }; scope: Tally; replays: GameRow[]; sql: string; params: Record<string, string>; refused?: string };

/** POST /search: one page of the Player side's player-games, the summary and the scope. A refused request answers its reason. */
export async function searchGames(body: SearchRequest): Promise<SearchAnswer> {
  try {
    return (await api<SearchAnswer>("/search", body))!;
  } catch (e) {
    const none = { games: 0, wins: 0, losses: 0, duration_ms_total: 0 };
    if (e instanceof Refused) return { total: 0, summary: { ...none, both_players: 0 }, scope: none, replays: [], sql: "", params: {}, refused: e.message };
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

/** A picker kind: Built, Trained, Hired, Researched, Hero, Learned skill, Bought. */
export type PickerKind = "building" | "unit" | "hired" | "upgrade" | "hero" | "skill" | "item";
export type PickerObject = { code: string; name: string; games: number; icon: string | null };
/** One source of a picker (a building, altar, camp, shop, hero or race) and its objects, most ordered first. */
export type PickerGroup = { source: { code: string; name: string; icon: string | null }; objects: PickerObject[] };

/** POST /objects: the groups of a picker for a side's race values, counted over the replay filters. */
export async function pickerGroups(kind: PickerKind, race: string[], filters: Filters): Promise<PickerGroup[]> {
  const { groups } = (await api<{ groups: { source: { code: string; name: string }; objects: Omit<PickerObject, "icon">[] }[] }>("/objects", { kind, race, filters }))!;
  return groups.map((g) => ({ source: { ...g.source, icon: iconOf(g.source.code) }, objects: g.objects.map((o) => ({ ...o, icon: iconOf(o.code) })) }));
}

/** The objects of each "@source" step group, keyed "kind@source" such as "hero@ntav": codes, the group's name and icon. */
export async function stepGroups(keys: { kind: Kind; source: string }[]): Promise<Record<string, { codes: string[]; name: string; icon: string | null }>> {
  if (!keys.length) return {};
  const rows = await query<{ kind: string; source_code: string; source_name: string; code: string }>({
    model: "objects",
    dimensions: ["kind", "source_code", "source_name", "code"],
    filters: { source_code: keys.map((k) => k.source) },
    limit: 10000,
  });
  return Object.fromEntries(
    keys.map(({ kind, source }) => {
      const mine = rows.filter((r) => r.kind === KINDS[kind].picker && r.source_code === source);
      return [`${kind}@${source}`, { codes: mine.map((r) => r.code), name: mine[0]?.source_name ?? source, icon: iconOf(source) ?? iconOf(mine[0]?.code ?? "") }];
    }),
  );
}

/** GET /catalog's player_games: the dimensions and measures Explore offers, with labels and types. */
export const getCatalog = cache(async () => (await api<Record<string, Catalog>>("/catalog"))!.player_games);

/** POST /query's rows and the SQL it ran. */
export async function queryWithSql<T>(body: { dimensions?: string[]; measures?: string[]; filters?: Filters; limit?: number }) {
  return (await api<{ rows: T[]; sql: string; params: Record<string, string> }>("/query", body))!;
}

// The words of a result value.
const RESULTS: Record<string, string> = { win: "Won", loss: "Lost", unknown: "No result" };

/** How each value of each dimension shows: an object's name and icon, a race, a result, a 5-minute bin. */
export async function valueLabels(values: Record<string, string[]>): Promise<Record<string, Record<string, ValueLabel>>> {
  const coded = (d: string) => /_hero$|^opener_/.test(d);
  const objects = await getObjects([...new Set(Object.entries(values).flatMap(([d, vs]) => (coded(d) ? vs.filter(Boolean) : [])))]);
  const one = (d: string, v: string): ValueLabel => {
    if (d in RACE_DIMS) return { label: RACES[v]?.[0] ?? v, race: v };
    if (d === "result") return { label: RESULTS[v] ?? v };
    if (d === BINS) return { label: `${v}–${Number(v) + 5}` };
    if (!v) return { label: d.endsWith("_hero") ? "No hero" : d.startsWith("opener_") ? "No building" : "None" };
    if (coded(d)) return { label: objects[v]?.name ?? v, icon: objects[v]?.icon ?? null };
    return { label: v };
  };
  return Object.fromEntries(Object.entries(values).map(([d, vs]) => [d, Object.fromEntries(vs.map((v) => [v, one(d, v)]))]));
}

/** GET /strategies: every preset, each with its own steps. */
export const getPresets = cache(async () => (await api<{ strategies: Preset[] }>("/strategies"))!.strategies);

/** POST /strategies/stats: the scope's figures and each preset's of the race, and the SQL. */
export async function strategyStats(body: { race: string[]; opponent_race: string[]; filters: Filters }) {
  return (await api<{ scope: Stats; strategies: (Stats & { id: string })[]; sql: string; params: Record<string, string> }>("/strategies/stats", body))!;
}
