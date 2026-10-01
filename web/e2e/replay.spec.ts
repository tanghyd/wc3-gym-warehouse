import { expect, test, type Locator, type Page } from "@playwright/test";

// Story 4 (docs/design/stories.md "## 4. Replay detail") on the Concealed Hill golden.
const ID = "dcd39e47097a4a010bc4006e0bf521e3726a0b8e9284cc0b8e2fb74411fbfef8";
// Shallow Grave, 31 minutes, NE v OC: the longest human game
const LONG = "a9872674567c6389f3d912b5f053f7e2af4a87de3378d5229a90f091bd219d88";
// Fading Autumn, UD v NE: thanks's third hero and its skills AHpa and AHcr are in no mappings row
const FADING = "be7b97ee9668d1f441fa2973387ea4e02fa5a02d2adababec6cb3e7647871c32";
const LETTER: Record<string, string> = { Human: "H", Orc: "O", "Night Elf": "N", Undead: "U", Random: "R" };
const API = process.env.API_URL ?? "http://api:8000";
const NE = "thanks#11187";
const OC = "Okeanos#22605";

type Event = { player_id: number; time_ms: number; event_type: string; code: string; hero_code: string | null };
type Replay = { players: { player_id: number; name: string; apm_per_minute: number[] }[]; events: Event[]; chat: unknown[] };
type Group = { type: string; code: string; hero: string | null; times: number[] };

const section = (page: Page, title: string) => page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: title }) });
const card = (page: Page, name: string) => page.locator("section").filter({ has: page.getByRole("heading", { level: 3, name }) });
const hero = (c: Locator, name: string) => c.locator("li").filter({ has: c.page().getByText(name, { exact: true }) });
const timeline = (page: Page) => section(page, "Game Timeline");
// One player's marks on the chart, and one player's list
const lanes = (page: Page, name: string) => timeline(page).getByRole("group", { name: `Orders of ${name}` });
const list = (page: Page, name: string) => timeline(page).getByRole("list", { name: `Orders of ${name}` });
const KIND_TYPES: Record<string, string[]> = {
  Buildings: ["building"],
  Units: ["unit"],
  Upgrades: ["upgrade"],
  Heroes: ["hero_trained", "hero_skill", "hero_retrained"],
  Items: ["item"],
};
const mss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

/** The marks a player should get: orders of one object up to 60 s after its first one merge. */
function groups(r: Replay, name: string, kinds = Object.keys(KIND_TYPES)) {
  const id = r.players.find((p) => p.name === name)!.player_id;
  const types = new Set(kinds.flatMap((k) => KIND_TYPES[k]));
  const out: Group[] = [];
  for (const e of r.events.filter((e) => e.player_id === id && types.has(e.event_type)).sort((a, b) => a.time_ms - b.time_ms)) {
    const g = out.findLast((g) => g.type === e.event_type && g.code === e.code && g.hero === e.hero_code);
    if (g && e.time_ms - g.times[0] <= 60000) g.times.push(e.time_ms);
    else out.push({ type: e.event_type, code: e.code, hero: e.hero_code, times: [e.time_ms] });
  }
  return out;
}
/** The list rows: every group but a skill whose hero has a trained row. */
const listRows = (gs: Group[]) => {
  const trained = new Set(gs.filter((g) => g.type === "hero_trained").map((g) => g.code));
  return gs.filter((g) => g.type !== "hero_skill" || !trained.has(g.hero ?? "")).length;
};

