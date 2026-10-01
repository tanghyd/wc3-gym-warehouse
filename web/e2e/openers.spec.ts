import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// The openers tree on /openers: each level equals POST /query's answer for that prefix.
const API = process.env.API_URL ?? "http://api:8000";

type Level = { code: string; replays: number; games: number; wins: number; losses: number; minutes_total: number }[];
const rows = (page: Page) => page.locator("tbody tr");
const mss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const record = (w: number, l: number) => (w + l ? `${w} – ${l}` + (w + l >= 10 ? ` (${Math.round((100 * w) / (w + l))}%)` : "") : "—");

/** The buildings after a prefix: games are replays, record and minutes count each player-game. Most played first. */
async function level(request: APIRequestContext, filters: Record<string, string[]>, prefix: string[]): Promise<Level> {
  const next = `opener_${prefix.length + 1}`;
  prefix.forEach((c, i) => (filters = { ...filters, [`opener_${i + 1}`]: [c] }));
  const res = await request.post(`${API}/query`, {
    data: { dimensions: [next], measures: ["replays", "games", "wins", "losses", "minutes_total"], filters, limit: 10000 },
  });
  const out: Level = (await res.json()).rows.filter((r: Record<string, string>) => r[next]).map((r: Record<string, number>) => ({ ...r, code: r[next] }));
  return out.sort((a, b) => b.replays - a.replays || a.code.localeCompare(b.code));
}

async function names(request: APIRequestContext, codes: string[]): Promise<Record<string, string>> {
  const res = await request.post(`${API}/query`, { data: { model: "mappings", dimensions: ["code", "name"], filters: { code: codes }, limit: 10000 } });
  return Object.fromEntries((await res.json()).rows.map((r: { code: string; name: string }) => [r.code, r.name]));
}

/** The cells as the page reads them: opener name, games, record, average length. */
const cells = (page: Page) => rows(page).evaluateAll((trs) => trs.map((tr) => [...(tr as HTMLTableRowElement).cells].map((c) => c.innerText.trim())));
const expected = (lvl: Level, name: Record<string, string>) =>
  lvl.map((r) => [name[r.code], String(r.replays), record(r.wins, r.losses), mss((r.minutes_total / r.games) * 60000)]);

test.describe("openers tree", () => {
  test("Night Elf by default: the first level's games, record and length equal POST /query's", async ({ page, request }) => {
    const root = await level(request, { race: ["NE"] }, []);
    expect(root.length).toBeGreaterThan(0);
    const name = await names(request, root.map((r) => r.code));
    await page.goto("/openers");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Openers");
    await expect(page.getByRole("combobox", { name: "Race", exact: true })).toHaveValue("NE");
    await expect(page.getByRole("link", { name: "Openers" })).toHaveAttribute("aria-current", "page");
    expect(await cells(page)).toEqual(expected(root, name));
    const total = (await (await request.post(`${API}/query`, { data: { measures: ["replays"], filters: { race: ["NE"] } } })).json()).rows[0].replays;
    await expect(page.locator(".bar .chip")).toHaveText(`${total} games`);
  });

  test("expanding a row shows the next level under it and puts the path in the URL", async ({ page, request }) => {
    const root = await level(request, { race: ["NE"] }, []);
    const top = root[0].code;
    const kids = await level(request, { race: ["NE"] }, [top]);
    expect(kids.length).toBeGreaterThan(0);
    const name = await names(request, [...root, ...kids].map((r) => r.code));
    await page.goto("/openers");
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
    const filters = { race: ["NE"], opponent_race: ["OC"] };
    const root = await level(request, filters, []);
    const kids = await level(request, filters, [root[0].code]);
    const name = await names(request, kids.map((r) => r.code));
    await page.goto(`/openers?race=NE&opponent_race=OC&open=${root[0].code}`);
    const row = rows(page).nth(1);
    await expect(row).toContainText(name[kids[0].code]);
    await row.getByRole("link", { name: `List ${kids[0].replays} games` }).click();
    await expect(page).toHaveURL(new RegExp(`/\\?race=NE&opponent_race=OC&opener_1=${root[0].code}&opener_2=${kids[0].code}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Replays");
    await expect(page.locator("tbody tr")).toHaveCount(kids[0].replays);
    await expect(page.locator(".bar .chip")).toHaveText(String(kids[0].replays));
    await expect(page.getByRole("group", { name: "Opener" }).getByRole("img")).toHaveCount(2);
  });

  test("a race with no game says what to widen", async ({ page }) => {
    await page.goto("/openers?race=UD&map=nope");
    await expect(page.getByText("No opener matches. Widen the filters.")).toBeVisible();
  });
});
