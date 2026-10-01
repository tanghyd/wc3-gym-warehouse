import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { search, strip, stripOf } from "./helpers";

// The openers tree, the Openers tab of Strategies: each level equals POST /query's answer for that
// prefix, over games of 2 minutes or more. The old /openers route redirects to it.
const API = process.env.API_URL ?? "http://api:8000";

type Level = { code: string; games: number; wins: number; losses: number; minutes_total: number }[];
const rows = (page: Page) => page.locator("tbody tr");
const mss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const record = (w: number, l: number) => (w + l ? `${w} – ${l}` + (w + l >= 10 ? ` (${Math.round((100 * w) / (w + l))}%)` : "") : "—");
const DECIDED = { result: ["win", "loss"], duration_ms: { gte: 120000 } };
// Night Elf on the tab is picked Night Elf: random 0; Human is the tab's race when none is chosen
const NE = { race: ["NE"], random: [0] };
const HU = { race: ["HU"], random: [0] };

/**
 * The buildings after a prefix, every figure over player-games won or lost. Most played first, or
 * with sort=winrate rows from 10 games up first, by win share. Ties by win share, then games, then code.
 */
async function level(request: APIRequestContext, filters: Record<string, (string | number)[]>, prefix: string[], sort = "popular"): Promise<Level> {
  const next = `opener_${prefix.length + 1}`;
  filters = { ...filters, ...DECIDED };
  prefix.forEach((c, i) => (filters = { ...filters, [`opener_${i + 1}`]: [c] }));
  const res = await request.post(`${API}/query`, {
    data: { dimensions: [next], measures: ["games", "wins", "losses", "minutes_total"], filters, limit: 10000 },
  });
  const out: Level = (await res.json()).rows.filter((r: Record<string, string>) => r[next]).map((r: Record<string, number>) => ({ ...r, code: r[next] }));
  const share = (r: Level[number]) => r.wins / r.games;
  return out.sort(
    (a, b) =>
      (sort === "winrate" ? Number(b.games >= 10) - Number(a.games >= 10) || share(b) - share(a) || b.games - a.games : b.games - a.games || share(b) - share(a)) ||
      a.code.localeCompare(b.code),
  );
}

async function names(request: APIRequestContext, codes: string[]): Promise<Record<string, string>> {
  const res = await request.post(`${API}/query`, { data: { model: "mappings", dimensions: ["code", "name"], filters: { code: codes }, limit: 10000 } });
  return Object.fromEntries((await res.json()).rows.map((r: { code: string; name: string }) => [r.code, r.name]));
}

/** The cells as the page reads them: opener name, games, record, average length. */
const cells = (page: Page) => rows(page).evaluateAll((trs) => trs.map((tr) => [...(tr as HTMLTableRowElement).cells].map((c) => c.innerText.trim())));
const expected = (lvl: Level, name: Record<string, string>) =>
  lvl.map((r) => [name[r.code], String(r.games), record(r.wins, r.losses), mss((r.minutes_total / r.games) * 60000)]);

