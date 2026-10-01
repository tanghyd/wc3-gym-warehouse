import path from "node:path";
import { expect, test } from "@playwright/test";

// Full-page screenshots for a look in both themes, written to shots/ (gitignored).
const PAGES = [
  ["search", "/"],
  // the spec's example: Demon Hunter first and 5 Archers by 6:00, against a Blademaster-first Orc
  ["search-build", `/?race=NE&steps=${encodeURIComponent("hero:Edem#1,trained:earc*5@-360")}&opponent_race=OC&opp_steps=${encodeURIComponent("hero:Obla#1")}`],
  // two alternatives, a then step within 1:30, one base by 8:00, and an Openers path on a Random Undead
  ["search-groups", `/?race=UD,RU&steps=${encodeURIComponent("hero:Udea#1,~90trained:ugho*6|hero:Ulic#1,!expand@-480")}&opened=usep.uaod&result=won`],
  // the Night Elf tree, open down to the sixth building
  ["openers", "/openers?race=NE&open=eate&open=eate.eaom&open=eate.eaom.eden&open=eate.eaom.eden.etoa&open=eate.eaom.eden.etoa.edob"],
  // the Undead tree by best win rate, open down to a Slaughterhouse sixth
  ["openers-undead", "/openers?race=UD&sort=winrate&open=usep&open=usep.uaod&open=usep.uaod.ugrv&open=usep.uaod.ugrv.utom&open=usep.uaod.ugrv.utom.unp1"],
  // Concealed Hill, 15:37, NE v OC: the story 4 golden
  ["replay", "/replays/dcd39e47097a4a010bc4006e0bf521e3726a0b8e9284cc0b8e2fb74411fbfef8"],
  // Springtime 1.4, 49 minutes, HU v UD: the longest game
  ["replay-long", "/replays/d43bf84a43237df9ac301e8a3a883371d8068da2dabf2f76cdaa4993ccf5ffd4"],
  // Tidehunters 1.2, 22 minutes, HU v NE
  ["replay-tidehunters", "/replays/8981073e8fb05086fc0c15dc89ecdcef945bf0c5e980246ffe5bbbf2980661f8"],
  // Fading Autumn 1.3, 31 minutes, HU v UD: a hero with no code
  ["replay-autumn", "/replays/02f31fadbf6319d381151aa63f1e99a3d828c51056b0161b2cfecbbaa338f4ce"],
  ["missing", "/replays/nope"],
  // Tidehunters 1.2 opened from the spec's example search: the matched steps marked
  [
    "replay-marks",
    `/replays/469e056472066120cc131b00856fdc1da9f060292babf9e1bd4a068d0ac0555a?${new URLSearchParams({
      q: new URLSearchParams({ race: "NE", steps: "hero:Edem#1,trained:earc*5@-360", opponent_race: "OC", opp_steps: "hero:Obla#1" }).toString(),
      side: "SSMaiev#2726",
    })}`,
  ],
  // the mockup's view: first hero by opponent race for Night Elf, a heat map
  ["explore", "/explore?rows=first_hero&cols=opponent_race&race=NE"],
  // games by map, bars
  ["explore-bars", "/explore?show=games,record&rows=map"],
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

          // the pickers on the Player's next step: Trained, Hired, Learned skill and Hero, then a step's settings
          if (name === "search-build") {
            const player = page.getByRole("region", { name: "Player", exact: true });
            for (const kind of ["Trained", "Hired", "Learned skill", "Hero"]) {
              await player.getByRole("button", { name: "Add step" }).last().click();
              await player.getByRole("menuitem", { name: kind, exact: true }).click();
              const picker = player.getByRole("group", { name: /^Objects for step/ });
              await picker.locator(".opt").first().waitFor();
              if (kind !== "Hero") await picker.locator(".col-left .opt").nth(1).click();
              await player.screenshot({ path: shot(`-picker-${kind.toLowerCase().replace(" ", "-")}`) });
              if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
              await picker.getByRole("searchbox", { name: "Find by name" }).press("Escape");
            }
            await player.getByRole("button", { name: /^Step 2: Trained Archer/ }).click();
            await player.screenshot({ path: shot("-settings") });
            await player.getByRole("button", { name: "Race: Night Elf" }).click();
            await player.getByRole("menuitem", { name: /^Random/ }).click();
            await page.screenshot({ path: shot("-races"), clip: { x: 0, y: 0, width, height: Math.round(page.viewportSize()!.height * 1.2) } });
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
