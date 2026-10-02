import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { API, groupCodes, listed, q, rowsOf, search, strip, stripOf } from "./helpers";

// The step editor: the cascading pickers (Trained, Hired, Learned skill, Hero), the and/then link,
// the alternatives, Did not happen and Expanded. Every search compares the page with POST /search.

type Groups = { source: { code: string; name: string }; objects: { code: string; name: string; games: number }[] }[];
async function objects(request: APIRequestContext, kind: string, race: string[]): Promise<Groups> {
  return (await (await request.post(`${API}/objects`, { data: { kind, race } })).json()).groups;
}
const side = (page: Page, name: "Player" | "Opponent") => page.getByRole("region", { name, exact: true });
const picker = (s: Locator) => s.getByRole("group", { name: /^Objects for step/ });
/** Opens the kind menu of the side's last group and picks a kind. */
async function addStep(s: Locator, kind: string) {
  await s.getByRole("button", { name: "Add step" }).last().click();
  await s.getByRole("menuitem", { name: kind, exact: true }).click();
}
/** The names and counts of a list of picker rows, as "Archer 723". */
const optRows = (l: Locator) => l.locator(".opt:has(.opt-count)").evaluateAll((os) => os.map((o) => `${o.querySelector(".opt-name")!.textContent} ${o.querySelector(".opt-count")!.textContent}`));
const fmt = (n: number) => n.toLocaleString("en-US");