test.describe("openers tree", () => {
  test("/openers lands on the tab, Human by default: the first level's games, record and length equal POST /query's", async ({ page, request }) => {
    const root = await level(request, HU, []);
    expect(root.length).toBeGreaterThan(0);
    const name = await names(request, root.map((r) => r.code));
    await page.goto("/openers");
    await expect(page).toHaveURL(/\/strategies\/openers(\?|$)/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Strategies");
    await expect(page.getByRole("button", { name: "Race: Human" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Strategies" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("link", { name: "Openers", exact: true })).toHaveAttribute("aria-current", "page");
    expect(await cells(page)).toEqual(expected(root, name));
    // one unit per row: its games are its wins plus its losses
    for (const r of root) expect(r.games).toBe(r.wins + r.losses);
    const total = (await (await request.post(`${API}/query`, { data: { measures: ["games"], filters: { ...HU, ...DECIDED } } })).json()).rows[0].games;
    await expect(page.locator(".bar .chip")).toHaveText(`${total} games won or lost`);
  });

  // 2.0 is the goldens' patch (build 6117), so it always has games
  test("the patch filter sets every figure, and a games link keeps it", async ({ page, request }) => {
    const filters = { ...NE, patch: ["2.0"] };
    const root = await level(request, filters, []);
    expect(root.length).toBeGreaterThan(0);
    const name = await names(request, root.map((r) => r.code));
    await page.goto("/openers?race=NE");
    const patch = page.getByRole("combobox", { name: "Patch" });
    await expect(patch).toHaveValue("");
    await patch.selectOption("2.0");
    await expect(page).toHaveURL(/[?&]patch=2\.0(&|$)/);
    expect(await cells(page)).toEqual(expected(root, name));
    const total = (await (await request.post(`${API}/query`, { data: { measures: ["games"], filters: { ...filters, ...DECIDED } } })).json()).rows[0].games;
    await expect(page.locator(".bar .chip")).toHaveText(`${total} games won or lost`);

    // the first row's games open on the replay list with the patch still set
    await rows(page).first().getByRole("link", { name: `List the games of ${name[root[0].code]}` }).click();
    await expect(page).toHaveURL(/^[^?]*\/\?.*patch=2\.0/);
    await expect(page.getByRole("combobox", { name: "Patch" })).toHaveValue("2.0");
    const want = await search(request, { filters: { patch: ["2.0"], duration_ms: { gte: 120000 } }, player: { race: ["NE"], opened_with: [root[0].code] } });
    expect(await strip(page)).toEqual(stripOf(want));
  });

  test("best win rate puts rows from 10 games up first and keeps the sort while a row opens", async ({ page, request }) => {
    const root = await level(request, NE, [], "winrate");
    expect(root.some((r) => r.games < 10)).toBeTruthy();
    const name = await names(request, root.map((r) => r.code));
    await page.goto("/openers?race=NE");
    await page.getByRole("combobox", { name: "Sort by" }).selectOption({ label: "Best win rate" });
    await expect(page).toHaveURL(/[?&]sort=winrate(&|$)/);
    expect(await cells(page)).toEqual(expected(root, name));
    const top = root.find((r) => r.games >= 10)!.code;
    await page.getByRole("link", { name: name[top], exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]sort=winrate&open=${top}$`));
    await expect(page.getByRole("combobox", { name: "Sort by" })).toHaveValue("winrate");
  });

  test("a deep path fits a phone, each name whole on its lines", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const path = ["eate", "eaom", "eden", "etoa", "edob"];
    await page.goto(`/openers?race=NE&${path.map((_, i) => `open=${path.slice(0, i + 1).join(".")}`).join("&")}`);
    // six levels on screen: the deepest rows sit five indents in
    await expect(rows(page).locator('a[aria-expanded="true"]')).toHaveCount(5);
    const table = page.locator("table");
    expect(await table.evaluate((t) => t.scrollWidth <= t.parentElement!.clientWidth)).toBeTruthy();
    // a name breaks between words only: no word of it spans two lines
    const broken = await rows(page).evaluateAll((trs) =>
      trs.flatMap((tr) => {
        const text = tr.querySelector("td:first-child :is(a, span) > span:last-child")!.firstChild as Text;
        let at = 0;
        return text.data.split(" ").flatMap((word) => {
          const range = document.createRange();
          range.setStart(text, at);
          range.setEnd(text, at + word.length);
          at += word.length + 1;
          return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size > 1 ? [word] : [];
        });
      }),
    );
    expect(broken).toEqual([]);
  });

  test("expanding a row shows the next level under it and puts the path in the URL", async ({ page, request }) => {
    const root = await level(request, NE, []);
    const top = root[0].code;
    const kids = await level(request, NE, [top]);
    expect(kids.length).toBeGreaterThan(0);
    const name = await names(request, [...root, ...kids].map((r) => r.code));
    await page.goto("/openers?race=NE");
    const toggle = page.getByRole("link", { name: name[top], exact: true });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(page).toHaveURL(new RegExp(`[?&]open=${top}(&|$)`));
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    // the children sit right under their parent; the rest of the first level stays
    await expect(rows(page)).toHaveCount(root.length + kids.length);
    const got = await cells(page);
    expect(got[0][0]).toBe(name[top]);
    expect(got.slice(1, 1 + kids.length)).toEqual(expected(kids, name));
    expect(got.slice(1 + kids.length)).toEqual(expected(root.slice(1), name));

    // a reload keeps the tree; a second click closes it
    await page.reload();
    await expect(rows(page)).toHaveCount(root.length + kids.length);
    await page.getByRole("link", { name: name[top], exact: true }).click();
    await expect(page).not.toHaveURL(/[?&]open=/);
    await expect(rows(page)).toHaveCount(root.length);
  });

  test("a row's games link lands on the replay list of that opener, the page's filters kept", async ({ page, request }) => {
    const filters = { ...NE, opponent_race: ["OC"], opponent_random: [0] };
    const root = await level(request, filters, []);
    const kids = await level(request, filters, [root[0].code]);
    const name = await names(request, kids.map((r) => r.code));
    await page.goto(`/openers?race=NE&opponent_race=OC&open=${root[0].code}`);
    const row = rows(page).nth(1);
    await expect(row).toContainText(name[kids[0].code]);
    const link = row.getByRole("link", { name: `List the games of ${name[kids[0].code]}` });
    await expect(link).toHaveText(String(kids[0].games));
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/\\?race=NE&opponent_race=OC&min=2&opened=${root[0].code}\\.${kids[0].code}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Replays");
    // the list is POST /search's player-games of that opener: an Opened with condition on the Player side
    const want = await search(request, { filters: { duration_ms: { gte: 120000 } }, player: { race: ["NE"], opened_with: [root[0].code, kids[0].code] }, opponent: { race: ["OC"] } });
    expect(want.total).toBe(kids[0].games);
    expect(await strip(page)).toEqual(stripOf(want));
    await expect(page.getByRole("group", { name: "Opened with" }).getByRole("img")).toHaveCount(2);
    // its remove button drops the condition
    await page.getByRole("button", { name: "Remove the opener" }).click();
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).not.toHaveURL(/opened=/);
  });

  test("a race with no game says what to widen", async ({ page }) => {
    await page.goto("/openers?race=UD&map=nope");
    await expect(page.getByText("No opener matches. Widen the filters.")).toBeVisible();
  });
});
