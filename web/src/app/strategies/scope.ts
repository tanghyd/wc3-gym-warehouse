// What both Strategies tabs read from the URL: the race, the opponent race, the map and the minutes.
import type { Filters } from "@/lib/api";
import { parseRaces } from "@/lib/races";

type Search = Record<string, string | string[] | undefined>;

/**
 * The scope of a Strategies tab. The race is required (Human when none); minutes start at 2 or
 * more, and an empty min= keeps them open. `pairs` are the URL keys a link to the other tab, to
 * Replays or to an open row carries.
 */
export function readScope(sp: Search) {
  const value = (k: string) => (typeof sp[k] === "string" ? sp[k] : "");
  const picked = parseRaces(value("race")).filter((v) => v !== "R");
  const race = picked.length ? picked : ["HU"];
  const opp = parseRaces(value("opponent_race"));
  const [map, max] = [value("map"), value("max")];
  const min = sp.min === undefined ? "2" : value("min");
  const filters: Filters = map ? { map: [map] } : {};
  const ms = (v: string) => (v && Number.isFinite(Number(v)) ? Number(v) * 60000 : undefined);
  if (ms(min) !== undefined || ms(max) !== undefined) filters.duration_ms = { gte: ms(min), lte: ms(max) };
  const pairs: [string, string][] = [["race", race.join(",")], ...(opp.length ? [["opponent_race", opp.join(",")] as [string, string]] : []), ...(map ? [["map", map] as [string, string]] : []), ["min", min], ...(max ? [["max", max] as [string, string]] : [])];
  return { value, race, opp, map, min, max, filters, pairs };
}
