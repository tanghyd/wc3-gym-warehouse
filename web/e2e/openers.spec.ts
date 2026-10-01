import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// The openers tree on /openers: each level equals POST /query's answer for that prefix.
const API = process.env.API_URL ?? "http://api:8000";

type Level = { code: string; games: number; wins: number; losses: number; minutes_total: number }[];
const rows = (page: Page) => page.locator("tbody tr");
const mss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const record = (w: number, l: number) => (w + l ? `${w} – ${l}` + (w + l >= 10 ? ` (${Math.round((100 * w) / (w + l))}%)` : "") : "—");
const DECIDED = { result: ["win", "loss"] };
// the page leaves out games vs Computer unless ?computer=1
const HUMAN = { computer_game: [0] };

/**
 * The buildings after a prefix, every figure over player-games won or lost. Most played first, or
 * with sort=winrate rows from 10 games up first, by win share. Ties by win share, then games, then code.
 */
async function level(request: APIRequestContext, filters: Record<string, (string | number)[]>, prefix: string[], sort = "popular", computer = false): Promise<Level> {
  const next = `opener_${prefix.length + 1}`;
  filters = { ...filters, ...DECIDED, ...(computer ? {} : HUMAN) };
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
  test("Night Elf by default: the first level's games, record and length equal POST /query's", async ({ page, request }) => {
    const root = await level(request, { race: ["NE"] }, []);
    expect(root.length).toBeGreaterThan(0);
    const name = await names(request, root.map((r) => r.code));
    await page.goto("/openers");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Openers");
    await expect(page.getByRole("combobox", { name: "Race", exact: true })).toHaveValue("NE");
    await expect(page.getByRole("link", { name: "Openers" })).toHaveAttribute("aria-current", "page");
    expect(await cells(page)).toEqual(expected(root, name));
    // one unit per row: its games are its wins plus its losses
    for (const r of root) expect(r.games).toBe(r.wins + r.losses);
    const total = (await (await request.post(`${API}/query`, { data: { measures: ["games"], filters: { race: ["NE"], ...DECIDED, ...HUMAN } } })).json()).rows[0].games;
    await expect(page.locator(".bar .chip")).toHaveText(`${total} games won or lost`);
    await expect(page.getByRole("checkbox", { name: "Include games vs Computer" })).not.toBeChecked();
  });

  test("games vs Computer count only with the checkbox, which a reload, the sort and every link keep", async ({ page, request }) => {
    const filters = { race: ["OC"] };
    const total = async (computer: boolean) =>
      (await (await request.post(`${API}/query`, { data: { measures: ["games"], filters: { ...filters, ...DECIDED, ...(computer ? {} : HUMAN) } } })).json()).rows[0].games;
    const [human, all, humanTotal, allTotal] = await Promise.all([level(request, filters, []), level(request, filters, [], "popular", true), total(false), total(true)]);
    // the stack holds Orc games won or lost against Computer
    expect(allTotal).toBeGreaterThan(humanTotal);
    const top = all[0].code;
    // a first building whose count grows with the Computer games in
    const grows = all.find((r) => r.games > (human.find((h) => h.code === r.code)?.games ?? 0))!;
    expect(grows).toBeTruthy();
    const [kids, byRate] = await Promise.all([level(request, filters, [top], "popular", true), level(request, filters, [], "winrate", true)]);
    const name = await names(request, [...human, ...all, ...kids].map((r) => r.code));
    const box = page.getByRole("checkbox", { name: "Include games vs Computer" });
    const chip = page.locator(".bar .chip");

    await page.goto("/openers?race=OC");
    await expect(box).not.toBeChecked();
    await expect(chip).toHaveText(`${humanTotal} games won or lost`);
    expect(await cells(page)).toEqual(expected(human, name));

    await box.check();
    await page.getByRole("button", { name: "Show openers" }).click();
    await expect(page).toHaveURL(/[?&]computer=1(&|$)/);
    await expect(chip).toHaveText(`${allTotal} games won or lost`);
    expect(await cells(page)).toEqual(expected(all, name));
    await page.reload();
    await expect(box).toBeChecked();
    await expect(chip).toHaveText(`${allTotal} games won or lost`);
    expect(await cells(page)).toEqual(expected(all, name));

    // expand and collapse keep it
    await page.getByRole("link", { name: name[top], exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/openers\\?race=OC&computer=1&open=${top}$`));
    await expect(rows(page)).toHaveCount(all.length + kids.length);
    expect((await cells(page)).slice(1, 1 + kids.length)).toEqual(expected(kids, name));
    await page.getByRole("link", { name: name[top], exact: true }).click();
    await expect(page).toHaveURL(/\/openers\?race=OC&computer=1$/);
    await expect(rows(page)).toHaveCount(all.length);

    // a new sort keeps it
    await page.getByRole("combobox", { name: "Sort by" }).selectOption({ label: "Best win rate" });
    await page.getByRole("button", { name: "Show openers" }).click();
    await expect(page).toHaveURL(/[?&]sort=winrate&computer=1(&|$)/);
    await expect(box).toBeChecked();
    expect(await cells(page)).toEqual(expected(byRate, name));

    // the games link keeps it: the list holds that opener's games, Computer's among them
    await page.getByRole("link", { name: `List the games of ${name[grows.code]}` }).click();
    await expect(page).toHaveURL(new RegExp(`/\\?race=OC&computer=1&opener_1=${grows.code}$`));
    await expect(box).toBeChecked();
    const res = await request.post(`${API}/search`, { data: { filters: { ...filters, opener_1: [grows.code] } } });
    const want: string[] = (await res.json()).replays.map((r: { replay_id: string }) => r.replay_id);
    await expect(page.locator("tbody tr")).toHaveCount(want.length);
    expect(await page.locator('tbody a[href^="/replays/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")!.split("/").pop()))).toEqual(want);
    expect(await page.locator("tbody .font-name").allInnerTexts()).toContain("Computer");
  });

  test("the patch filter narrows every figure, and a games link keeps it", async ({ page, request }) => {
    const filters = { race: ["NE"], patch: ["3.0"] };
    const root = await level(request, filters, []);
    expect(root.length).toBeGreaterThan(0);
    const name = await names(request, root.map((r) => r.code));
    await page.goto("/openers");
    const patch = page.getByRole("combobox", { name: "Patch" });
    await expect(patch).toHaveValue("");
    await patch.selectOption("3.0");
    await page.getByRole("button", { name: "Show openers" }).click();
    await expect(page).toHaveURL(/[?&]patch=3\.0(&|$)/);
    expect(await cells(page)).toEqual(expected(root, name));
    const total = (await (await request.post(`${API}/query`, { data: { measures: ["games"], filters: { ...filters, ...DECIDED, ...HUMAN } } })).json()).rows[0].games;
    await expect(page.locator(".bar .chip")).toHaveText(`${total} games won or lost`);

    // the first row's games open on the replay list with the patch still set
    await rows(page).first().getByRole("link", { name: `List the games of ${name[root[0].code]}` }).click();
    await expect(page).toHaveURL(/^[^?]*\/\?.*patch=3\.0/);
    await expect(page.getByRole("combobox", { name: "Patch" })).toHaveValue("3.0");
    const res = await request.post(`${API}/search`, { data: { filters: { ...filters, ...HUMAN, opener_1: [root[0].code] } } });
    await expect(page.locator("tbody tr")).toHaveCount((await res.json()).replays.length);
  });

  test("best win rate puts rows from 10 games up first and keeps the sort while a row opens", async ({ page, request }) => {
    const root = await level(request, { race: ["NE"] }, [], "winrate");
    expect(root.some((r) => r.games < 10)).toBeTruthy();
    const name = await names(request, root.map((r) => r.code));
    await page.goto("/openers");
    await page.getByRole("combobox", { name: "Sort by" }).selectOption({ label: "Best win rate" });
    await page.getByRole("button", { name: "Show openers" }).click();
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
    const link = row.getByRole("link", { name: `List the games of ${name[kids[0].code]}` });
    await expect(link).toHaveText(String(kids[0].games));
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/\\?race=NE&opponent_race=OC&opener_1=${root[0].code}&opener_2=${kids[0].code}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Replays");
    // the list is POST /search's games of that opener, each game once and any result, none vs Computer
    const res = await request.post(`${API}/search`, { data: { filters: { ...filters, ...HUMAN, opener_1: [root[0].code], opener_2: [kids[0].code] } } });
    const want: string[] = (await res.json()).replays.map((r: { replay_id: string }) => r.replay_id);
    expect(want.length).toBeGreaterThan(0);
    await expect(page.locator("tbody tr")).toHaveCount(want.length);
    expect(await page.locator('tbody a[href^="/replays/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")!.split("/").pop()))).toEqual(want);
    await expect(page.locator(".bar .chip")).toHaveText(String(want.length));
    await expect(page.getByRole("group", { name: "Opener" }).getByRole("img")).toHaveCount(2);
  });

  test("a race with no game says what to widen", async ({ page }) => {
    await page.goto("/openers?race=UD&map=nope");
    await expect(page.getByText("No opener matches. Widen the filters.")).toBeVisible();
  });
});
