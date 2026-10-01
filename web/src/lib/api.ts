// Server-side reads of the warehouse API. The browser never calls the API.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cache } from "react";
import { KINDS, type StepObject } from "./steps";

const API_URL = process.env.API_URL ?? "http://api:8000";

export type Gnl = { series_id: number; game_no: number } | null;
export type Player = { player_id: number; name: string; race: string; team_id: number; won: boolean | null };
export type Hero = { slot: number; code: string; final_level: number };
export type ReplayPlayer = Player & { apm: number; apm_per_minute: number[]; heroes: Hero[] };
export type GameEvent = { player_id: number; time_ms: number; event_type: string; code: string; hero_code: string | null };
export type Chat = { time_ms: number; player_id: number; mode: string; message: string };
type Header = { replay_id: string; map: string; matchup: string; duration_ms: number; winning_team_id: number; gnl: Gnl; download_url: string | null };
export type Replay = Header & { version: string; players: ReplayPlayer[]; events: GameEvent[]; chat: Chat[] };
export type ReplayRow = Header & { focus_player_id: number; players: Player[] };
/** Name and icon path per object code; a code in no mappings row has no name. */
export type Objects = Record<string, { name?: string; icon: string | null }>;

/** One API call; null on 404. */
async function api<T>(path: string, body?: object): Promise<T | null> {
  const res = await fetch(API_URL + path, {
    cache: "no-store",
    ...(body && { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

// cache(): the page and its metadata share one read per request.
export const getReplay = cache((id: string) => api<Replay>(`/replays/${encodeURIComponent(id)}`));

/** A dimension's allowed values, or a numeric range. */
export type Filters = Record<string, string[] | { gte?: number; lte?: number }>;
export type ApiStep = { type: string; code: string; within_prev_s: number | null; from_min: number | null; to_min: number | null };

/** POST /search: the focus player's filters and steps, then other players of the same game. */
export async function searchReplays(body: { filters: Filters; steps?: ApiStep[]; others?: { filters: Filters; steps: ApiStep[] }[] }) {
  return (await api<{ replays: ReplayRow[]; sql: string; params: Record<string, string> }>("/search", body))!;
}

/** The rows of POST /query. */
export async function query<T>(body: { model?: string; dimensions?: string[]; measures?: string[]; filters?: Filters; order_by?: string[]; limit?: number }) {
  return (await api<{ rows: T[] }>("/query", body))!.rows;
}

/** Every value of one player_games dimension, for a picker. */
export async function pickerValues(dimension: "map" | "player") {
  const rows = await query<Record<string, string>>({ dimensions: [dimension], measures: ["games"], order_by: [dimension], limit: 10000 });
  return rows.map((r) => r[dimension]);
}

let iconFiles: Record<string, string> | undefined;

/** An object's command-card icon from public/icons.json, or null. */
function iconOf(code: string) {
  iconFiles ??= JSON.parse(readFileSync(join(process.cwd(), "public/icons.json"), "utf8")) as Record<string, string>;
  return iconFiles[code] ? `/icons/${iconFiles[code]}` : null;
}

/** Every object a build-order step can name, by name. */
export async function stepObjects(): Promise<StepObject[]> {
  const rows = await query<Omit<StepObject, "icon">>({
    model: "mappings",
    dimensions: ["code", "name", "kind", "hero"],
    filters: { kind: Object.keys(KINDS) },
    order_by: ["name", "code"],
    limit: 10000,
  });
  return rows.filter((r) => r.name).map((r) => ({ ...r, icon: iconOf(r.code) }));
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
