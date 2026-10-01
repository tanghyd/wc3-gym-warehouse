import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// The build-order search on /: each list equals POST /search's answer to the same request.
const API = process.env.API_URL ?? "http://api:8000";

type Row = { replay_id: string; gnl: unknown; focus_player_id: number; players: { player_id: number; name: string; won: boolean | null }[] };
const rows = (page: Page) => page.locator("tbody tr");
const goldens = (page: Page) => rows(page).filter({ hasText: /\bS900[123] G\d/ });
const slot = (page: Page, n: number) => page.getByRole("region", { name: `Player ${n}` });
const steps = (card: Locator) => card.locator("ol > li");
/** The replay ids the list shows, in order. */
const shown = (page: Page) => rows(page).locator('a[href^="/replays/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")!.split("/").pop()));
const record = (w: number, l: number) => (w + l ? `${w} – ${l}` + (w + l >= 10 ? ` (${Math.round((100 * w) / (w + l))}%)` : "") : "—");

async function search(request: APIRequestContext, body: object): Promise<Row[]> {
  const res = await request.post(`${API}/search`, { data: body });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).replays;
}
// The page lists the first 100 games by id, as POST /search does by default; counts take the API's cap.
const PAGE = 100;
const every = (request: APIRequestContext, body: object) => search(request, { ...body, limit: 1000 });

/** Adds a step: its order kind, then the object found by name in the picker. */
async function addStep(card: Locator, kind: string, name: string) {
  await card.getByRole("button", { name: "Add step" }).click();
  const step = steps(card).last();
  await step.getByRole("combobox", { name: /^Step \d+ order$/ }).selectOption({ label: kind });
  const picker = step.getByRole("group", { name: /^Objects for step \d+$/ });
  await picker.getByRole("searchbox", { name: "Find by name" }).fill(name);
  await picker.getByRole("button", { name, exact: true }).click();
  await expect(picker).toBeHidden();
  return step;
}

/** The two-step Night Elf build: Altar of Elders by 2:00, then Ancient of War within 20 s. */
async function nightElfBuild(page: Page) {
  const p1 = slot(page, 1);
  await p1.getByRole("combobox", { name: "Race", exact: true }).selectOption({ label: "Night Elf" });
  const altar = await addStep(p1, "Built", "Altar of Elders");
  await altar.getByRole("button", { name: "Timing for step 1" }).click();
  await expect(altar.getByRole("spinbutton", { name: "Within previous (s)" })).toBeDisabled();
  await altar.getByRole("textbox", { name: "Not after (m:ss)" }).fill("2:00");
  await expect(altar.getByText("ordered by 2:00")).toBeVisible();
  const war = await addStep(p1, "Built", "Ancient of War");
  await war.getByRole("button", { name: "Timing for step 2" }).click();
  await war.getByRole("spinbutton", { name: "Within previous (s)" }).fill("20");
  await expect(war.getByText("ordered within 20 s of step 1")).toBeVisible();
}
const NE_BUILD = {
  filters: { race: ["NE"] },
  steps: [
    { type: "building", code: "eate", to_min: 2 },
    { type: "building", code: "eaom", within_prev_s: 20 },
  ],
};

