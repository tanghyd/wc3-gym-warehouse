import { expect, test } from "@playwright/test";

const ID = "dcd39e47097a4a010bc4006e0bf521e3726a0b8e9284cc0b8e2fb74411fbfef8";
const UI = process.env.UI_URL ?? "http://ui";

test.describe("replay list", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("lists the three goldens", async ({ page }) => {
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Replays");
    await expect(page.locator("tbody tr")).toHaveCount(3);
  });

  // Rows per focus-player race, from POST /search on the goldens.
  for (const [label, id, n] of [
    ["Night Elf", "NE", 3],
    ["Orc", "OC", 2],
    ["Human", "HU", 1],
    ["Undead", "UD", 0],
  ] as const) {
    test(`race ${label} keeps ${n}`, async ({ page }) => {
      await page.getByRole("combobox", { name: "Race", exact: true }).selectOption({ label });
      await page.getByRole("button", { name: "Search" }).click();
      await expect(page).toHaveURL(new RegExp(`[?&]race=${id}(&|$)`));
      if (n) await expect(page.locator("tbody tr")).toHaveCount(n);
      else await expect(page.getByText("No replay matches")).toBeVisible();
    });
  }

  test("race and opponent race narrow to the NvH game; Clear drops them", async ({ page }) => {
    await page.getByRole("combobox", { name: "Race", exact: true }).selectOption({ label: "Night Elf" });
    await page.getByRole("combobox", { name: "Opponent race" }).selectOption({ label: "Human" });
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody tr")).toContainText("Springtime 1.3");
    await expect(page.locator("tbody tr").getByRole("img", { name: "Human" })).toBeVisible();
    await page.getByRole("link", { name: "Clear" }).click();
    await expect(page.locator("tbody tr")).toHaveCount(3);
  });

  test("a row links to its replay page", async ({ page }) => {
    await page.getByRole("link", { name: "Concealed Hill" }).click();
    await expect(page).toHaveURL(`/replays/${ID}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Concealed Hill");
  });

  test("the theme menu sets dark and keeps it over a reload", async ({ page }) => {
    await page.getByLabel("Theme").selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(25, 26, 22)");
  });
});

test("the old page links a replay row to the inspector on :3000", async ({ page }) => {
  await page.goto(UI);
  const run = page.getByRole("button", { name: "Run search" });
  await expect(run).toBeEnabled({ timeout: 30_000 });
  await run.click();
  const links = page.locator('a[href*=":3000/replays/"]');
  await expect(links).toHaveCount(3);
  await expect(links.filter({ hasText: "Concealed Hill" })).toHaveAttribute("href", new RegExp(`^http://ui:3000/replays/${ID}$`));
});
