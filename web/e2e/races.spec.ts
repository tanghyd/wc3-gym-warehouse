import { expect, test, type APIRequestContext } from "@playwright/test";

// The race control: the four races, a Random submenu of the four Random races, the counts from
// POST /query, and the "Include Random" switch, here on /openers.
const API = process.env.API_URL ?? "http://api:8000";
const RACE = { HU: "Human", OC: "Orc", NE: "Night Elf", UD: "Undead" } as const;
const RANDOM = { HU: "Random Human", OC: "Random Orc", NE: "Random Night Elf", UD: "Random Undead" } as const;

/** Player-games per (race, random) pair, as "NE:0" -> games. */
async function counts(request: APIRequestContext) {
  const res = await request.post(`${API}/query`, { data: { dimensions: ["race", "random"], measures: ["games"], limit: 100 } });
  return Object.fromEntries((await res.json()).rows.map((r: { race: string; random: number; games: number }) => [`${r.race}:${r.random}`, r.games]));
}

async function decided(request: APIRequestContext, filters: Record<string, (string | number)[]>) {
  const res = await request.post(`${API}/query`, { data: { measures: ["games"], filters: { ...filters, result: ["win", "loss"] } } });
  return (await res.json()).rows[0].games as number;
}

const fmt = (n: number) => n.toLocaleString("en-US");

test.describe("race control", () => {
  test("the menu lists the four races and a Random submenu with their player-games", async ({ page, request }) => {
    const n = await counts(request);
    await page.goto("/openers?race=NE");
    await page.getByRole("button", { name: "Opponent race: Any race" }).click();
    const menu = page.getByRole("menu", { name: "Opponent race" });
    // picked races in the fixed order, then Random; Any race counts every player-game
    const total = Object.values(n).reduce((a: number, b) => a + (b as number), 0);
    await expect(menu.getByRole("menuitemradio", { name: /^Any race/ })).toContainText(fmt(total));
    for (const [code, name] of Object.entries(RACE)) await expect(menu.getByRole("menuitemradio", { name: new RegExp(`^${name}`) })).toContainText(fmt(n[`${code}:0`] ?? 0));
    const names = await menu.locator(':scope > li > [role^="menuitem"] > span:not(.opt-count)').allInnerTexts();
    expect(names).toEqual(["Any race", "Human", "Orc", "Night Elf", "Undead", "Random"]);

    await menu.getByRole("menuitem", { name: /^Random/ }).click();
    const sub = page.getByRole("menu", { name: "Random" });
    for (const [code, name] of Object.entries(RANDOM)) {
      const item = sub.getByRole("menuitemradio", { name: new RegExp(`^${name}`) });
      await expect(item).toContainText(fmt(n[`${code}:1`] ?? 0));
      // the race icon with its stone "?" badge, loaded
      const icon = item.getByRole("img", { name });
      await expect(icon).toHaveAttribute("src", `/race-icons/RANDOM_${name.slice(7).toUpperCase().replace(" ", "_")}.png`);
      await expect.poll(() => icon.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
    }
  });

  test("Random Night Elf means a Random player who rolled Night Elf", async ({ page, request }) => {
    await page.goto("/openers?race=NE");
    await page.getByRole("button", { name: "Race: Night Elf" }).click();
    await page.getByRole("menuitem", { name: /^Random/ }).click();
    await page.getByRole("menuitemradio", { name: /^Random Night Elf/ }).click();
    await expect(page.getByRole("button", { name: "Race: Random Night Elf" })).toBeVisible();
    // a Random race takes no Random switch
    await expect(page.getByRole("checkbox", { name: /^Include Random/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Show openers" }).click();
    await expect(page).toHaveURL(/[?&]race=RN(&|$)/);
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Random Night Elf");
    await expect(page.locator(".bar .chip")).toHaveText(`${await decided(request, { race: ["NE"], random: [1] })} games won or lost`);
  });

  test("Night Elf means picked Night Elf, and the switch adds the Random Night Elf games", async ({ page, request }) => {
    const [picked, both] = await Promise.all([decided(request, { race: ["NE"], random: [0] }), decided(request, { race: ["NE"] })]);
    expect(both).toBeGreaterThan(picked);
    await page.goto("/openers?race=NE");
    await expect(page.locator(".bar .chip")).toHaveText(`${picked} games won or lost`);
    const toggle = page.getByRole("checkbox", { name: "Include Random Night Elf" });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await page.getByRole("button", { name: "Show openers" }).click();
    await expect(page).toHaveURL(/[?&]race=NE%2CRN(&|$)/);
    await expect(page.getByRole("checkbox", { name: "Include Random Night Elf" })).toBeChecked();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Night Elf or Random Night Elf");
    await expect(page.locator(".bar .chip")).toHaveText(`${both} games won or lost`);
  });

  test("the keyboard walks the menu and opens the Random submenu", async ({ page }) => {
    await page.goto("/openers?race=NE");
    const button = page.getByRole("button", { name: "Opponent race: Any race" });
    await button.focus();
    await page.keyboard.press("Enter");
    // the chosen row takes focus; Random is the last row
    await expect(page.getByRole("menuitemradio", { name: /^Any race/ })).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByRole("menuitem", { name: /^Random/ })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("menuitemradio", { name: /^Random Human/ })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Opponent race: Random Orc" })).toBeFocused();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test("on a phone the Random submenu opens under its row, inside the screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/openers?race=NE");
    await page.getByRole("button", { name: "Opponent race: Any race" }).click();
    await page.getByRole("menuitem", { name: /^Random/ }).click();
    const [row, sub] = await Promise.all([
      page.getByRole("menuitem", { name: /^Random/ }).boundingBox(),
      page.getByRole("menu", { name: "Random" }).boundingBox(),
    ]);
    expect(sub!.y).toBeGreaterThanOrEqual(row!.y + row!.height - 1);
    expect(sub!.x + sub!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
