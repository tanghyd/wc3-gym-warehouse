import { expect, test, type Locator, type Page } from "@playwright/test";

// Story 4 (docs/design/stories.md "## 4. Replay detail") on the Concealed Hill golden.
const ID = "dcd39e47097a4a010bc4006e0bf521e3726a0b8e9284cc0b8e2fb74411fbfef8";
const API = process.env.API_URL ?? "http://api:8000";

type Event = { player_id: number; time_ms: number; event_type: string; code: string; hero_code: string | null };
type Replay = { players: { player_id: number; apm_per_minute: number[] }[]; events: Event[]; chat: unknown[] };

const section = (page: Page, title: string) => page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: title }) });
const card = (page: Page, name: string) => page.locator("section").filter({ has: page.getByRole("heading", { level: 3, name }) });
const hero = (c: Locator, name: string) => c.locator("li").filter({ has: c.page().getByText(name, { exact: true }) });
// One order of the two-column list: the icon and name row a skill trail hangs under.
const orders = (table: Locator) => table.locator("tbody td > div");

/** The orders the list shows: every event but a skill whose hero has a trained row. */
function listed(r: Replay, types?: Set<string>) {
  const mine = r.events.filter((e) => !types || types.has(e.event_type));
  const trained = new Set(mine.filter((e) => e.event_type === "hero_trained").map((e) => `${e.player_id}/${e.code}`));
  return mine.filter((e) => e.event_type !== "hero_skill" || !trained.has(`${e.player_id}/${e.hero_code}`)).length;
}

