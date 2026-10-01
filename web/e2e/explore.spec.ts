import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, fmt, mss, record } from "./helpers";

// The Explore page: every table equals POST /query's rows, the chart follows the rule, and each
// change of the query card lands in the URL.
type Row = Record<string, string | number>;
const RACE: Record<string, string> = { HU: "Human", OC: "Orc", NE: "Night Elf", UD: "Undead", RANDOM: "Random" };
const RANDOM: Record<string, string> = { HU: "Random Human", OC: "Random Orc", NE: "Random Night Elf", UD: "Random Undead", RANDOM: "Random" };
const raceWords = (race: string, random: number) => (random ? RANDOM[race] : RACE[race]);
// the page's default filter: games of 2 minutes or more
const MIN2 = { duration_ms: { gte: 120000 } };

async function rowsOf(request: APIRequestContext, dimensions: string[], measures: string[], filters: object): Promise<Row[]> {
  const res = await request.post(`${API}/query`, { data: { dimensions, measures, filters, limit: 10000 } });
  if (!res.ok()) throw new Error(`POST /query answered ${res.status()}: ${await res.text()}`);
  return (await res.json()).rows;
}

async function names(request: APIRequestContext, codes: string[]): Promise<Record<string, string>> {
  const res = await request.post(`${API}/query`, { data: { model: "mappings", dimensions: ["code", "name", "kind"], filters: { code: codes }, limit: 10000 } });
  const out: Record<string, string> = {};
  for (const r of (await res.json()).rows as { code: string; name: string; kind: string }[]) if (r.kind !== "unknown" || !out[r.code]) out[r.code] = r.name;
  return out;
}

/** Every table row as the page prints it, after "Show all". */
async function table(page: Page) {
  const all = page.getByRole("button", { name: /^Show all/ });
  if (await all.count()) await all.click();
  return page.locator(".x-table tbody tr").evaluateAll((trs) => trs.map((tr) => [...(tr as HTMLTableRowElement).cells].map((c) => c.innerText.replace(/\u00a0/g, " ").trim()).join(" | ")));
}
const sorted = (xs: string[]) => [...xs].sort();

