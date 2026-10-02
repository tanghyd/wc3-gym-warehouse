import type { APIRequestContext, Page } from "@playwright/test";

// What the Replays page and POST /search share: the request, the answer and the page's reading of it.
export const API = process.env.API_URL ?? "http://api:8000";

export type Step = { kind: string; codes: string[]; count?: number; from_s?: number; to_s?: number; link?: "and" | "then"; within_s?: number; nth?: number; exactly?: boolean; before?: number; negate?: boolean };
export type Side = { race?: string[]; name?: string; outcome?: "win" | "loss"; opened_with?: string[]; groups?: { steps: Step[] }[] };
export type Search = { filters?: object; player?: Side; opponent?: Side; sort?: string; limit?: number; offset?: number };
type Tally = { games: number; wins: number; losses: number; duration_ms_total: number };
type SidePlayer = { name: string; race: string; won: boolean | null; heroes: { code: string; level: number }[] };
export type Answer = {
  total: number;
  summary: Tally & { both_players: number };
  scope: Tally;
  replays: { replay_id: string; map: string; duration_ms: number; player: SidePlayer; opponent: SidePlayer }[];
};

/** POST /search with the page's page size. */
export async function search(request: APIRequestContext, body: Search): Promise<Answer> {
  const res = await request.post(`${API}/search`, { data: { limit: 25, ...body } });
  if (!res.ok()) throw new Error(`POST /search answered ${res.status()}: ${await res.text()}`);
  return res.json();
}

/** The codes of one picker group, such as every Tavern hero. */
export async function groupCodes(request: APIRequestContext, kind: string, source: string): Promise<string[]> {
  const res = await request.post(`${API}/query`, { data: { model: "objects", dimensions: ["code"], filters: { kind: [kind], source_code: [source] }, limit: 1000 } });
  return (await res.json()).rows.map((r: { code: string }) => r.code);
}

/** Each listed row as replay id, Player and Opponent: the API's rows read the same. */
export const listed = (page: Page) =>
  page.locator("table.games tbody tr").evaluateAll((trs) =>
    trs.map((tr) => [tr.querySelector('a[href^="/replays/"]')!.getAttribute("href")!.split("?")[0].split("/").pop(), tr.querySelector(".c-p .font-name")!.textContent, tr.querySelector(".c-o .font-name")!.textContent].join(" ")),
  );
export const rowsOf = (a: Answer) => a.replays.map((r) => [r.replay_id, r.player.name, r.opponent.name].join(" "));

export const fmt = (n: number) => n.toLocaleString("en-US");
export const record = (w: number, l: number) => (w + l ? `${w} – ${l}` + (w + l >= 10 ? ` (${Math.round((100 * w) / (w + l))}%)` : "") : "—");
export const mss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

/** The Games chip and the strip's two figures. */
export async function strip(page: Page) {
  const value = (label: string) => page.locator(".stat").filter({ has: page.locator(".s-l", { hasText: label }) }).locator(".s-v").textContent();
  return { total: await page.locator(".bar .chip").textContent(), games: await value("Games"), record: await value("Player record") };
}
export const stripOf = (a: Answer) => ({
  total: fmt(a.total),
  games: fmt(a.summary.games),
  record: record(a.summary.wins, a.summary.losses),
});

/** The Replays URL of a side's steps, as the page encodes them. */
export const q = (params: Record<string, string>) => `/?${new URLSearchParams(params)}`;
