import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, fmt, mss, record, search, type Step, strip, stripOf } from "./helpers";

// The Named tab of Strategies: every preset row equals POST /strategies/stats, and its Games link
// lands on Replays with POST /search's answer for the preset's steps. Games of 2 minutes or more.
type Preset = { id: string; name: string; race: string; parent_id: string | null; steps: Step[] };
type Stats = { games: number; wins: number | null; losses: number | null; duration_ms_total: number; both: number };
type Answer = { scope: Stats; strategies: (Stats & { id: string })[] };
const MIN2 = { duration_ms: { gte: 120000 } };

async function presets(request: APIRequestContext): Promise<Map<string, Preset>> {
  const all: Preset[] = (await (await request.get(`${API}/strategies`)).json()).strategies;
  return new Map(all.map((p) => [p.id, p]));
}
async function stats(request: APIRequestContext, race: string[], filters: object = MIN2, opponent_race: string[] = []): Promise<Answer> {
  const res = await request.post(`${API}/strategies/stats`, { data: { race, opponent_race, filters } });
  if (!res.ok()) throw new Error(`POST /strategies/stats answered ${res.status()}: ${await res.text()}`);
  return res.json();
}
const whole = (p: Preset, all: Map<string, Preset>) => [...(p.parent_id ? all.get(p.parent_id)!.steps : []), ...p.steps];

/** Each row as the page prints it: name, games, share, record, length. */
const rows = (page: Page) =>
  page.locator("table.named tbody tr:not(.rule-row)").evaluateAll((trs) =>
    trs.map((tr) => {
      const c = (tr as HTMLTableRowElement).cells;
      return [c[0].querySelector("p")!.firstChild!.textContent, c[1].innerText, c[2].innerText, c[3].innerText.replace(/\s+/g, " "), c[4].innerText].join(" | ");
    }),
  );
const pct = (n: number, of: number) => `${(of ? (100 * n) / of : 0).toFixed(1)}%`;
const line = (p: Preset, s: Stats, of: number) => [p.name, fmt(s.games), pct(s.games, of), record(s.wins ?? 0, s.losses ?? 0), s.games ? mss(s.duration_ms_total / s.games) : "—"].join(" | ");