test.describe("step editor", () => {
  test("Trained lists the race's units by building, with the games of POST /objects", async ({ page, request }) => {
    const groups = await objects(request, "unit", ["NE"]);
    await page.goto(q({ race: "NE" }));
    const player = side(page, "Player");
    await addStep(player, "Trained");
    const p = picker(player);
    await expect(p.locator(".col-left .opt")).toHaveText(groups.map((g) => g.source.name));
    // only Night Elf buildings: no Mercenary Camp among them
    expect(groups.every((g) => g.source.code.startsWith("e"))).toBeTruthy();
    const aow = groups.find((g) => g.source.code === "eaom")!;
    await p.getByRole("button", { name: "Ancient of War", exact: true }).click();
    expect(await optRows(p.locator(".col-right"))).toEqual(aow.objects.map((o) => `${o.name} ${fmt(o.games)}`));
    await p.getByRole("button", { name: /^Archer/ }).click();
    // a new step goes on to its settings: five Archers by 6:00
    const settings = player.getByRole("group", { name: "Settings of step 1" });
    for (let i = 0; i < 4; i++) await settings.getByRole("button", { name: "More" }).click();
    await settings.getByRole("textbox", { name: "To (m:ss)" }).fill("6:00");
    await settings.getByRole("button", { name: "Done" }).click();
    await expect(player.getByRole("button", { name: "Step 1: Trained Archer ×5" })).toBeVisible();
    await expect(player.locator(".qual")).toHaveText("by 6:00");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/[?&]steps=trained%3Aearc\*5%40-360(&|$)/);
    const want = await search(request, { player: { race: ["NE"], groups: [{ steps: [{ kind: "unit", codes: ["earc"], count: 5, to_s: 360 }] }] } });
    expect(await strip(page)).toEqual(stripOf(want));
    expect(await listed(page)).toEqual(rowsOf(want));
  });

  test("the count takes a typed number, and a game time takes m:ss or seconds", async ({ page, request }) => {
    await page.goto(q({ race: "NE" }));
    const player = side(page, "Player");
    await addStep(player, "Trained");
    const p = picker(player);
    await p.getByRole("button", { name: "Ancient of War", exact: true }).click();
    await p.getByRole("button", { name: /^Archer/ }).click();
    const settings = player.getByRole("group", { name: "Settings of step 1" });
    const count = settings.getByRole("textbox", { name: "At least" });
    await expect(count).toHaveAttribute("inputmode", "numeric");
    // a click selects the count, so a typed digit replaces it; the buttons still step it
    await count.click();
    await page.keyboard.type("4");
    await expect(count).toHaveValue("4");
    await settings.getByRole("button", { name: "More" }).click();
    await expect(count).toHaveValue("5");
    // blank or 0 is 1 again on blur, past 9 is 9
    for (const [typed, shown] of [["", "1"], ["0", "1"], ["12", "9"]]) {
      await count.fill(typed);
      await count.blur();
      await expect(count).toHaveValue(shown);
    }
    await count.fill("5");
    // the format line under the game time, and m:ss in the empty fields
    await expect(settings.getByText("m:ss, such as 2:30, or seconds")).toBeVisible();
    const from = settings.getByRole("textbox", { name: "From (m:ss)" });
    const to = settings.getByRole("textbox", { name: "To (m:ss)" });
    await expect(from).toHaveAttribute("placeholder", "m:ss");
    // seconds and mm:ss read back as m:ss
    await from.fill("150");
    await from.blur();
    await expect(from).toHaveValue("2:30");
    await to.fill("06:00");
    await to.blur();
    await expect(to).toHaveValue("6:00");
    // other text is refused with one line under the fields, and the step keeps its last time
    await to.fill("6 min");
    await to.blur();
    await expect(settings.getByText("Not a time. Type m:ss, such as 2:30, or seconds.")).toBeVisible();
    await expect(to).toHaveAttribute("aria-invalid", "true");
    await to.fill("6:00");
    await expect(settings.getByText("m:ss, such as 2:30, or seconds")).toBeVisible();
    await settings.getByRole("button", { name: "Done" }).click();
    await expect(player.getByRole("button", { name: "Step 1: Trained Archer ×5" })).toBeVisible();
    await expect(player.locator(".qual")).toHaveText("2:30 to 6:00");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/[?&]steps=trained%3Aearc\*5%40150-360(&|$)/);
    const want = await search(request, { player: { race: ["NE"], groups: [{ steps: [{ kind: "unit", codes: ["earc"], count: 5, from_s: 150, to_s: 360 }] }] } });
    expect(await strip(page)).toEqual(stripOf(want));
  });

  test("Hired lists mercenaries by camp, apart from Trained", async ({ page, request }) => {
    const groups = await objects(request, "hired", ["OC"]);
    expect(groups.map((g) => g.source.name).sort()).toEqual(["Goblin Laboratory", "Mercenary Camp"]);
    await page.goto(q({ race: "OC" }));
    const player = side(page, "Player");
    await addStep(player, "Hired");
    const p = picker(player);
    await expect(p.locator(".col-left .opt")).toHaveText(groups.map((g) => g.source.name));
    await p.getByRole("button", { name: "Goblin Laboratory", exact: true }).click();
    const lab = groups.find((g) => g.source.name === "Goblin Laboratory")!;
    expect(await optRows(p.locator(".col-right"))).toEqual(lab.objects.map((o) => `${o.name} ${fmt(o.games)}`));
    await p.getByRole("button", { name: /^Goblin Shredder/ }).click();
    await player.getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Search" }).click();
    const want = await search(request, { player: { race: ["OC"], groups: [{ steps: [{ kind: "unit", codes: ["ngir"] }] }] } });
    expect(await strip(page)).toEqual(stripOf(want));
    // Trained has no mercenary
    await addStep(side(page, "Player"), "Trained");
    await expect(picker(side(page, "Player")).locator(".col-left .opt").first()).toBeVisible();
    await expect(picker(side(page, "Player")).getByRole("button", { name: "Goblin Laboratory", exact: true })).toHaveCount(0);
  });

  test("Learned skill lists skills by hero, and a count is the skill level", async ({ page, request }) => {
    const groups = await objects(request, "skill", ["NE"]);
    await page.goto(q({ race: "NE" }));
    const player = side(page, "Player");
    await addStep(player, "Learned skill");
    const p = picker(player);
    // the race's heroes first, then the Tavern's
    await expect(p.locator(".col-left .opt")).toHaveText(groups.map((g) => g.source.name));
    const names = await p.locator(".col-left .opt").allTextContents();
    expect(names.slice(0, 4).sort()).toEqual(["Demon Hunter", "Keeper of the Grove", "Priestess of the Moon", "Warden"]);
    await p.getByRole("button", { name: "Demon Hunter", exact: true }).click();
    await p.getByRole("button", { name: /^Mana Burn/ }).click();
    const settings = player.getByRole("group", { name: "Settings of step 1" });
    await expect(settings.getByText("Skill level at least")).toBeVisible();
    await settings.getByRole("button", { name: "More" }).click();
    await settings.getByRole("button", { name: "Done" }).click();
    await expect(player.getByRole("button", { name: "Step 1: Learned skill Mana Burn ×2" })).toBeVisible();
    await page.getByRole("button", { name: "Search" }).click();
    const want = await search(request, { player: { race: ["NE"], groups: [{ steps: [{ kind: "skill", codes: ["AEmb"], count: 2 }] }] } });
    expect(await strip(page)).toEqual(stripOf(want));
    expect(await listed(page)).toEqual(rowsOf(want));
  });

  test("a hero step takes the 1st hero, and a group header picks every Tavern hero", async ({ page, request }) => {
    await page.goto(q({ race: "HU" }));
    const player = side(page, "Player");
    await addStep(player, "Hero");
    const p = picker(player);
    await expect(p.getByRole("radio", { name: "1st" })).toBeChecked();
    await p.getByRole("button", { name: "Any from Tavern" }).click();
    await player.getByRole("button", { name: "Done" }).click();
    await expect(player.getByRole("button", { name: "Step 1: 1st hero Any from Tavern" })).toBeVisible();
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/[?&]steps=hero%3A%40ntav%231(&|$)/);
    const tavern = await groupCodes(request, "hero", "ntav");
    expect(tavern.length).toBe(8);
    const want = await search(request, { player: { race: ["HU"], groups: [{ steps: [{ kind: "hero", codes: tavern, nth: 1 }] }] } });
    expect(await strip(page)).toEqual(stripOf(want));
    expect(await listed(page)).toEqual(rowsOf(want));
  });

  test("and finds the steps in any order, then only in order: fewer games", async ({ page, request }) => {
    // a hero is timed by his training order: Wisps ordered before it count for "and", not for "then"
    const steps = [{ kind: "hero", codes: ["Edem"], nth: 1 }, { kind: "unit", codes: ["ewsp"], count: 5, to_s: 360 }];
    const body = (link: "and" | "then") => ({ player: { race: ["NE"], groups: [{ steps: [steps[0], { ...steps[1], link }] }] }, opponent: { race: ["OC"] } });
    const [and, then] = await Promise.all([search(request, body("and")), search(request, body("then"))]);
    expect(then.total).toBeLessThan(and.total);
    await page.goto(q({ race: "NE", steps: "hero:Edem#1,trained:ewsp*5@-360", opponent_race: "OC" }));
    expect(await strip(page)).toEqual(stripOf(and));
    const link = side(page, "Player").getByRole("group", { name: "Link of step 2" });
    await expect(link.getByRole("button", { name: "and" })).toHaveAttribute("aria-pressed", "true");
    await link.getByRole("button", { name: "then" }).click();
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/steps=hero%3AEdem%231%2C%7Etrained%3Aewsp\*5%40-360/);
    expect(await strip(page)).toEqual(stripOf(then));
    expect(await listed(page)).toEqual(rowsOf(then));
  });

  test("an alternative is an or: the side matches when any group holds", async ({ page, request }) => {
    await page.goto(q({ race: "NE" }));
    const player = side(page, "Player");
    await addStep(player, "Hero");
    await picker(player).getByRole("button", { name: /^Keeper of the Grove/ }).click();
    await player.getByRole("button", { name: "Done" }).click();
    await player.getByRole("button", { name: "Add alternative" }).click();
    // the new group's kind menu opens at once
    await player.getByRole("menuitem", { name: "Hero", exact: true }).click();
    await picker(player).getByRole("button", { name: /^Priestess of the Moon/ }).click();
    await player.getByRole("button", { name: "Done" }).click();
    await expect(player.getByRole("group", { name: /^Alternative/ })).toHaveCount(2);
    await expect(player.locator(".or")).toHaveText("or");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/[?&]steps=hero%3AEkee%231%7Chero%3AEmoo%231(&|$)/);
    const one = (code: string) => ({ steps: [{ kind: "hero", codes: [code], nth: 1 }] });
    const [want, keeper, priestess] = await Promise.all([
      search(request, { player: { race: ["NE"], groups: [one("Ekee"), one("Emoo")] } }),
      search(request, { player: { race: ["NE"], groups: [one("Ekee")] } }),
      search(request, { player: { race: ["NE"], groups: [one("Emoo")] } }),
    ]);
    // games, so a mirror with one of each hero first is in both searches and counts once in the or
    const oneOfEach = want.summary.both - keeper.summary.both - priestess.summary.both;
    expect(oneOfEach).toBeGreaterThan(0);
    expect(want.total).toBe(keeper.total + priestess.total - oneOfEach);
    expect(await strip(page)).toEqual(stripOf(want));
    expect(await listed(page)).toEqual(rowsOf(want));
  });

  test("Expanded takes the side's town hall, and Did not happen keeps one-base games", async ({ page, request }) => {
    await page.goto(q({ race: "UD" }));
    const player = side(page, "Player");
    await addStep(player, "Expanded");
    const settings = player.getByRole("group", { name: "Settings of step 1" });
    await settings.getByRole("textbox", { name: "To (m:ss)" }).fill("8:00");
    await settings.getByRole("checkbox", { name: "Did not happen" }).check();
    await settings.getByRole("button", { name: "Done" }).click();
    await expect(player.getByRole("button", { name: "Step 1: Expanded Haunted Gold Mine" })).toBeVisible();
    await expect(player.locator(".qual")).toHaveText(["by 8:00", "Did not happen"]);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/[?&]steps=%21expand%40-480(&|$)/);
    const step = { kind: "building", codes: ["ugol"], to_s: 480 };
    const [want, expanded, mirrors] = await Promise.all([
      search(request, { player: { race: ["UD"], groups: [{ steps: [{ ...step, negate: true }] }] } }),
      search(request, { player: { race: ["UD"], groups: [{ steps: [step] }] } }),
      search(request, { player: { race: ["UD"] }, opponent: { race: ["UD"] } }),
    ]);
    // a mirror where one side expanded is in both searches, so it comes off once
    const oneOfEach = mirrors.total - expanded.summary.both - want.summary.both;
    expect(oneOfEach).toBeGreaterThan(0);
    expect(want.total + expanded.total - oneOfEach).toBe(want.scope.games);
    expect(await strip(page)).toEqual(stripOf(want));
  });

  test("a search keeps its steps over a reload, and the editor reads them back", async ({ page }) => {
    const url = q({ race: "NE,RN", steps: "hero:Edem#1,~90trained:earc*3|!built:eaow", opponent_race: "OC", opp_steps: "hero:@ntav#2" });
    await page.goto(url);
    await page.reload();
    const player = side(page, "Player");
    await expect(player.getByRole("checkbox", { name: "Include Random Night Elf" })).toBeChecked();
    await expect(player.getByRole("button", { name: /^Step \d/ })).toHaveText(["1st heroDemon Hunter", "TrainedArcher ×3", "BuiltAncient of Wind"]);
    await expect(player.getByRole("group", { name: "Link of step 2" }).getByRole("button", { name: "then within 1:30" })).toHaveAttribute("aria-pressed", "true");
    await expect(side(page, "Opponent").getByRole("button", { name: /^Step 1/ })).toHaveText("2nd heroAny from Tavern");
  });

  test("on a phone a picker opens on its groups, then the objects of one", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(q({ race: "NE" }));
    const player = side(page, "Player");
    await addStep(player, "Trained");
    const p = picker(player);
    await expect(p.locator(".col-left")).toBeVisible();
    await expect(p.locator(".col-right")).toBeHidden();
    await p.getByRole("button", { name: "Ancient of War", exact: true }).click();
    await expect(p.locator(".col-left")).toBeHidden();
    // the row that had focus is gone, so the back heading takes it
    await expect(p.getByRole("button", { name: "Ancient of War", exact: true })).toBeFocused();
    await expect(p.getByRole("button", { name: /^Archer/ })).toBeVisible();
    await p.getByRole("button", { name: "Ancient of War", exact: true }).click(); // the back heading
    await expect(p.locator(".col-left")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test("a step the API refuses shows its text, not an outage", async ({ page }) => {
    // a "before" step that names itself
    await page.goto(q({ steps: "trained:earc<1" }));
    await expect(page.locator('p[role="alert"]')).toContainText("before names another step of the group, one that happened");
  });
});
