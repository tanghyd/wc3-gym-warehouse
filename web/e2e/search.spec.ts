import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const ID = "dcd39e47097a4a010bc4006e0bf521e3726a0b8e9284cc0b8e2fb74411fbfef8";
const API = process.env.API_URL ?? "http://api:8000";

const rows = (page: Page) => page.locator("tbody tr");
// The three parser goldens are the GNL rows: series 9001 to 9003.
const goldens = (page: Page) => rows(page).filter({ hasText: /\bS900[123] G\d/ });
/** The rows with no race icon of this name: none, when a race filter holds. */
const without = (page: Page, race: string) =>
  rows(page).evaluateAll((trs, alt) => trs.filter((tr) => !tr.querySelector(`img[alt="${alt}"]`)).map((tr) => tr.textContent), race);
/** Seconds of an m:ss length cell. */
const secs = (t: string) => Number(t.split(":")[0]) * 60 + Number(t.split(":")[1]);
type Row = {
  replay_id: string;
  duration_ms: number;
  focus_player_id: number;
  players: { player_id: number; name: string; won: boolean | null; heroes: { code: string; final_level: number }[] }[];
};
const search = async (request: APIRequestContext, filters: object): Promise<Row[]> => (await (await request.post(`${API}/search`, { data: { filters } })).json()).replays;
/** The replay ids the list shows, top first. */
const listed = (page: Page) => page.locator('tbody a[href^="/replays/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")!.split("/").pop()));
// The goldens' maps hold fewer games than the list's 100, so a list of one shows all of its goldens:
// S9001 OvN and S9002 HvN on Springtime 1.3, S9003 NvO on Concealed Hill.
const SPRING = "/?map=Springtime%201.3";
const HILL = "/?map=Concealed%20Hill";
const record = (w: number, l: number) => (w + l ? `${w} – ${l}` + (w + l >= 10 ? ` (${Math.round((100 * w) / (w + l))}%)` : "") : "—");
const NAME = "thanks#11187";

test.describe("replay list", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("lists the games POST /search answers, the three goldens on their maps' lists", async ({ page, request }) => {
    const want = await search(request, {});
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Replays");
    await expect(rows(page)).toHaveCount(want.length);
    expect(await listed(page)).toEqual(want.map((r) => r.replay_id));
    await page.goto(SPRING);
    await expect(goldens(page)).toHaveCount(2);
    await page.goto(HILL);
    await expect(goldens(page)).toHaveCount(1);
  });

  test("each player's heroes sit under his name in pick order, as the API row has them", async ({ page, request }) => {
    const replays = await search(request, {});
    const codes = [...new Set(replays.flatMap((r) => r.players.flatMap((p) => p.heroes.map((h) => h.code))))];
    expect(codes.length).toBeGreaterThan(0);
    const res = await request.post(`${API}/query`, { data: { model: "mappings", dimensions: ["code", "name"], filters: { code: codes, kind: ["hero"] }, limit: 10000 } });
    const name = Object.fromEntries((await res.json()).rows.map((r: { code: string; name: string }) => [r.code, r.name]));
    // per row: its id, then per player in slot order his name and each hero's label
    const want = replays.map((r) => [r.replay_id, r.players.map((p) => [p.name, p.heroes.map((h) => `${name[h.code] ?? "Unknown hero"}, level ${h.final_level}`)])]);
    await expect(rows(page)).toHaveCount(replays.length);
    const got = await rows(page).evaluateAll((trs) =>
      trs.map((tr) => [
        tr.querySelector('a[href^="/replays/"]')!.getAttribute("href")!.split("/").pop(),
        [...tr.querySelectorAll("ul:not([aria-label]) > li")].map((li) => {
          const icons = [...li.querySelectorAll('ul[aria-label="Heroes"] > li > *')];
          // the name a screen reader reads and the hover title agree
          const labels = icons.map((i) => i.getAttribute("alt") ?? i.getAttribute("aria-label"));
          return [li.querySelector(".font-name")!.textContent, icons.every((i, k) => i.getAttribute("title") === labels[k]) ? labels : ["title differs"]];
        }),
      ]),
    );
    expect(got).toEqual(want);

    // Concealed Hill: Demon Hunter then Keeper of the Grove against Far Seer, Shadow Hunter, Tauren Chieftain
    await page.goto(HILL);
    const hill = goldens(page).filter({ hasText: "Concealed Hill" });
    const heroes = (player: string) => hill.getByRole("listitem").filter({ hasText: player }).getByRole("list", { name: "Heroes" }).getByRole("img");
    const named = async (player: string) => (await heroes(player).evaluateAll((es) => es.map((e) => e.getAttribute("alt") ?? e.getAttribute("aria-label")))).map((l) => l!.split(",")[0]);
    expect(await named("thanks#11187")).toEqual(["Demon Hunter", "Keeper of the Grove"]);
    expect(await named("Okeanos#22605")).toEqual(["Far Seer", "Shadow Hunter", "Tauren Chieftain"]);
    expect(await heroes("thanks#11187").first().evaluate((e) => e.getBoundingClientRect().width)).toBe(20);
  });

  // Golden rows per focus-player race on Springtime 1.3 and on Concealed Hill, from POST /search on the goldens.
  for (const [label, id, spring, hill] of [
    ["Night Elf", "NE", 2, 1],
    ["Orc", "OC", 1, 1],
    ["Human", "HU", 1, 0],
    ["Undead", "UD", 0, 0],
  ] as const) {
    test(`race ${label} keeps ${spring + hill} goldens`, async ({ page }) => {
      for (const [url, n] of [
        [SPRING, spring],
        [HILL, hill],
      ] as const) {
        await page.goto(url);
        await page.getByRole("combobox", { name: "Race", exact: true }).selectOption({ label });
        await page.getByRole("button", { name: "Search" }).click();
        await expect(page).toHaveURL(new RegExp(`[?&]race=${id}(&|$)`));
        await expect(goldens(page)).toHaveCount(n);
        expect(await without(page, label), `rows with no ${label}`).toEqual([]);
      }
    });
  }

  test("race and opponent race narrow to the NvH game; Clear drops them", async ({ page, request }) => {
    await page.goto(SPRING);
    await page.getByRole("combobox", { name: "Race", exact: true }).selectOption({ label: "Night Elf" });
    await page.getByRole("combobox", { name: "Opponent race" }).selectOption({ label: "Human" });
    await page.getByRole("button", { name: "Search" }).click();
    await expect(goldens(page)).toHaveCount(1);
    await expect(goldens(page)).toContainText("Springtime 1.3");
    await expect(goldens(page).getByRole("img", { name: "Human" })).toBeVisible();
    for (const race of ["Night Elf", "Human"]) expect(await without(page, race), `rows with no ${race}`).toEqual([]);
    // Clear drops every filter, the map too: the list is POST /search's with none
    const all = await search(request, {});
    await page.getByRole("link", { name: "Clear" }).click();
    await expect(rows(page)).toHaveCount(all.length);
    expect(await listed(page)).toEqual(all.map((r) => r.replay_id));
  });

  test("minutes from and to keep games of that length, ends included", async ({ page, request }) => {
    await page.goto(HILL);
    await page.getByRole("spinbutton", { name: "Minutes from" }).fill("15");
    await page.getByRole("spinbutton", { name: "Minutes to" }).fill("16");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/[?&]min=15&max=16(&|$)/);
    await expect(goldens(page)).toHaveCount(1);
    await expect(goldens(page)).toContainText("Concealed Hill");
    const lengths = (await rows(page).locator("td:last-child").allInnerTexts()).map(secs);
    expect(lengths.length).toBeGreaterThan(0);
    expect(lengths.filter((s) => s < 15 * 60 || s > 16 * 60)).toEqual([]);
    // exactly the map's games from 15:00.000 to 16:00.000, so a 16:02 game never rounds in
    const all = await search(request, { map: ["Concealed Hill"] });
    expect(all.length).toBeLessThan(100);
    await expect(rows(page)).toHaveCount(all.filter((r) => r.duration_ms >= 900_000 && r.duration_ms <= 960_000).length);

    await page.getByRole("spinbutton", { name: "Minutes from" }).fill("999");
    await page.getByRole("spinbutton", { name: "Minutes to" }).fill("");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByText("No replay matches")).toBeVisible();
  });

  // the API's matchup is in letter order; a row's follows its players, top first
  test("each row's matchup reads in its players' order", async ({ page }) => {
    const LETTER: Record<string, string> = { Human: "H", Orc: "O", "Night Elf": "N", Undead: "U", Random: "R" };
    const got = await rows(page).evaluateAll((trs) =>
      trs.map((tr) => [(tr as HTMLTableRowElement).cells[2].textContent, [...(tr as HTMLTableRowElement).cells[3].querySelectorAll<HTMLImageElement>(".font-name + img")].map((i) => i.alt)] as const),
    );
    expect(got.length).toBeGreaterThan(0);
    expect(got.filter(([m, races]) => m !== races.map((r) => LETTER[r]).join("v"))).toEqual([]);
    await expect(goldens(page).filter({ hasText: "S9001" }).locator("td").nth(2)).toHaveText("OvN");
  });

  test(`${NAME} as player 1: the list, the Player 1 column and the record as the API's`, async ({ page, request }) => {
    const replays = await search(request, { player: [NAME] });
    await page.goto(`/?player=${encodeURIComponent(NAME)}`);
    await expect(rows(page)).toHaveCount(replays.length);
    expect(await listed(page)).toEqual(replays.map((r) => r.replay_id));
    // the Player 1 column: his chip
    const focus = replays.map((r) => r.players.find((p) => p.player_id === r.focus_player_id)!.won);
    const got = await rows(page).evaluateAll((trs) => trs.map((tr) => (tr as HTMLTableRowElement).cells[4].querySelector(".chip")?.textContent ?? null));
    expect(got).toEqual(focus.map((won) => (won === null ? null : won ? "Won" : "Lost")));
    const [w, l] = [focus.filter((won) => won === true).length, focus.filter((won) => won === false).length];
    await expect(page.locator(".bar").filter({ hasText: "Games" })).toContainText(`Player 1 record ${record(w, l)}`);
  });

  test("the patch filter keeps that patch's games, as the API counts them", async ({ page, request }) => {
    const patch = page.getByRole("combobox", { name: "Patch" });
    await expect(patch).toHaveValue("");
    const res = await request.post(`${API}/query`, { data: { dimensions: ["patch"], measures: ["games"], order_by: ["patch"] } });
    const values: string[] = (await res.json()).rows.map((r: { patch: string }) => r.patch).filter(Boolean);
    expect(values).toContain("2.0");
    await expect(patch.locator("option")).toHaveText(["Any", ...values]);

    for (const value of values) {
      await patch.selectOption(value);
      await page.getByRole("button", { name: "Search" }).click();
      await expect(page).toHaveURL(new RegExp(`[?&]patch=${value.replace(".", "\\.")}(&|$)`));
      const want = await search(request, { patch: [value] });
      await expect(rows(page)).toHaveCount(want.length);
      expect(await listed(page)).toEqual(want.map((r) => r.replay_id));
      // a patch names no player, so no Player 1 column
      await expect(page.getByRole("columnheader", { name: "Player 1" })).toHaveCount(0);
    }

    // the goldens are build 6117, patch 2.0: its lists of their maps hold all three
    await page.goto(`${SPRING}&patch=2.0`);
    await expect(goldens(page)).toHaveCount(2);
    await page.goto(`${HILL}&patch=2.0`);
    await expect(goldens(page)).toHaveCount(1);
  });

  test("a row links to its replay page", async ({ page }) => {
    await page.goto(HILL);
    await goldens(page).getByRole("link", { name: "Concealed Hill" }).click();
    await expect(page).toHaveURL(`/replays/${ID}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Concealed Hill");
  });

  test("the theme menu sets dark and keeps it over a reload", async ({ page }) => {
    await page.getByLabel("Theme").selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(8, 5, 3)");
  });
});
