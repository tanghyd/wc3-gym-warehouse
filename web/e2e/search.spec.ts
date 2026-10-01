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
// the list leaves out games vs Computer unless ?computer=1
const HUMAN = { computer_game: [0] };
type Row = {
  replay_id: string;
  duration_ms: number;
  result_source: string;
  focus_player_id: number;
  players: { player_id: number; name: string; won: boolean | null; heroes: { code: string; final_level: number }[] }[];
};
const search = async (request: APIRequestContext, filters: object): Promise<Row[]> => (await (await request.post(`${API}/search`, { data: { filters } })).json()).replays;
/** The replay ids the list shows, top first. */
const listed = (page: Page) => page.locator('tbody a[href^="/replays/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")!.split("/").pop()));
const playerNames = (page: Page) => page.locator("tbody .font-name").allInnerTexts();
const record = (w: number, l: number) => (w + l ? `${w} – ${l}` + (w + l >= 10 ? ` (${Math.round((100 * w) / (w + l))}%)` : "") : "—");
// the mark of a result from the last actor: the chip, the word, the reason in the title
const INFERRED = 'span[title^="Inferred:"]';
const WON_REASON = "Inferred: the other player stopped first; the file has no leave record";
const LOST_REASON = "Inferred: this player stopped first; the file has no leave record";
const NAME = "thanks#11187";
// Two games each saved twice, as the client's Autosaved copy and the w3c- copy; the w3c- copy stands for the game.
const TWICE = [
  { autosaved: "9e30a4fa55f9af3f026018d34c35f7c0550a8565bbcff4def0295dcfc5a5be54", w3c: "1e466fc0bb5010f687d9f7829129645933e2d92eb83ba932d8af6b31adaee5c5" },
  { autosaved: "9d0cb24dd6b7bda538c78872ea9cfc06a0cb1435a9b1c1d355d1ab1ccd22ea4a", w3c: "d71dd61bf62edf3c0327f81310516d3e9e4c075afa087105920fdb1dbdcca3f6" },
];

test.describe("replay list", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("lists every game but those vs Computer, the three goldens among them", async ({ page, request }) => {
    const all = (await search(request, HUMAN)).length;
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Replays");
    await expect(rows(page)).toHaveCount(all);
    await expect(goldens(page)).toHaveCount(3);
    expect(await playerNames(page)).not.toContain("Computer");
  });

  test("games vs Computer stay out until the checkbox lets them in, and a reload keeps it", async ({ page, request }) => {
    const [human, all] = await Promise.all([search(request, HUMAN), search(request, {})]);
    // the stack holds games vs Computer
    expect(all.length).toBeGreaterThan(human.length);
    const box = page.getByRole("checkbox", { name: "Include games vs Computer" });
    await expect(box).not.toBeChecked();
    await expect(rows(page)).toHaveCount(human.length);
    expect(await listed(page)).toEqual(human.map((r) => r.replay_id));

    await box.check();
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/[?&]computer=1(&|$)/);
    await expect(rows(page)).toHaveCount(all.length);
    expect(await listed(page)).toEqual(all.map((r) => r.replay_id));
    expect(await playerNames(page)).toContain("Computer");
    await expect(page.locator(".bar .chip")).toHaveText(String(all.length));

    await page.reload();
    await expect(box).toBeChecked();
    await expect(rows(page)).toHaveCount(all.length);

    await box.uncheck();
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).not.toHaveURL(/[?&]computer=/);
    await expect(rows(page)).toHaveCount(human.length);
    expect(await playerNames(page)).not.toContain("Computer");
  });

  test("each player's heroes sit under his name in pick order, as the API row has them", async ({ page, request }) => {
    const replays = await search(request, HUMAN);
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
    const hill = goldens(page).filter({ hasText: "Concealed Hill" });
    const heroes = (player: string) => hill.getByRole("listitem").filter({ hasText: player }).getByRole("list", { name: "Heroes" }).getByRole("img");
    const named = async (player: string) => (await heroes(player).evaluateAll((es) => es.map((e) => e.getAttribute("alt") ?? e.getAttribute("aria-label")))).map((l) => l!.split(",")[0]);
    expect(await named("thanks#11187")).toEqual(["Demon Hunter", "Keeper of the Grove"]);
    expect(await named("Okeanos#22605")).toEqual(["Far Seer", "Shadow Hunter", "Tauren Chieftain"]);
    expect(await heroes("thanks#11187").first().evaluate((e) => e.getBoundingClientRect().width)).toBe(20);
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
    const all = await search(request, HUMAN);
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

  test("a result from the last actor reads as inferred on the rows the API marks last_actor", async ({ page, request }) => {
    const replays = await search(request, HUMAN);
    const want = replays.filter((r) => r.result_source === "last_actor").map((r) => r.replay_id);
    expect(want.length).toBeGreaterThan(0);
    await expect(rows(page)).toHaveCount(replays.length);
    const got = await rows(page).evaluateAll(
      (trs, sel) => trs.filter((tr) => tr.querySelector(sel)).map((tr) => tr.querySelector('a[href^="/replays/"]')!.getAttribute("href")!.split("/").pop()),
      INFERRED,
    );
    expect(got).toEqual(want);
    // with no focus only the winner wears a chip: Won, then the word
    const mark = rows(page).filter({ has: page.locator(`a[href="/replays/${want[0]}"]`) }).locator(INFERRED);
    await expect(mark).toHaveCount(1);
    await expect(mark).toHaveText("Won inferred");
    await expect(mark.locator(".chip")).toHaveText("Won");
    await expect(mark).toHaveAttribute("title", WON_REASON);
  });

  test(`${NAME} as player 1: each game once, the inferred results marked, the record as the API's`, async ({ page, request }) => {
    const replays = await search(request, { ...HUMAN, player: [NAME] });
    await page.goto(`/?player=${encodeURIComponent(NAME)}`);
    await expect(rows(page)).toHaveCount(replays.length);
    expect(await listed(page)).toEqual(replays.map((r) => r.replay_id));
    // a game saved twice lists once, through its w3c- copy; the other copy keeps its own page
    for (const { autosaved, w3c } of TWICE) {
      expect(replays.map((r) => r.replay_id)).toContain(w3c);
      expect(replays.map((r) => r.replay_id)).not.toContain(autosaved);
      expect((await request.get(`${API}/replays/${autosaved}`)).status()).toBe(200);
    }
    // the Player 1 column: his chip and whether it is inferred
    const focus = replays.map((r) => ({ won: r.players.find((p) => p.player_id === r.focus_player_id)!.won, inferred: r.result_source === "last_actor" }));
    expect(focus.filter((f) => f.inferred && f.won === false).length).toBeGreaterThan(0);
    const got = await rows(page).evaluateAll(
      (trs, sel) => trs.map((tr) => [(tr as HTMLTableRowElement).cells[4].querySelector(".chip")?.textContent ?? null, !!(tr as HTMLTableRowElement).cells[4].querySelector(sel)]),
      INFERRED,
    );
    expect(got).toEqual(focus.map((f) => [f.won === null ? null : f.won ? "Won" : "Lost", f.inferred]));
    const lost = rows(page).locator(`td:nth-child(5) ${INFERRED}`).filter({ hasText: "Lost" }).first();
    await expect(lost).toHaveAttribute("title", LOST_REASON);
    const [w, l] = [focus.filter((f) => f.won === true).length, focus.filter((f) => f.won === false).length];
    await expect(page.locator(".bar").filter({ hasText: "Games" })).toContainText(`Player 1 record ${record(w, l)}`);
  });

  test("the patch filter keeps that patch's games, as the API counts them", async ({ page, request }) => {
    const [p2, p3] = await Promise.all([search(request, { ...HUMAN, patch: ["2.0"] }), search(request, { ...HUMAN, patch: ["3.0"] })]);
    expect(p3.length).toBeGreaterThan(0);
    const patch = page.getByRole("combobox", { name: "Patch" });
    await expect(patch).toHaveValue("");
    const res = await request.post(`${API}/query`, { data: { dimensions: ["patch"], measures: ["games"], order_by: ["patch"] } });
    const values = (await res.json()).rows.map((r: { patch: string }) => r.patch).filter(Boolean);
    await expect(patch.locator("option")).toHaveText(["Any", ...values]);

    await patch.selectOption("3.0");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/[?&]patch=3\.0(&|$)/);
    await expect(rows(page)).toHaveCount(p3.length);
    expect(await listed(page)).toEqual(p3.map((r) => r.replay_id));
    await expect(goldens(page)).toHaveCount(0);
    // a patch names no player, so no Player 1 column
    await expect(page.getByRole("columnheader", { name: "Player 1" })).toHaveCount(0);

    await patch.selectOption("2.0");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/[?&]patch=2\.0(&|$)/);
    await expect(rows(page)).toHaveCount(p2.length);
    await expect(goldens(page)).toHaveCount(3);
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
