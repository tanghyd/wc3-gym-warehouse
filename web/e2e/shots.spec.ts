import path from "node:path";
import { expect, test } from "@playwright/test";

// Full-page screenshots for a look in both themes, written to shots/ (gitignored).
const PAGES = [
  ["search", "/"],
  // a Night Elf build against an Orc one: timing on two steps, a hero, an outcome
  // thanks#11187 as player 1: inferred results in the Player 1 column
  ["search-player", "/?player=thanks%2311187"],
  ["search-build", `/?race=NE&result=won&steps=${encodeURIComponent("eate@-120,eaom~20,Edem")}&opponent_race=OC&opp_steps=ofor`],
  // the Night Elf tree, open down to the sixth building
  ["openers", "/openers?race=NE&open=eate&open=eate.eaom&open=eate.eaom.eden&open=eate.eaom.eden.etoa&open=eate.eaom.eden.etoa.edob"],
  // the Undead tree by best win rate, open down to a Slaughterhouse sixth
  ["openers-undead", "/openers?race=UD&sort=winrate&open=usep&open=usep.uaod&open=usep.uaod.ugrv&open=usep.uaod.ugrv.utom&open=usep.uaod.ugrv.utom.unp1"],
  // the Orc tree with games vs Computer in: the checkbox checked
  ["openers-computer", "/openers?race=OC&computer=1"],
  // Concealed Hill, 15:37, NE v OC: the story 4 golden
  ["replay", "/replays/dcd39e47097a4a010bc4006e0bf521e3726a0b8e9284cc0b8e2fb74411fbfef8"],
  // Shallow Grave, 31 minutes, NE v OC: the longest human game
  ["replay-long", "/replays/a9872674567c6389f3d912b5f053f7e2af4a87de3378d5229a90f091bd219d88"],
  // Tidehunters, 22 minutes, HU v NE
  ["replay-tidehunters", "/replays/025d14359f58eac19f263f0dce880bc13bf9cf8d087158202addeb93474ac8c2"],
  // Fading Autumn, 20 minutes, NE v UD
  ["replay-autumn", "/replays/be7b97ee9668d1f441fa2973387ea4e02fa5a02d2adababec6cb3e7647871c32"],
  // Northern Isles, 2 minutes, NE v OC: a result from the last actor, marked inferred
  ["replay-inferred", "/replays/f33bf0f15df541045edb030615f9129f28cecf911a7a376865b10f00dd7a049b"],
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
          const timeline = page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: "Game Timeline" }) });
          const apm = page.getByRole("img", { name: /^APM per minute/ }).locator("path");
          // the chart from md up, the list below
          if (name.startsWith("replay")) await (width === 390 ? expect(timeline.getByRole("tab")).toHaveCount(2) : expect(apm).toHaveCount(2));
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

          // the object picker open on Player 2's next step
          if (name === "search-build") {
            const p2 = page.getByRole("region", { name: "Player 2" });
            await p2.getByRole("button", { name: "Add step" }).click();
            await p2.getByRole("button", { name: "Timing for step 1" }).click();
            await p2.screenshot({ path: shot("-picker") });
            if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
          }

          // the timeline's other view
          if (name.startsWith("replay")) {
            await timeline.getByRole("button", { name: width === 390 ? "Chart" : "List" }).click();
            if (width === 390) await expect(apm).toHaveCount(2);
            await timeline.screenshot({ path: shot(width === 390 ? "-chart" : "-list") });
            if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
          }
        });
      }
    });
  }
}