test.describe("strategies", () => {
  test("Human by default: each top preset's figures equal POST /strategies/stats, most games first", async ({ page, request }) => {
    const [all, answer] = await Promise.all([presets(request), stats(request, ["HU"])]);
    expect(answer.strategies.length).toBe([...all.values()].filter((p) => p.race === "HU").length);
    await page.goto("/strategies");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Strategies");
    await expect(page.getByRole("link", { name: "Named", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("link", { name: "Strategies" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "Race: Human" })).toBeVisible();
    await expect(page.getByLabel("Minutes from")).toHaveValue("2");
    await expect(page.locator("#named-title ~ .chip")).toHaveText(`${fmt(answer.scope.games)} games`);
    // a preset under 5 games is hidden, and Human has some
    expect(answer.strategies.some((s) => s.games < 5)).toBe(true);
    const top = answer.strategies.filter((s) => !all.get(s.id)!.parent_id && s.games >= 5).sort((a, b) => b.games - a.games || all.get(a.id)!.name.localeCompare(all.get(b.id)!.name));
    expect(await rows(page)).toEqual(top.map((s) => line(all.get(s.id)!, s, answer.scope.games)));
  });

  test("each Human preset's games are POST /search's summary for its steps, and a Games link opens them", async ({ page, request }) => {
    const [all, answer] = await Promise.all([presets(request), stats(request, ["HU"])]);
    for (const s of answer.strategies) {
      const found = await search(request, { filters: MIN2, player: { race: ["HU"], groups: [{ steps: whole(all.get(s.id)!, all) }] } });
      expect(found.summary.games, s.id).toBe(s.games);
      expect([found.summary.wins, found.summary.losses, found.summary.duration_ms_total], s.id).toEqual([s.wins, s.losses, s.duration_ms_total]);
    }
    const first = [...answer.strategies].sort((a, b) => b.games - a.games)[0];
    const p = all.get(first.id)!;
    await page.goto("/strategies");
    await page.getByRole("link", { name: `List the ${fmt(first.games)} games of ${p.name}` }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Replays");
    await expect(page).toHaveURL(/[?&]race=HU&min=2&steps=/);
    const want = await search(request, { filters: MIN2, player: { race: ["HU"], groups: [{ steps: whole(p, all) }] } });
    expect(await strip(page)).toEqual(stripOf(want));
  });

  test("a parent opens its variants, each a share of its parent", async ({ page, request }) => {
    const [all, answer] = await Promise.all([presets(request), stats(request, ["HU"], MIN2, ["NE"])]);
    const parent = "hu-am";
    const figures = new Map(answer.strategies.map((s) => [s.id, s]));
    const kids = answer.strategies.filter((s) => all.get(s.id)!.parent_id === parent).sort((a, b) => b.games - a.games || all.get(a.id)!.name.localeCompare(all.get(b.id)!.name));
    expect(kids.map((k) => k.games >= 5)).toEqual([true, true, true]);
    // a variant holds its parent's steps, so it never passes its parent
    for (const k of kids) expect(k.games).toBeLessThanOrEqual(figures.get(parent)!.games);
    await page.goto("/strategies?race=HU&opponent_race=NE");
    const name = all.get(parent)!.name;
    await page.getByRole("link", { name: `Show the variants of ${name}` }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]open=${parent}$`));
    const got = await rows(page);
    const at = got.findIndex((r) => r.startsWith(`${name} |`));
    expect(got.slice(at + 1, at + 1 + kids.length)).toEqual(kids.map((k) => line(all.get(k.id)!, k, figures.get(parent)!.games)));
    await page.getByRole("link", { name: `Hide the variants of ${name}` }).click();
    await expect(page).not.toHaveURL(/open=/);
  });

  test("a guide's vs label shows only when the opponent filter is one of its races", async ({ page, request }) => {
    const p = (await presets(request)).get("standard-human-mirror-build")!;
    for (const [url, label] of [["/strategies?race=HU", null], ["/strategies?race=HU&opponent_race=HU", "vs Human"], ["/strategies?race=HU&opponent_race=NE", null]]) {
      await page.goto(url!);
      const name = page.locator("table.named tbody tr:not(.rule-row) td:first-child p").filter({ hasText: p.name });
      await expect(name, url!).toHaveCount(1);
      if (label) await expect(name.locator("span"), url!).toHaveText(label);
      else await expect(name.locator("span"), url!).toHaveCount(0);
    }
  });

  test("a filter change reads the stats again: map, opponent race, minutes", async ({ page, request }) => {
    await page.goto("/strategies?race=OC");
    await page.getByLabel("Minutes from").fill("10");
    await page.getByLabel("Minutes from").press("Enter");
    await expect(page).toHaveURL(/[?&]min=10(&|$)/);
    const answer = await stats(request, ["OC"], { duration_ms: { gte: 600000 } });
    await expect(page.locator("#named-title ~ .chip")).toHaveText(`${fmt(answer.scope.games)} games`);
  });

  test("Load a strategy fills a side's steps from a preset of its race", async ({ page, request }) => {
    const all = await presets(request);
    const p = all.get("hu-am-expo")!;
    await page.goto("/?race=HU");
    const player = page.getByRole("region", { name: "Player", exact: true });
    await player.getByRole("button", { name: "Load a strategy" }).click();
    await player.getByRole("menuitem", { name: p.name, exact: true }).click();
    await expect(player.getByRole("button", { name: /^Step 1: 1st hero Archmage/ })).toBeVisible();
    await expect(player.getByRole("button", { name: /^Step 2: Expanded Town Hall/ })).toBeVisible();
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/[?&]steps=/);
    const want = await search(request, { player: { race: ["HU"], groups: [{ steps: whole(p, all) }] } });
    expect(await strip(page)).toEqual(stripOf(want));
  });

  test("the Human tower rush counts the same on Replays: its Games link and Load a strategy keep the forward step", async ({ page, request }) => {
    const [all, answer] = await Promise.all([presets(request), stats(request, ["HU"])]);
    const p = all.get("hu-tower-rush")!;
    expect(p.steps.some((s) => s.forward)).toBe(true);
    const want = answer.strategies.find((s) => s.id === p.id)!;
    expect(want.games).toBeGreaterThanOrEqual(5);
    await page.goto("/strategies");
    await page.getByRole("link", { name: `List the ${fmt(want.games)} games of ${p.name}`, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Replays");
    await expect(page).toHaveURL(/[?&]steps=[^&]*%5E/);
    expect((await strip(page)).games).toBe(fmt(want.games));
    // the same preset loaded into a fresh search, games of 2 minutes or more as on Strategies
    await page.goto("/?race=HU&min=2");
    const player = page.getByRole("region", { name: "Player", exact: true });
    await player.getByRole("button", { name: "Load a strategy" }).click();
    await player.getByRole("menuitem", { name: p.name, exact: true }).click();
    await expect(player.getByText("Forward", { exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/[?&]steps=[^&]*%5E/);
    expect((await strip(page)).games).toBe(fmt(want.games));
  });

  test("fits a phone: no sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const url of ["/strategies?race=UD&open=ud-cl-necro-mw", "/strategies/openers?race=NE&open=eate"]) {
      await page.goto(url);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), url).toBeLessThanOrEqual(390);
      // the table fits its card, so no figure is cut at the edge
      const table = page.locator("table");
      expect(await table.evaluate((t) => t.scrollWidth <= t.parentElement!.clientWidth), url).toBeTruthy();
    }
  });
});