test.describe("build-order search", () => {
  test("a two-step build with timing lists the games POST /search answers", async ({ page, request }) => {
    await page.goto("/");
    await nightElfBuild(page);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("steps")).toBe("eate@-120,eaom~20");

    const want = await search(request, NE_BUILD);
    const [found, all] = await Promise.all([every(request, NE_BUILD), every(request, { filters: { race: ["NE"] } })]);
    // the timing narrows: fewer games than the race alone, the three goldens kept
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThan(all.length);
    expect(found.filter((r) => r.gnl)).toHaveLength(3);
    await expect(rows(page)).toHaveCount(want.length);
    expect(await shown(page)).toEqual(want.map((r) => r.replay_id));
    await expect(goldens(page)).toHaveCount(want.filter((r) => r.gnl).length);
    await expect(page.locator(".bar .chip")).toHaveText(found.length > PAGE ? `${PAGE}+` : String(found.length));

    // the Player 1 column reports the focus player, who is listed first
    const focus = want.map((r) => r.players.find((p) => p.player_id === r.focus_player_id)!);
    expect(await rows(page).locator("td:nth-child(5)").allInnerTexts()).toEqual(focus.map((p) => (p.won === null ? "" : p.won ? "Won" : "Lost")));
    expect(await rows(page).locator("td:nth-child(4) li:first-child .font-name").allInnerTexts()).toEqual(focus.map((p) => p.name));
    // and his record over the list sits beside the count
    const [w, l] = [focus.filter((p) => p.won === true).length, focus.filter((p) => p.won === false).length];
    await expect(page.locator(".bar").filter({ hasText: "Games" })).toContainText(`Player 1 record ${record(w, l)}`);

    // the request's SQL sits behind a disclosure
    await page.getByText("Show SQL").click();
    await expect(page.locator("details pre")).toContainText("sequenceMatch('(?1)(?t<=20000)(?2)')");
  });

  test("the picker lists only the objects of the step's kind that fit the race", async ({ page, request }) => {
    const res = await request.post(`${API}/query`, { data: { model: "mappings", dimensions: ["code", "name", "kind"], limit: 10000 } });
    const mappings: { code: string; name: string; kind: string }[] = (await res.json()).rows;
    // Orc: a building or hero code leads with o, an upgrade has o after R; h, e and u belong to the other races
    const fitting = (kind: string, at: number) =>
      mappings
        .filter((m) => m.kind === kind && m.name && !"heu".includes(m.code[at].toLowerCase()))
        .map((m) => m.code)
        .sort();

    await page.goto("/?race=OC");
    const p1 = slot(page, 1);
    await p1.getByRole("button", { name: "Add step" }).click();
    const step = steps(p1).first();
    const picker = step.getByRole("group", { name: "Objects for step 1" });
    const codes = async () => (await picker.getByRole("button").evaluateAll((bs) => bs.map((b) => (b as HTMLButtonElement).value))).sort();
    for (const [kind, label, at] of [
      ["building", "Built", 0],
      ["upgrade", "Researched", 1],
      ["hero", "Got hero", 0],
    ] as const) {
      await step.getByRole("combobox", { name: "Step 1 order" }).selectOption({ label });
      const want = fitting(kind, at);
      expect(want.length).toBeGreaterThan(3);
      await expect.poll(codes, { message: label }).toEqual(want);
    }
    await expect(picker.getByRole("button", { name: "Blademaster", exact: true })).toBeVisible();
    await expect(picker.getByRole("button", { name: "Archmage", exact: true })).toHaveCount(0);

    // the search field narrows by name, and Enter picks the first match
    await step.getByRole("combobox", { name: "Step 1 order" }).selectOption({ label: "Built" });
    await picker.getByRole("searchbox", { name: "Find by name" }).fill("war m");
    await expect(picker.getByRole("button")).toHaveText(["War Mill"]);
    await picker.getByRole("searchbox", { name: "Find by name" }).press("Enter");
    await expect(step.getByRole("button", { name: "Step 1: War Mill" })).toBeFocused();
  });

  test("a skill fits its hero's race, and War Drums only the Orc", async ({ page }) => {
    /** The codes the picker lists for one race and order kind. */
    const codes = async (race: string, kind: string) => {
      await page.goto(`/?race=${race}`);
      const p1 = slot(page, 1);
      await p1.getByRole("button", { name: "Add step" }).click();
      const step = steps(p1).first();
      await step.getByRole("combobox", { name: "Step 1 order" }).selectOption({ label: kind });
      const buttons = step.getByRole("group", { name: "Objects for step 1" }).getByRole("button");
      await expect(buttons.first()).toBeVisible();
      return buttons.evaluateAll((bs) => bs.map((b) => (b as HTMLButtonElement).value));
    };
    // Searing Arrows (AHfa) is the Priestess of the Moon's; War Drums Damage Increase (Rwdm) is Orc
    expect(await codes("NE", "Used skill")).toContain("AHfa");
    expect(await codes("HU", "Used skill")).not.toContain("AHfa");
    expect(await codes("HU", "Researched")).not.toContain("Rwdm");
    expect(await codes("NE", "Researched")).not.toContain("Rwdm");
    expect(await codes("OC", "Researched")).toContain("Rwdm");
  });

  test("a search keeps its state over a reload", async ({ page }) => {
    await page.goto("/");
    await nightElfBuild(page);
    await slot(page, 1).getByText("Won", { exact: true }).click();
    const p2 = slot(page, 2);
    await p2.getByRole("combobox", { name: "Opponent race" }).selectOption({ label: "Orc" });
    await addStep(p2, "Built", "War Mill");
    // a third step moves up, and back down
    await addStep(slot(page, 1), "Got hero", "Demon Hunter");
    await slot(page, 1).getByRole("button", { name: "Move step 3 up" }).click();
    await expect(steps(slot(page, 1)).getByRole("button", { name: /^Step \d+: / })).toHaveText(["Altar of Elders", "Demon Hunter", "Ancient of War"]);
    await expect(slot(page, 1).getByRole("button", { name: "Move step 2 up" })).toBeFocused();
    await slot(page, 1).getByRole("button", { name: "Move step 2 down" }).click();
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("steps")).toBe("eate@-120,eaom~20,Edem");
    const before = await shown(page);
    expect(before.length).toBeGreaterThan(0);

    await page.reload();
    const p1 = slot(page, 1);
    await expect(p1.getByRole("combobox", { name: "Race", exact: true })).toHaveValue("NE");
    await expect(p1.getByRole("radio", { name: "Won" })).toBeChecked();
    await expect(steps(p1).getByRole("button", { name: /^Step \d+: / })).toHaveText(["Altar of Elders", "Ancient of War", "Demon Hunter"]);
    await expect(steps(p1).nth(0)).toContainText("ordered by 2:00");
    await expect(steps(p1).nth(1)).toContainText("ordered within 20 s of step 1");
    await steps(p1).nth(0).getByRole("button", { name: "Timing for step 1" }).click();
    await expect(steps(p1).nth(0).getByRole("textbox", { name: "Not after (m:ss)" })).toHaveValue("2:00");
    await expect(p2.getByRole("combobox", { name: "Opponent race" })).toHaveValue("OC");
    await expect(p2.getByRole("radio", { name: "Any" })).toBeChecked();
    await expect(steps(p2).getByRole("button", { name: "Step 1: War Mill" })).toBeVisible();
    expect(await shown(page)).toEqual(before);
  });

  test("a second player narrows the games to what POST /search answers", async ({ page, request }) => {
    await page.goto(`/?race=NE&steps=eate`);
    const p1Only = await search(request, { filters: { race: ["NE"] }, steps: [{ type: "building", code: "eate" }] });
    await expect(rows(page)).toHaveCount(p1Only.length);

    const p2 = slot(page, 2);
    await p2.getByRole("combobox", { name: "Opponent race" }).selectOption({ label: "Orc" });
    await addStep(p2, "Got hero", "Blademaster");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/[?&]opp_steps=Obla(&|$)/);
    // Player 2 is the focus's opponent: each side names the other's race
    const body = {
      filters: { race: ["NE"], opponent_race: ["OC"] },
      steps: [{ type: "building", code: "eate" }],
      others: [{ filters: { race: ["OC"], opponent_race: ["NE"] }, steps: [{ type: "hero_trained", code: "Obla" }] }],
    };
    const want = await search(request, body);
    // the Blademaster step narrows more than the opponent race alone
    const [found, raceOnly, p1All] = await Promise.all([
      every(request, body),
      every(request, { filters: { race: ["NE"], opponent_race: ["OC"] }, steps: [{ type: "building", code: "eate" }] }),
      every(request, { filters: { race: ["NE"] }, steps: [{ type: "building", code: "eate" }] }),
    ]);
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThan(raceOnly.length);
    expect(raceOnly.length).toBeLessThan(p1All.length);
    await expect(rows(page)).toHaveCount(want.length);
    expect(await shown(page)).toEqual(want.map((r) => r.replay_id));
    // every listed game holds a Blademaster on the Orc side
    for (const id of (await shown(page)).slice(0, 3)) {
      const r = await (await request.get(`${API}/replays/${id}`)).json();
      expect(r.events.some((e: { event_type: string; code: string }) => e.event_type === "hero_trained" && e.code === "Obla"), id).toBeTruthy();
    }
  });

  test("Player 2's outcome is his own, never Player 1's", async ({ page, request }) => {
    await page.goto("/?opp_result=won");
    // every game with a known winner, its loser listed as Player 1
    const res = await request.post(`${API}/query`, { data: { measures: ["replays"], filters: { result: ["win"] } } });
    const decided: number = (await res.json()).rows[0].replays;
    expect(decided).toBeGreaterThan(0);
    await expect(rows(page)).toHaveCount(Math.min(decided, PAGE));
    expect(new Set(await rows(page).locator("td:nth-child(5)").allInnerTexts())).toEqual(new Set(["Lost"]));
    // two winners in one game: none
    await page.goto("/?result=won&opp_result=won");
    await expect(page.getByText("No replay matches. Widen the filters.")).toBeVisible();
  });

  test("Player 2's steps are his own, never Player 1's", async ({ page, request }) => {
    await page.goto("/?opp_steps=Edem");
    // every game where someone trained a Demon Hunter
    const res = await request.post(`${API}/query`, { data: { measures: ["replays"], steps: [{ type: "hero_trained", code: "Edem" }] } });
    const ids = await shown(page);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBe(Math.min((await res.json()).rows[0].replays, PAGE));
    // and the player listed second, Player 1's opponent, is one who did
    const second = await rows(page).locator("td:nth-child(4) li:nth-child(2) .font-name").allInnerTexts();
    for (const [i, id] of ids.entries()) {
      const r = await (await request.get(`${API}/replays/${id}`)).json();
      const p2 = r.players.find((p: { name: string }) => p.name === second[i]);
      expect(r.events.some((e: { player_id: number; event_type: string; code: string }) => e.player_id === p2.player_id && e.event_type === "hero_trained" && e.code === "Edem"), id).toBeTruthy();
    }
  });

  test("a value past the API's bounds shows the API's text, not an outage", async ({ page }) => {
    await page.goto("/?steps=eate@36001-");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Replays");
    await expect(page.getByText("The API refused this search: steps.0.from_min")).toBeVisible();
    await page.goto("/?steps=eate~9999,eaom~9999");
    await expect(page.getByText("The API refused this search: steps.0.within_prev_s")).toBeVisible();
    // the form reads the bad gap as blank, so a new search runs
    await expect(steps(slot(page, 1)).nth(1)).not.toContainText("ordered");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("steps")).toBe("eate,eaom");
    await expect(rows(page).first()).toBeVisible();
  });

  test("an empty search says what to widen", async ({ page }) => {
    await page.goto("/?race=UD&steps=eate");
    await expect(page.getByText("No replay matches. Drop a step or widen the filters.")).toBeVisible();
  });
});