test.describe("replay detail", () => {
  let replay: Replay;
  test.beforeAll(async ({ request }) => {
    replay = await (await request.get(`${API}/replays/${ID}`)).json();
  });
  test.beforeEach(async ({ page }) => {
    await page.goto(`/replays/${ID}`);
  });

  test("title, meta line and file", async ({ page }) => {
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Concealed Hill");
    await expect(page).toHaveTitle(/^Concealed Hill/);
    const meta = page.locator("p").filter({ has: page.getByRole("img", { name: "Length" }) });
    for (const text of ["15:37", "NvO", "Patch 2.00", "GNL S9003 G1"]) await expect(meta).toContainText(text);
    await expect(page.getByText("No file", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download replay" })).toHaveCount(0);
  });

  test("players line: name then race icon, trophy after the winner", async ({ page }) => {
    const line = page.locator("section").filter({ has: page.getByRole("heading", { level: 1 }) }).locator("p").filter({ hasText: "Okeanos#22605" });
    await expect(line).toHaveText(/thanks#11187\s*v\s*Okeanos#22605/, { useInnerText: true });
    await expect(line.locator('span:text-is("thanks#11187") + img')).toHaveAttribute("alt", "Night Elf");
    await expect(line.locator('span:text-is("Okeanos#22605") + img')).toHaveAttribute("alt", "Orc");
    await expect(line.getByRole("img", { name: "Won" })).toHaveCount(1);
  });

  test("player cards: result, APM, heroes and the skill trail", async ({ page }) => {
    const a = card(page, "thanks#11187");
    const b = card(page, "Okeanos#22605");
    await expect(a.getByRole("img", { name: "Night Elf" })).toBeVisible();
    await expect(b.getByRole("img", { name: "Orc" })).toBeVisible();
    await expect(a.getByText("Won", { exact: true })).toBeVisible();
    await expect(b.getByText("Lost", { exact: true })).toBeVisible();
    await expect(a.getByText("140", { exact: true })).toBeVisible();
    await expect(b.getByText("89", { exact: true })).toBeVisible();

    await expect(hero(a, "Demon Hunter")).toContainText("Level 4");
    await expect(hero(a, "Keeper of the Grove")).toContainText("Level 4");
    await expect(hero(b, "Far Seer")).toContainText("Level 3");
    // heroes in slot order
    await expect(a.locator("ul").first().locator(":scope > li").first()).toContainText("Demon Hunter");
    await expect(b.locator("ul").first().locator(":scope > li")).toHaveCount(3);
    await expect(b.locator("ul").first().locator(":scope > li").first()).toContainText("Far Seer");

    const trail = hero(a, "Demon Hunter").locator("ol > li");
    await expect(trail).toHaveText(["2:22", "4:06", "6:40", "11:54"]);
    await expect(trail.first()).toHaveAttribute("title", "Immolation at 2:22");
    await expect(trail.first().getByRole("img")).toHaveAccessibleName("Immolation");
    await expect(hero(b, "Far Seer").locator("ol > li")).toHaveText(["2:17", "6:49", "9:58"]);
  });

  test("build orders list: m:ss rows with icons and names", async ({ page }) => {
    const table = section(page, "Build orders").locator("table");
    await expect(table).toBeVisible();
    await expect(table.locator("thead")).toContainText("Ordered");
    const rows = table.locator("tbody > tr");
    expect(await rows.count()).toBeGreaterThan(50);

    const times = await rows.locator("td:nth-child(2)").allInnerTexts();
    expect(times.filter((t) => !/^\d+:\d\d$/.test(t))).toEqual([]);
    const secs = times.map((t) => Number(t.split(":")[0]) * 60 + Number(t.split(":")[1]));
    expect(secs).toEqual([...secs].sort((x, y) => x - y));
    await expect(rows.first()).toContainText("0:02");
    await expect(rows.first()).toContainText("Peon");

    await expect(orders(table)).toHaveCount(listed(replay));
    // every order has a command-card icon that loaded, and a name that is not its raw code
    const missing = await orders(table).evaluateAll((divs) =>
      divs.filter((d) => !d.querySelector("img") || !(d.querySelector("img") as HTMLImageElement).naturalWidth).map((d) => d.textContent),
    );
    expect(missing, "orders with no icon").toEqual([]);
    const names = new Set(await orders(table).allInnerTexts());
    expect([...new Set(replay.events.map((e) => e.code))].filter((c) => names.has(c)), "codes shown with no name").toEqual([]);
  });

  test("the Units chip drops unit rows and writes kinds to the URL", async ({ page }) => {
    const build = section(page, "Build orders");
    const table = build.locator("table");
    const units = build.getByRole("button", { name: "Units" });
    await expect(units).toHaveAttribute("aria-pressed", "true");
    await expect(table.getByText("Peon", { exact: true }).first()).toBeVisible();

    await units.click();
    await expect(units).toHaveAttribute("aria-pressed", "false");
    await expect(page).toHaveURL(/\?kinds=buildings,upgrades,heroes,items$/);
    const noUnits = new Set(["building", "upgrade", "hero_trained", "hero_skill", "hero_retrained", "item"]);
    await expect(orders(table)).toHaveCount(listed(replay, noUnits));
    for (const name of ["Peon", "Wisp"]) await expect(table.getByText(name, { exact: true })).toHaveCount(0);

    // the URL is the state
    await page.reload();
    await expect(units).toHaveAttribute("aria-pressed", "false");
    await expect(orders(table)).toHaveCount(listed(replay, noUnits));
  });

  test("APM chart: two lines, a keyboard tooltip and a table view", async ({ page }) => {
    const apm = section(page, "APM per minute");
    const plot = apm.getByRole("img", { name: /^APM per minute/ });
    await expect(plot.locator("path")).toHaveCount(2);
    const strokes = await plot.locator("path").evaluateAll((ps) => ps.map((p) => p.getAttribute("stroke")));
    expect(strokes).toEqual(["rgb(var(--v-theme-series-1))", "rgb(var(--v-theme-series-2))"]);
    await expect(apm.locator("ul").getByText("thanks#11187")).toBeVisible();
    await expect(apm.locator("ul").getByText("Okeanos#22605")).toBeVisible();

    const [p1, p2] = [...replay.players].sort((x, y) => x.player_id - y.player_id).map((p) => p.apm_per_minute);
    await plot.focus();
    await page.keyboard.press("ArrowRight");
    const tip = apm.locator("[aria-live]");
    await expect(tip).toContainText("Minute 1");
    await expect(tip).toContainText(String(p1[0]));
    await expect(tip).toContainText(String(p2[0]));

    await apm.getByRole("button", { name: "Table" }).click();
    await expect(plot).toHaveCount(0);
    const rows = apm.locator("tbody tr");
    await expect(rows).toHaveCount(16);
    await expect(rows.first().locator("td")).toHaveText(["1", String(p1[0]), String(p2[0])]);
    await expect(rows.last().locator("td").first()).toHaveText("16");
  });

  test("chat: all-chat lines, no private line", async ({ page }) => {
    const chat = section(page, "Chat");
    await expect(chat.locator("li")).toHaveCount(replay.chat.length);
    await expect(chat.locator("li").first()).toContainText("0:09");
    await expect(chat.locator("li").first()).toContainText("thanks#11187");
    await expect(chat.locator("li").first()).toContainText("glhf");
    await expect(page.getByText("Private")).toHaveCount(0);
  });
});

test.describe("replay detail at 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("cards stack and build orders open on the list in two tabs", async ({ page }) => {
    await page.goto(`/replays/${ID}`);
    const a = await card(page, "thanks#11187").boundingBox();
    const b = await card(page, "Okeanos#22605").boundingBox();
    expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.height);

    const build = section(page, "Build orders");
    await expect(build.locator("table")).toBeHidden();
    const tabs = build.getByRole("tab");
    await expect(tabs).toHaveCount(2);
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    await expect(tabs.first()).toContainText("thanks#11187");
    const first = build.getByRole("tabpanel").locator(":scope > li").first();
    await expect(first).toHaveText(/^\d+:\d\d\S/);
    await expect(first.locator("img").first()).toBeVisible();

    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(build.getByRole("tabpanel").locator(":scope > li").first()).toHaveText("0:02Peon");
  });
});

for (const id of ["nope", "a".repeat(64)]) {
  test(`unknown id ${id.slice(0, 8)} shows No game with this id`, async ({ page }) => {
    const res = await page.goto(`/replays/${id}`);
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "No game with this id" })).toBeVisible();
    await expect(page).toHaveTitle(/No game with this id/);
    await expect(page.getByRole("link", { name: "Search replays" })).toHaveAttribute("href", "/");
    await expect(page.getByText("APM per minute")).toHaveCount(0);
  });
}
