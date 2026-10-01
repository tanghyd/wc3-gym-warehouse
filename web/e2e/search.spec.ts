import { expect, test, type Page } from "@playwright/test";

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

test.describe("replay list", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("lists every game, the three goldens among them", async ({ page, request }) => {
    const all = (await (await request.post(`${API}/search`, { data: { filters: {} } })).json()).replays.length;
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Replays");
    await expect(rows(page)).toHaveCount(all);
    await expect(goldens(page)).toHaveCount(3);
  });

  // Golden rows per focus-player race, from POST /search on the goldens.
  for (const [label, id, n] of [
    ["Night Elf", "NE", 3],
    ["Orc", "OC", 2],
    ["Human", "HU", 1],
    ["Undead", "UD", 0],
  ] as const) {
    test(`race ${label} keeps ${n} goldens`, async ({ page }) => {
      await page.getByRole("combobox", { name: "Race", exact: true }).selectOption({ label });
      await page.getByRole("button", { name: "Search" }).click();
      await expect(page).toHaveURL(new RegExp(`[?&]race=${id}(&|$)`));
      await expect(goldens(page)).toHaveCount(n);
      expect(await without(page, label), `rows with no ${label}`).toEqual([]);
    });
  }

  test("race and opponent race narrow to the NvH game; Clear drops them", async ({ page }) => {
    await page.getByRole("combobox", { name: "Race", exact: true }).selectOption({ label: "Night Elf" });
    await page.getByRole("combobox", { name: "Opponent race" }).selectOption({ label: "Human" });
    await page.getByRole("button", { name: "Search" }).click();
    await expect(goldens(page)).toHaveCount(1);
    await expect(goldens(page)).toContainText("Springtime 1.3");
    await expect(goldens(page).getByRole("img", { name: "Human" })).toBeVisible();
    for (const race of ["Night Elf", "Human"]) expect(await without(page, race), `rows with no ${race}`).toEqual([]);
    await page.getByRole("link", { name: "Clear" }).click();
    await expect(goldens(page)).toHaveCount(3);
  });

  test("minutes from and to keep games of that length, ends included", async ({ page, request }) => {
    await page.getByRole("spinbutton", { name: "Minutes from" }).fill("15");
    await page.getByRole("spinbutton", { name: "Minutes to" }).fill("16");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/[?&]min=15&max=16(&|$)/);
    await expect(goldens(page)).toHaveCount(1);
    await expect(goldens(page)).toContainText("Concealed Hill");
    const lengths = (await rows(page).locator("td:last-child").allInnerTexts()).map(secs);
    expect(lengths.length).toBeGreaterThan(0);
    expect(lengths.filter((s) => s < 15 * 60 || s > 16 * 60)).toEqual([]);
    // exactly the games from 15:00.000 to 16:00.000, so a 16:02 game never rounds in
    const all: { duration_ms: number }[] = (await (await request.post(`${API}/search`, { data: { filters: {} } })).json()).replays;
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
      trs.map((tr) => [(tr as HTMLTableRowElement).cells[2].textContent, [...(tr as HTMLTableRowElement).cells[3].querySelectorAll("img")].map((i) => i.alt)] as const),
    );
    expect(got.length).toBeGreaterThan(0);
    expect(got.filter(([m, races]) => m !== races.map((r) => LETTER[r]).join("v"))).toEqual([]);
    await expect(goldens(page).filter({ hasText: "S9001" }).locator("td").nth(2)).toHaveText("OvN");
  });

  test("a row links to its replay page", async ({ page }) => {
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
