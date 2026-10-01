import path from "node:path";
import { expect, test } from "@playwright/test";

// Full-page screenshots for a look in both themes, written to shots/ (gitignored).
const PAGES = [
  ["search", "/"],
  ["replay", "/replays/dcd39e47097a4a010bc4006e0bf521e3726a0b8e9284cc0b8e2fb74411fbfef8"],
  // Shallow Grave, 31 minutes, NE v OC: the longest human game
  ["replay-long", "/replays/a9872674567c6389f3d912b5f053f7e2af4a87de3378d5229a90f091bd219d88"],
  ["missing", "/replays/nope"],
] as const;
// The `background` token, light and dark.
const BACKGROUND = { light: "rgb(232, 233, 227)", dark: "rgb(8, 5, 3)" };

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`${theme} ${width}`, () => {
      test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme });

      for (const [name, url] of PAGES) {
        test(name, async ({ page }) => {
          await page.goto(url);
          await page.evaluate(() => document.fonts.ready);
          if (name.startsWith("replay")) await expect(page.getByRole("img", { name: /^APM per minute/ }).locator("path")).toHaveCount(2);
          const shot = (suffix: string) => path.join(__dirname, "shots", `${name}-${theme}-${width}${suffix}.png`);
          await page.screenshot({ path: shot(""), fullPage: true });
          // a tall page also in parts, small enough to read
          const height = await page.evaluate(() => document.documentElement.scrollHeight);
          const part = Math.round(page.viewportSize()!.height * 1.5);
          if (height > part * 1.5)
            for (let y = 0; y < height; y += part)
              await page.screenshot({ path: shot(`-part${y / part + 1}`), fullPage: true, clip: { x: 0, y, width, height: Math.min(part, height - y) } });

          expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(BACKGROUND[theme]);
          if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
        });
      }
    });
  }
}