/** No two marks of one row overlap: the first-fit stacking. */
async function noOverlap(group: Locator) {
  const boxes = await group.locator("[data-mark]").evaluateAll((els) => els.map((e) => [e.getBoundingClientRect().left, e.getBoundingClientRect().top]));
  for (const [i, [x, y]] of boxes.entries())
    for (const [x2, y2] of boxes.slice(i + 1)) if (Math.abs(y - y2) < 1) expect(Math.abs(x - x2), `marks at ${x} and ${x2}`).toBeGreaterThanOrEqual(25);
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
    // the game patch from the build number, never the file format version 2.00
    for (const text of ["15:37", "NvO", "Patch 2.0", "GNL S9003 G1"]) await expect(meta).toContainText(text);
    await expect(meta).not.toContainText("2.00");
    await expect(page.getByText("No file", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download replay" })).toHaveCount(0);
  });

  test("players line: name then race icon, Won after the winner", async ({ page }) => {
    const line = page.locator("section").filter({ has: page.getByRole("heading", { level: 1 }) }).locator("p").filter({ hasText: OC });
    await expect(line).toHaveText(/thanks#11187\s*Won\s*v\s*Okeanos#22605/, { useInnerText: true });
    await expect(line.locator(`span:text-is("${NE}") + img`)).toHaveAttribute("alt", "Night Elf");
    await expect(line.locator(`span:text-is("${OC}") + img`)).toHaveAttribute("alt", "Orc");
    await expect(line.getByText("Won", { exact: true })).toHaveCount(1);
  });

  test("player cards: result, APM, heroes and the skill trail", async ({ page }) => {
    const a = card(page, NE);
    const b = card(page, OC);
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

  test("timeline chart: a block per player, five lanes, merged marks with icons", async ({ page }) => {
    const t = timeline(page);
    await expect(t.getByRole("button", { name: "Chart" })).toHaveAttribute("aria-pressed", "true");
    for (const name of [NE, OC]) {
      const g = lanes(page, name);
      await expect(g.locator("svg text").filter({ hasText: /^(Buildings|Units|Upgrades|Heroes|Items)$/ })).toHaveText(Object.keys(KIND_TYPES));
      const marks = g.locator("[data-mark]");
      await expect(marks).toHaveCount(groups(replay, name).length);
      // every mark has a command-card icon that loaded and a name that is not its raw code
      const missing = await marks.evaluateAll((els) => els.filter((e) => !(e.querySelector("img") as HTMLImageElement | null)?.naturalWidth).map((e) => e.getAttribute("aria-label")));
      expect(missing, "marks with no icon").toEqual([]);
      const names = (await marks.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")!))).map((l) => l.split(/ ×|\. /)[0]);
      expect([...new Set(replay.events.map((e) => e.code))].filter((c) => names.includes(c)), "codes shown with no name").toEqual([]);
      await noOverlap(g);
    }

    // the opening workers merge into one mark with a count, its tooltip lists every order
    const wisps = lanes(page, NE).getByRole("img", { name: "Wisp ×5. Ordered at 0:02, 0:08, 0:16, 0:35, 0:51" });
    await expect(wisps).toContainText("×5");
    await expect(lanes(page, OC).getByRole("img", { name: "Peon ×4. Ordered at 0:02, 0:19, 0:34, 0:58" })).toContainText("×4");
    // the second Tree of Ages order came 155 ms after the first: a repeat click, left out
    await expect(lanes(page, NE).getByRole("img", { name: "Tree of Ages. Ordered at 2:44" })).toBeVisible();
    await expect(lanes(page, NE).getByRole("img", { name: "Demon Hunter. Trained by 2:22" })).toBeVisible();
    await expect(lanes(page, NE).getByRole("img", { name: "Immolation. Demon Hunter skill at 2:22" })).toBeVisible();
  });

  test("timeline chart: tier-ups as labelled ticks", async ({ page }) => {
    const tier = (name: string) => lanes(page, name).locator("svg text").filter({ hasText: /^T\d ordered / });
    await expect(tier(NE)).toHaveText(["T2 ordered 2:44", "T3 ordered 7:57"]);
    await expect(tier(OC)).toHaveText(["T2 ordered 3:35", "T3 ordered 5:57"]);
    // each tick sits at the first order of its hall
    const firsts = { [NE]: ["etoa", "etoe"], [OC]: ["ostr", "ofrt"] };
    for (const [name, codes] of Object.entries(firsts)) {
      const id = replay.players.find((p) => p.name === name)!.player_id;
      const at = codes.map((c) => mss(Math.min(...replay.events.filter((e) => e.player_id === id && e.code === c).map((e) => e.time_ms))));
      await expect(tier(name)).toHaveText(at.map((a, i) => `T${i + 2} ordered ${a}`));
    }
  });

  test("timeline chart: APM and the lanes share one time scale and one rule", async ({ page }) => {
    const t = timeline(page);
    const plot = t.getByRole("img", { name: /^APM per minute/ });
    // the APM minute labels give the scale; the first wisps (0:02.6) must sit on it
    const centre = async (l: Locator) => {
      const b = (await l.boundingBox())!;
      return b.x + b.width / 2;
    };
    const ticks = plot.locator("text").filter({ hasText: /^\d+:00$/ });
    const step = Number((await ticks.nth(1).textContent())!.split(":")[0]);
    const x0 = await centre(ticks.nth(0));
    const perMin = ((await centre(ticks.nth(1))) - x0) / step;
    const wisps = lanes(page, NE).locator("[data-mark]").first();
    const w = (await wisps.boundingBox())!;
    expect(Math.abs(w.x + w.width / 2 - (x0 + (2.601 / 60) * perMin))).toBeLessThan(1.5);
    // the lanes' bottom axis repeats the APM labels at the same x
    const bottom = t.locator("svg:not([role]) text").filter({ hasText: /^\d+:00$/ });
    expect(await bottom.allTextContents()).toEqual(await ticks.allTextContents());
    expect(Math.abs((await centre(bottom.nth(1))) - (x0 + step * perMin))).toBeLessThan(1);

    // focus on a mark: its tooltip, and one rule through the APM plot and both blocks at its time
    await wisps.focus();
    const tip = t.locator("[aria-live]").filter({ hasText: "Wisp ×5" });
    await expect(tip).toContainText("Ordered at 0:02, 0:08, 0:16, 0:35, 0:51");
    const rule = t.locator("[data-rule]");
    await expect(rule).toHaveCount(1);
    const r = (await rule.boundingBox())!;
    const p = (await plot.boundingBox())!;
    const last = (await lanes(page, OC).boundingBox())!;
    expect(Math.abs(r.x - (w.x + w.width / 2))).toBeLessThan(1.5);
    expect(r.y).toBeLessThanOrEqual(p.y + 13);
    expect(r.y + r.height).toBeGreaterThanOrEqual(last.y + last.height - 1);

    // the arrow keys walk the marks in time order
    await page.keyboard.press("ArrowRight");
    await expect(lanes(page, NE).locator("[data-mark]").nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(rule).toHaveCount(0);

    // a hover on the APM plot moves the same rule to that minute
    await plot.hover({ position: { x: x0 + 5.5 * perMin - p.x, y: 80 } });
    await expect(t.locator("[aria-live]").filter({ hasText: "Minute 6" })).toHaveCount(1);
    const r2 = (await rule.boundingBox())!;
    expect(Math.abs(r2.x - (x0 + 5.5 * perMin))).toBeLessThan(1.5);
    expect(r2.y + r2.height).toBeGreaterThanOrEqual(last.y + last.height - 1);
  });

  test("the Units chip drops the Units lane and list rows and writes kinds to the URL", async ({ page }) => {
    const t = timeline(page);
    const units = t.getByRole("button", { name: "Units" });
    await expect(units).toHaveAttribute("aria-pressed", "true");

    await units.click();
    await expect(units).toHaveAttribute("aria-pressed", "false");
    await expect(page).toHaveURL(/\?kinds=buildings,upgrades,heroes,items$/);
    const kinds = ["Buildings", "Upgrades", "Heroes", "Items"];
    const check = async () => {
      for (const name of [NE, OC]) {
        await expect(lanes(page, name).locator("svg text").filter({ hasText: /^(Buildings|Units|Upgrades|Heroes|Items)$/ })).toHaveText(kinds);
        await expect(lanes(page, name).locator("[data-mark]")).toHaveCount(groups(replay, name, kinds).length);
      }
      for (const name of ["Peon", "Wisp"]) await expect(t.getByRole("img", { name: new RegExp(`^${name}\\b`) })).toHaveCount(0);
    };
    await check();

    // the URL is the state, and the list obeys it too
    await page.reload();
    await expect(units).toHaveAttribute("aria-pressed", "false");
    await check();
    await t.getByRole("button", { name: "List" }).click();
    for (const [name, worker] of [[NE, "Wisp"], [OC, "Peon"]]) {
      await expect(list(page, name).locator(":scope > li")).toHaveCount(listRows(groups(replay, name, kinds)));
      await expect(list(page, name).getByText(new RegExp(`^${worker}\\b`))).toHaveCount(0);
    }
  });

  test("APM: two lines with end labels, a keyboard tooltip and a table view", async ({ page }) => {
    const t = timeline(page);
    const plot = t.getByRole("img", { name: /^APM per minute/ });
    await expect(plot.locator("path")).toHaveCount(2);
    const strokes = await plot.locator("path").evaluateAll((ps) => ps.map((p) => p.getAttribute("stroke")));
    expect(strokes).toEqual(["rgb(var(--v-theme-series-1))", "rgb(var(--v-theme-series-2))"]);
    await expect(t.locator("ul").first().getByText(NE)).toBeVisible();
    await expect(t.locator("ul").first().getByText(OC)).toBeVisible();
    for (const label of ["thanks", "Okeanos"]) await expect(plot.locator("text", { hasText: new RegExp(`^${label}$`) })).toHaveCount(1);

    const [p1, p2] = [...replay.players].sort((x, y) => x.player_id - y.player_id).map((p) => p.apm_per_minute);
    await plot.focus();
    await page.keyboard.press("ArrowRight");
    const tip = t.locator("[aria-live]").filter({ hasText: "Minute 1" });
    await expect(tip).toContainText(String(p1[0]));
    await expect(tip).toContainText(String(p2[0]));

    await t.getByRole("button", { name: "List" }).click();
    await expect(plot).toHaveCount(0);
    const table = t.getByRole("table");
    await expect(table.locator("thead th")).toHaveText(["Minute", ...Array.from({ length: 16 }, (_, m) => String(m + 1))]);
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator("th")).toContainText(NE);
    await expect(rows.nth(0).locator("td")).toHaveText(p1.map(String));
    await expect(rows.nth(1).locator("th")).toContainText(OC);
    await expect(rows.nth(1).locator("td")).toHaveText(p2.map(String));
  });

  test("list view: one list per player side by side, merged rows, skills under heroes", async ({ page }) => {
    const t = timeline(page);
    await t.getByRole("button", { name: "List" }).click();
    await expect(t.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    const [a, b] = [list(page, NE), list(page, OC)];
    for (const [l, name] of [[a, NE], [b, OC]] as const) {
      await expect(l.locator(":scope > li")).toHaveCount(listRows(groups(replay, name)));
      const cells = l.locator(":scope > li > div > span:first-child");
      const raw = await cells.allInnerTexts();
      expect(raw.filter((t) => !/^\d+:\d\d$/.test(t)), "times not m:ss").toEqual([]);
      const times = raw.map((s) => Number(s.split(":")[0]) * 60 + Number(s.split(":")[1]));
      expect(times).toEqual([...times].sort((x, y) => x - y));
      // the time column's head says the times are orders, and sits over that column
      const ordered = l.locator("xpath=preceding-sibling::div[1]").getByText("Ordered", { exact: true });
      await expect(ordered).toBeVisible();
      expect(Math.abs((await ordered.boundingBox())!.x - (await cells.first().boundingBox())!.x)).toBeLessThan(1);
    }
    const ba = (await a.boundingBox())!;
    const bb = (await b.boundingBox())!;
    expect(bb.x).toBeGreaterThanOrEqual(ba.x + ba.width);

    await expect(a.locator(":scope > li").first()).toHaveText("0:02Wisp ×50:02, 0:08, 0:16, 0:35, 0:51");
    await expect(b.locator(":scope > li").first()).toHaveText("0:02Peon ×40:02, 0:19, 0:34, 0:58");
    const toa = a.locator(":scope > li").filter({ hasText: "Tree of Ages" });
    await expect(toa).toHaveText("2:44Tree of AgesT2");
    await expect(b.locator(":scope > li").filter({ hasText: "Fortress" }).locator(".chip")).toHaveText("T3");
    const dh = a.locator(":scope > li").filter({ hasText: "Demon Hunter" });
    await expect(dh.locator("ol > li")).toHaveText(["2:22", "4:06", "6:40", "11:54"]);
    await expect(a.getByText("Immolation", { exact: true })).toHaveCount(0);

    // the player heads stay in view while the lists scroll
    const head = a.locator("xpath=preceding-sibling::div[1]");
    await expect(head).toHaveCSS("position", "sticky");
    await a.locator(":scope > li").nth(30).scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 400);
    await expect(async () => expect((await head.boundingBox())!.y).toBeLessThan(1)).toPass();
    await expect(head).toBeVisible();
  });

  test("chat: all-chat lines, no private line", async ({ page }) => {
    const chat = section(page, "Chat");
    await expect(chat.locator("li")).toHaveCount(replay.chat.length);
    await expect(chat.locator("li").first()).toContainText("0:09");
    await expect(chat.locator("li").first()).toContainText(NE);
    await expect(chat.locator("li").first()).toContainText("glhf");
    await expect(page.getByText("Private")).toHaveCount(0);
  });
});

test("a 31-minute game keeps the Units lane a few rows high", async ({ page, request }) => {
  const r: Replay = await (await request.get(`${API}/replays/${LONG}`)).json();
  await page.goto(`/replays/${LONG}`);
  for (const p of r.players) {
    const g = lanes(page, p.name);
    await expect(g.locator("[data-mark]")).toHaveCount(groups(r, p.name).length);
    await noOverlap(g);
    // lane heights from the lane label spacing; the first lane starts under the 24 px tier band
    const tops = await g.locator("svg text").filter({ hasText: /^(Buildings|Units|Upgrades|Heroes|Items)$/ }).evaluateAll((ts) => ts.map((t) => t.getBoundingClientRect().top));
    const box = (await g.boundingBox())!;
    const offset = tops[0] - (box.y + 24);
    const heights = tops.map((y, i) => (tops[i + 1] ?? box.y + box.height + offset) - y);
    // a row is 27 px and a lane adds 5: about 50 unit orders over 31 minutes fit in 3 rows
    expect(heights[1]).toBeLessThanOrEqual(3 * 27 + 5 + 0.5);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(27 + 5 - 0.5);
  }
});

// Shallow Grave, Tidehunters and Fading Autumn; the last has a hero the parser left with no code
for (const id of [LONG, "025d14359f58eac19f263f0dce880bc13bf9cf8d087158202addeb93474ac8c2", FADING]) {
  test(`every mark of ${id.slice(0, 8)} has a name, never a raw code`, async ({ page, request }) => {
    const r: Replay = await (await request.get(`${API}/replays/${id}`)).json();
    await page.goto(`/replays/${id}`);
    const marks = timeline(page).locator("[data-mark]");
    await expect(marks.first()).toBeVisible();
    const labels = await marks.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
    expect(labels.filter((l) => !/^\S/.test(l) || l.startsWith(".")), "marks with no name").toEqual([]);
    const names = labels.map((l) => l.split(/ ×|\. /)[0]);
    expect([...new Set(r.events.map((e) => e.code))].filter((c) => names.includes(c)), "codes shown with no name").toEqual([]);
  });

  // the API's matchup is in letter order; the page's follows the players line
  test(`the matchup of ${id.slice(0, 8)} reads in the players' order`, async ({ page }) => {
    await page.goto(`/replays/${id}`);
    const header = page.locator("section").filter({ has: page.getByRole("heading", { level: 1 }) });
    const races = await header.locator("p").first().locator("img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).alt));
    expect(races).toHaveLength(2);
    const meta = page.locator("p").filter({ has: page.getByRole("img", { name: "Length" }) });
    await expect(meta.getByText(races.map((r) => LETTER[r]).join("v"), { exact: true })).toBeVisible();
  });
}

test("the list marks a retrain and a hero's arrival", async ({ page }) => {
  await page.goto(`/replays/${LONG}`);
  await timeline(page).getByRole("button", { name: "List" }).click();
  const rows = list(page, NE).locator(":scope > li > div");
  await expect(rows.filter({ hasText: /^22:03Demon Hunter/ })).toHaveText("22:03Demon HunterRetrained");
  await expect(rows.filter({ hasText: /^\d+:\d\dDemon Hunter/ }).first()).toHaveText(/^\d+:\d\dDemon HunterTrained by$/);
});

test("a hero and skills in no mappings row read Unknown, on a ? tile", async ({ page }) => {
  await page.goto(`/replays/${FADING}`);
  const h = hero(card(page, NE), "Unknown hero");
  await expect(h).toContainText("Level 2");
  await expect(h.locator("ol > li")).toHaveText(["15:31", "18:04"]);
  await expect(h.locator("ol > li").first()).toHaveAttribute("title", "Unknown skill at 15:31");
  const mark = lanes(page, NE).getByRole("img", { name: "Unknown skill. Unknown hero skill at 15:31" });
  await expect(mark).toBeVisible();
  await expect(lanes(page, NE).getByRole("img", { name: "Unknown hero. Trained by 15:31" })).toBeVisible();
  expect(await mark.locator("span").first().evaluate((e) => getComputedStyle(e, "::before").content)).toBe('"?"');
});

test.describe("replay detail at 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("cards stack and the timeline opens on the list in two tabs", async ({ page, request }) => {
    const replay: Replay = await (await request.get(`${API}/replays/${ID}`)).json();
    await page.goto(`/replays/${ID}`);
    const a = await card(page, NE).boundingBox();
    const b = await card(page, OC).boundingBox();
    expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.height);

    const t = timeline(page);
    await expect(t.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    await expect(t.getByRole("img", { name: /^APM per minute/ })).toHaveCount(0);
    await expect(t.getByRole("table")).toBeVisible();
    const tabs = t.getByRole("tab");
    await expect(tabs).toHaveCount(2);
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    await expect(tabs.first()).toContainText(NE);
    await expect(t.getByRole("tabpanel").getByRole("list", { name: `Orders of ${NE}` })).toBeVisible();
    await expect(t.getByRole("tabpanel").getByText("Ordered", { exact: true })).toBeVisible();
    const raw = await list(page, NE).locator(":scope > li > div > span:first-child").allInnerTexts();
    expect(raw.filter((s) => !/^\d+:\d\d$/.test(s)), "times not m:ss").toEqual([]);
    await expect(list(page, NE).locator(":scope > li")).toHaveCount(listRows(groups(replay, NE)));
    const first = list(page, NE).locator(":scope > li").first();
    await expect(first).toHaveText(/^0:02Wisp ×5/);
    await expect(first.locator("img").first()).toBeVisible();

    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(list(page, OC).locator(":scope > li").first()).toHaveText(/^0:02Peon ×4/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    // the chart is one tap away and scrolls inside its own box
    await t.getByRole("button", { name: "Chart" }).click();
    const plot = t.getByRole("img", { name: /^APM per minute/ });
    await expect(plot.locator("path")).toHaveCount(2);
    const scroller = await plot.evaluate((el) => {
      const box = el.closest(".overflow-x-auto")!;
      return [box.scrollWidth, box.clientWidth];
    });
    expect(scroller[0]).toBeGreaterThan(scroller[1]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

for (const id of ["nope", "a".repeat(64)]) {
  test(`unknown id ${id.slice(0, 8)} shows No game with this id`, async ({ page }) => {
    const res = await page.goto(`/replays/${id}`);
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "No game with this id" })).toBeVisible();
    await expect(page).toHaveTitle(/No game with this id/);
    await expect(page.getByRole("link", { name: "Search replays" })).toHaveAttribute("href", "/");
    await expect(page.getByText("Game Timeline")).toHaveCount(0);
    await expect(page.getByText("APM per minute")).toHaveCount(0);
  });
}