test.describe("explore", () => {
  test("the default view is games by race and opponent race over games of 2 minutes or more", async ({ page, request }) => {
    const rows = await rowsOf(request, ["race", "random", "opponent_race", "opponent_random"], ["games", "wins", "losses", "minutes_total"], MIN2);
    await page.goto("/explore");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Explore");
    await expect(page.getByRole("link", { name: "Explore" })).toHaveAttribute("aria-current", "page");
    for (const m of ["Games", "Record", "Avg length"]) await expect(page.getByRole("button", { name: m, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Avg APM", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: "Minutes: 2 or more" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Games by Race and Opponent Race");
    const total = rows.reduce((s, r) => s + Number(r.games), 0);
    await expect(page.locator("#result-title ~ .chip")).toHaveText(`${fmt(total)} games`);

    const want = rows.map((r) =>
      [raceWords(String(r.race), Number(r.random)), raceWords(String(r.opponent_race), Number(r.opponent_random)), fmt(Number(r.games)), record(Number(r.wins), Number(r.losses)), mss((Number(r.minutes_total) / Number(r.games)) * 60000)].join(" | "),
    );
    const got = await table(page);
    expect(sorted(got)).toEqual(sorted(want));
    // largest first
    const games = got.map((l) => Number(l.split(" | ")[2].replace(/,/g, "")));
    expect(games).toEqual([...games].sort((a, b) => b - a));

    // two dimensions and a count: a heat map whose cells add up to the total
    const grid = page.getByRole("grid");
    await expect(grid).toBeVisible();
    const cells = await grid.getByRole("gridcell").evaluateAll((els) => els.map((e) => Number(e.textContent!.replace(/,/g, ""))));
    expect(cells.reduce((a, b) => a + b, 0)).toBe(total);
    // the four bins plus zero name their ranges in the legend
    await expect(page.getByRole("list", { name: "Legend" })).toContainText("50 or more");
  });

  test("first hero by opponent race for Night Elf, as the mockup, equals POST /query", async ({ page, request }) => {
    const filters = { race: ["NE"], random: [0], ...MIN2 };
    const rows = await rowsOf(request, ["first_hero", "opponent_race", "opponent_random"], ["games", "wins", "losses", "minutes_total"], filters);
    const name = await names(request, rows.map((r) => String(r.first_hero)).filter(Boolean));
    await page.goto("/explore?rows=first_hero&cols=opponent_race&race=NE");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Games by First Hero and Opponent Race");
    await expect(page.getByRole("button", { name: "Race: Night Elf" })).toBeVisible();
    const want = rows.map((r) =>
      [r.first_hero ? name[String(r.first_hero)] : "No hero", raceWords(String(r.opponent_race), Number(r.opponent_random)), fmt(Number(r.games)), record(Number(r.wins), Number(r.losses)), mss((Number(r.minutes_total) / Number(r.games)) * 60000)].join(
        " | ",
      ),
    );
    expect(sorted(await table(page))).toEqual(sorted(want));
    // at most 8 rows of heroes, the smallest folded into Other
    const heroes = new Set(rows.map((r) => r.first_hero));
    await expect(page.getByRole("grid").getByRole("rowheader")).toHaveCount(Math.min(8, heroes.size) + 1);
    // a cell's tooltip names its value first
    const cell = page.getByRole("gridcell").first();
    await cell.hover();
    await expect(cell.getByRole("status")).toContainText(/^[\d,]+ games/);
  });

  test("one dimension is a bar per value, the top 12 and Other, and the table holds every row", async ({ page, request }) => {
    const rows = await rowsOf(request, ["map"], ["games", "players"], MIN2);
    await page.goto("/explore?show=games,players&rows=map");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Games by Map");
    const bars = page.getByRole("list", { name: /^Games by Map/ }).getByRole("listitem");
    await expect(bars).toHaveCount(Math.min(13, rows.length));
    const want = rows.map((r) => [String(r.map), fmt(Number(r.games)), fmt(Number(r.players))].join(" | "));
    expect(sorted(await table(page))).toEqual(sorted(want));
    // the largest bar's value sits at its tip
    const top = [...rows].sort((a, b) => Number(b.games) - Number(a.games))[0];
    await expect(bars.first()).toContainText(fmt(Number(top.games)));
  });

  test("minutes is ordered, so its columns keep their order; no dimension shows tiles", async ({ page, request }) => {
    const rows = await rowsOf(request, ["minutes_5"], ["games"], MIN2);
    await page.goto("/explore?show=games&rows=minutes_5");
    const cols = page.getByRole("list", { name: /^Games by Minutes/ }).getByRole("listitem");
    await expect(cols).toHaveCount(rows.length);
    const labels = await cols.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")!.split(":")[0]));
    const bins = rows.map((r) => Number(r.minutes_5)).sort((a, b) => a - b);
    expect(labels).toEqual(bins.map((b) => `${b}–${b + 5}`));

    const [all] = await rowsOf(request, [], ["games", "wins", "losses", "apm_total"], MIN2);
    await page.goto("/explore?show=games,record,avg_apm&rows=");
    await expect(page.locator(".stat")).toHaveCount(3);
    await expect(page.locator(".stat").nth(0)).toContainText(fmt(Number(all.games)));
    await expect(page.locator(".stat").nth(1)).toContainText(record(Number(all.wins), Number(all.losses)));
    await expect(page.locator(".stat").nth(2)).toContainText(fmt(Math.round(Number(all.apm_total) / Number(all.games))));
  });

  test("a record alone and three dimensions get no chart, only the table", async ({ page, request }) => {
    await page.goto("/explore?show=record&rows=race&cols=opponent_race");
    await expect(page.locator(".x-table")).toBeVisible();
    await expect(page.getByRole("grid")).toHaveCount(0);
    const rows = await rowsOf(request, ["race", "random", "result", "opponent_race", "opponent_random"], ["games"], MIN2);
    await page.goto("/explore?show=games&rows=race,result&cols=opponent_race");
    await expect(page.getByRole("grid")).toHaveCount(0);
    await expect(page.getByRole("list", { name: /^Games by/ })).toHaveCount(0);
    expect((await table(page)).length).toBe(rows.length);
  });

  test("the query card writes each change to the URL: a measure, a row, a filter", async ({ page, request }) => {
    await page.goto("/explore");
    await page.getByRole("button", { name: "Avg APM", exact: true }).click();
    await expect(page).toHaveURL(/[?&]show=games%2Crecord%2Cavg_minutes%2Cavg_apm(&|$)/);
    await expect(page.locator(".x-table thead")).toContainText("Avg APM");

    await page.getByRole("button", { name: "Remove Opponent race from columns" }).click();
    await expect(page).not.toHaveURL(/cols=/);
    await expect(page.getByRole("list", { name: /^Games by Race/ })).toBeVisible();

    // a checked map narrows every figure; the chip names it
    const [top] = await rowsOf(request, ["map"], ["games"], MIN2);
    await page.getByRole("button", { name: "Add filter" }).click();
    await page.getByRole("dialog", { name: "Add filter" }).getByRole("button", { name: "Map", exact: true }).click();
    const list = page.getByRole("dialog", { name: "Map filter" });
    await list.getByRole("checkbox").first().check();
    await expect(page).toHaveURL(new RegExp(`[?&]map=${encodeURIComponent(String(top.map)).replace(/%20/g, "\\+")}(&|$)`));
    await expect(page.getByRole("button", { name: `Map: ${top.map}` })).toBeVisible();
    const rows = await rowsOf(request, ["race", "random"], ["games"], { ...MIN2, map: [top.map] });
    await expect(page.locator("#result-title ~ .chip")).toHaveText(`${fmt(rows.reduce((s, r) => s + Number(r.games), 0))} games`);

    // removing the minutes filter keeps it removed on reload
    await page.getByRole("button", { name: "Remove the Minutes filter" }).click();
    await expect(page).toHaveURL(/[?&]min=(&|$)/);
    await page.reload();
    await expect(page.getByRole("button", { name: /^Minutes:/ })).toHaveCount(0);
  });

  test("fits a phone: no sideways scroll, five columns at most", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/explore?rows=first_hero&cols=opponent_race&race=NE");
    await expect(page.getByRole("grid").getByRole("columnheader")).toHaveCount(6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // the table fits its card: Avg length, the third measure, is hidden, so no figure is cut at the edge
    const table = page.locator("table.x-table");
    await expect(table.getByRole("columnheader", { name: "Avg length" })).toBeHidden();
    expect(await table.evaluate((t) => t.scrollWidth <= t.parentElement!.clientWidth)).toBeTruthy();
  });
});
