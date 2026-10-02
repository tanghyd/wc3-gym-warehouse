import { expect, test } from "@playwright/test";
import { fmt, listed, q, record, rowsOf, search, strip, stripOf } from "./helpers";

// The Replays list: one row per game that fits both sides, the summary strip, the pager, the sort
// and the swap, each compared with POST /search.
const ID = "dcd39e47097a4a010bc4006e0bf521e3726a0b8e9284cc0b8e2fb74411fbfef8";
// The spec's example: a Night Elf with Demon Hunter first and 5 Archers by 6:00, against a Blademaster-first Orc.
const NE_STEPS = "hero:Edem#1,trained:earc*5@-360";
const OC_STEPS = "hero:Obla#1";
const EXAMPLE = q({ race: "NE", steps: NE_STEPS, opponent_race: "OC", opp_steps: OC_STEPS });
const EXAMPLE_API = {
  player: { race: ["NE"], groups: [{ steps: [{ kind: "hero", codes: ["Edem"], nth: 1 }, { kind: "unit", codes: ["earc"], count: 5, to_s: 360 }] }] },
  opponent: { race: ["OC"], groups: [{ steps: [{ kind: "hero", codes: ["Obla"], nth: 1 }] }] },
};

test.describe("replay list", () => {
  test("the first page is POST /search's: rows, total, figures and pager", async ({ page, request }) => {
    const want = await search(request, {});
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Replays");
    expect(await listed(page)).toEqual(rowsOf(want));
    expect(await strip(page)).toEqual(stripOf(want));
    await expect(page.getByRole("navigation", { name: "Games pages" })).toContainText(`1–25 of ${fmt(want.total)}`);
    // every game counts once and fits both ways, so the strip shows no record
    expect(want.total).toBe(want.summary.games);
    expect([want.summary.wins, want.summary.losses]).toEqual([null, null]);
    await expect(page.locator(".s-l", { hasText: "Player record" })).toHaveCount(0);
    await expect(page.locator(".stat").nth(0).locator(".s-n")).toHaveText("All games");
  });

  test("the summary strip reads the summary and the scope of the spec's example", async ({ page, request }) => {
    const want = await search(request, EXAMPLE_API);
    await page.goto(EXAMPLE);
    expect(await strip(page)).toEqual(stripOf(want));
    const { scope, summary } = want;
    await expect(page.locator(".stat").nth(0)).toContainText(`${Math.round((100 * summary.games) / scope.games)}% of ${fmt(scope.games)} Night Elf v Orc games`);
    await expect(page.locator(".stat").nth(1)).toContainText(`Of ${fmt(scope.games - scope.both)} one way: ${record(scope.wins!, scope.losses!)}`);
    // two figures: Games and Player record
    await expect(page.locator(".stat")).toHaveCount(2);
    await expect(page.locator(".s-l", { hasText: "Avg length" })).toHaveCount(0);
    expect(await listed(page)).toEqual(rowsOf(want));
    // a row's result is the Player's: a square and the word
    const first = want.replays[0];
    await expect(page.locator("table.games tbody tr").first().locator(".c-r")).toHaveText(first.player.won ? "Won" : "Lost");
  });

  test("a mirror game both players fit counts once and adds no result", async ({ page, request }) => {
    const want = await search(request, { player: { race: ["NE"] }, opponent: { race: ["NE"] } });
    // the sides ask the same, so every Night Elf v Night Elf game fits either way round: one row, no record
    expect(want.summary.games).toBeGreaterThan(0);
    expect(want.summary.both).toBe(want.summary.games);
    expect([want.summary.wins, want.summary.losses]).toEqual([null, null]);
    expect(new Set(want.replays.map((r) => r.replay_id)).size).toBe(want.replays.length);
    await page.goto(q({ race: "NE", opponent_race: "NE" }));
    expect(await strip(page)).toEqual(stripOf(want));
    await expect(page.locator(".s-l", { hasText: "Player record" })).toHaveCount(0);
    expect(await listed(page)).toEqual(rowsOf(want));
    // with no record every row fits both ways, so neither the tag nor the both line shows
    await expect(page.locator("table.games tbody .both")).toHaveCount(0);
    await expect(page.locator(".stat").nth(0).locator(".s-n", { hasText: "fit both ways" })).toHaveCount(0);

    // Night Elf against any race: a record of the games that fit one way, the mirrors counted apart and tagged
    const any = await search(request, { player: { race: ["NE"] } });
    expect(any.summary.wins).not.toBeNull();
    expect(any.summary.both).toBe(want.summary.games);
    expect(any.summary.both).toBeLessThan(any.summary.games);
    await page.goto(q({ race: "NE" }));
    expect(await strip(page)).toEqual(stripOf(any));
    await expect(page.locator(".stat").nth(0).locator(".s-n", { hasText: "fit both ways" })).toHaveText(`${fmt(any.summary.both)} fit both ways`);
    // the tag sits after the Player's name, the only tag of the row
    const tagged = any.replays.filter((r) => r.both).length;
    expect(tagged).toBeGreaterThan(0);
    await expect(page.locator("table.games tbody .c-p .both")).toHaveCount(tagged);
    await expect(page.locator("table.games tbody .c-p .both").first()).toHaveText("both");
    await expect(page.locator("table.games tbody .c-o .both")).toHaveCount(0);
  });

  test("the pager walks the pages in POST /search's order", async ({ page, request }) => {
    const body = { player: { race: ["HU"] } };
    const [one, two] = await Promise.all([search(request, body), search(request, { ...body, offset: 25 })]);
    await page.goto(q({ race: "HU" }));
    await page.getByRole("link", { name: "Next" }).click();
    await expect(page).toHaveURL(/[?&]page=2(&|$)/);
    expect(await listed(page)).toEqual(rowsOf(two));
    await expect(page.getByRole("navigation", { name: "Games pages" })).toContainText(`26–50 of ${fmt(two.total)}`);
    await page.getByRole("link", { name: "Previous" }).click();
    await expect(page).not.toHaveURL(/[?&]page=/);
    expect(await listed(page)).toEqual(rowsOf(one));
    await expect(page.getByRole("navigation", { name: "Games pages" }).getByText("Previous")).toHaveAttribute("aria-disabled", "true");
  });

  test("the sort menu and the column titles order the list as POST /search", async ({ page, request }) => {
    await page.goto(q({ race: "UD" }));
    await page.getByRole("combobox", { name: "Sort" }).selectOption({ label: "Longest" });
    await expect(page).toHaveURL(/[?&]sort=-duration(&|$)/);
    expect(await listed(page)).toEqual(rowsOf(await search(request, { player: { race: ["UD"] }, sort: "-duration" })));
    await expect(page.getByRole("columnheader", { name: "Length" })).toHaveAttribute("aria-sort", "descending");
    // the Length title turns it around, the Map title sorts by map
    await page.getByRole("link", { name: "Length", exact: true }).click();
    await expect(page).toHaveURL(/[?&]sort=duration(&|$)/);
    expect(await listed(page)).toEqual(rowsOf(await search(request, { player: { race: ["UD"] }, sort: "duration" })));
    await page.getByRole("link", { name: "Map", exact: true }).click();
    await expect(page).toHaveURL(/[?&]sort=map(&|$)/);
    expect(await listed(page)).toEqual(rowsOf(await search(request, { player: { race: ["UD"] }, sort: "map" })));
    // a search keeps the sort
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/[?&]sort=map(&|$)/);
  });

  test("swap trades the sides: the same games, the record turned around", async ({ page, request }) => {
    const swapped = await search(request, { player: EXAMPLE_API.opponent, opponent: EXAMPLE_API.player });
    const before = await search(request, EXAMPLE_API);
    expect([swapped.summary.wins, swapped.summary.losses]).toEqual([before.summary.losses, before.summary.wins]);
    await page.goto(EXAMPLE);
    await page.getByRole("button", { name: "Swap sides" }).click();
    await expect(page).toHaveURL(/[?&]race=OC&/);
    const url = new URL(page.url());
    expect([url.searchParams.get("steps"), url.searchParams.get("opponent_race"), url.searchParams.get("opp_steps")]).toEqual([OC_STEPS, "NE", NE_STEPS]);
    expect(await strip(page)).toEqual(stripOf(swapped));
    // the same games, each from the other player's side
    expect((await listed(page)).map((r) => r.split(" ")[0])).toEqual(swapped.replays.map((r) => r.replay_id));
    expect(new Set(swapped.replays.map((r) => r.replay_id))).toEqual(new Set(before.replays.map((r) => r.replay_id)));
    await expect(page.getByRole("region", { name: "Player" }).getByRole("button", { name: /^Step 1: 1st hero Blademaster/ })).toBeVisible();
  });

  test("swap turns Won into Lost", async ({ page }) => {
    await page.goto(q({ race: "NE", result: "won", opponent_race: "OC" }));
    await page.getByRole("button", { name: "Swap sides" }).click();
    await expect(page).toHaveURL(/[?&]result=lost(&|$)/);
    await expect(page.getByRole("radio", { name: "Lost" })).toBeChecked();
  });

  test("minutes from and to keep games of that length, ends included", async ({ page, request }) => {
    const want = await search(request, { filters: { duration_ms: { gte: 600000, lte: 720000 } } });
    await page.goto(q({ min: "10", max: "12", sort: "duration" }));
    expect(await strip(page)).toEqual(stripOf(want));
    const lengths = await page.locator("table.games tbody .c-l").allTextContents();
    for (const t of lengths) expect(Number(t.split(":")[0])).toBeGreaterThanOrEqual(10);
  });

  test("Clear drops every filter", async ({ page }) => {
    await page.goto(EXAMPLE);
    await page.getByRole("link", { name: "Clear" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: "Race: Any race" })).toHaveCount(2);
  });

  test("a row links to its replay page", async ({ page }) => {
    await page.goto(q({ map: "Concealed Hill", player: "thanks#11187" }));
    await page.locator(`a[href="/replays/${ID}"]`).click();
    await expect(page).toHaveURL(`/replays/${ID}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Concealed Hill");
  });

  test("the theme menu sets dark and keeps it over a reload", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Theme").selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(8, 5, 3)");
  });

  test("the Show switches hide heroes, result and length, and the URL keeps the view", async ({ page, request }) => {
    const want = await search(request, { player: { race: ["HU"] } });
    await page.goto(q({ race: "HU" }));
    const show = page.getByRole("group", { name: "Show columns" });
    const box = (name: string) => show.getByRole("checkbox", { name });
    const head = page.locator("table.games thead th:visible");
    // every column shows by default
    for (const n of ["Heroes", "Result", "Length"]) await expect(box(n)).toBeChecked();
    await expect(head).toHaveCount(7);
    await box("Heroes").uncheck();
    await expect(page).toHaveURL(/[?&]hide=heroes(&|$)/);
    await expect(head).toHaveText(["Player", "Result", "Opponent", "Map", "Length"]);
    await expect(page.locator("table.games .heroes").first()).toBeHidden();
    await box("Result").uncheck();
    await box("Length").uncheck();
    await expect(page).toHaveURL(/[?&]hide=heroes\.result\.length(&|$)/);
    await expect(head).toHaveText(["Player", "Opponent", "Map"]);
    // the rows stay POST /search's
    expect(await listed(page)).toEqual(rowsOf(want));
    // a link reproduces the view; the pager, a search and Clear keep it
    await page.reload();
    await expect(head).toHaveText(["Player", "Opponent", "Map"]);
    await expect(box("Result")).not.toBeChecked();
    await page.getByRole("link", { name: "Next" }).click();
    await expect(page).toHaveURL(/[?&]page=2(&|$)/);
    await expect(page).toHaveURL(/[?&]hide=heroes\.result\.length(&|$)/);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/[?&]hide=heroes\.result\.length(&|$)/);
    await page.getByRole("link", { name: "Clear" }).click();
    await expect(page).toHaveURL(/\/\?hide=heroes\.result\.length$/);
    await expect(head).toHaveText(["Player", "Opponent", "Map"]);
    // on again, the key goes
    for (const n of ["Heroes", "Result", "Length"]) await box(n).check();
    await expect(page).toHaveURL(/\/$/);
    await expect(head).toHaveCount(7);
  });

  test("on a phone the Show switches fit and a hidden column frees its place", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(q({ race: "HU", hide: "heroes" }));
    await expect(page.getByRole("group", { name: "Show columns" })).toBeVisible();
    await expect(page.locator("table.games .heroes").first()).toBeHidden();
    await expect(page.locator("table.games tbody .c-r").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test("a row is one slim line of fixed columns, and two lines on a phone", async ({ page }) => {
    await page.goto(EXAMPLE);
    const rows = page.locator("table.games tbody tr");
    const row = rows.first();
    await expect(page.locator("table.games thead th")).toHaveText(["Player", "Heroes", "Result", "Opponent", "Heroes", "Map", "Length"]);
    // one line: a 24 px hero icon and its padding set the height
    const hero = row.locator(".c-ph .heroes img").first();
    expect((await hero.boundingBox())!.width).toBe(24);
    // the classic art W3Champions uses: the Demon Hunter the search asks for first
    await expect(hero).toHaveAttribute("src", "/icons-classic/herodemonhunter.webp");
    expect((await row.boundingBox())!.height).toBeLessThanOrEqual(40);
    // every column starts at the same x on every row, and the length is right-aligned
    const lefts = await rows.evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => Math.round(td.getBoundingClientRect().left)).join(",")));
    expect(new Set(lefts).size).toBe(1);
    expect(await row.locator(".c-l").evaluate((td) => getComputedStyle(td).textAlign)).toBe("right");
    // hover lays the surface-light token on the row, with no zebra between rows
    expect(await rows.nth(1).evaluate((tr) => getComputedStyle(tr).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    await row.hover();
    expect(await row.evaluate((tr) => getComputedStyle(tr).backgroundColor)).toBe("rgb(225, 228, 221)");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("table.games thead")).toBeHidden();
    // two lines: the Player with his heroes, result and length over the Opponent with his heroes and the map
    expect((await hero.boundingBox())!.width).toBe(20);
    expect((await row.boundingBox())!.height).toBeLessThanOrEqual(64);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
