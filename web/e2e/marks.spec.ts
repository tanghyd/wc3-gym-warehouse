import { expect, test } from "@playwright/test";
import { API, q, search } from "./helpers";

// A game opened from a search marks the orders each step matched, on the chart and in the list.
// The spec's example: Demon Hunter first and 5 Archers by 6:00, against a Blademaster-first Orc.
const STEPS = "hero:Edem#1,trained:earc*5@-360";
const SEARCH = { race: "NE", steps: STEPS, opponent_race: "OC", opp_steps: "hero:Obla#1" };
const BODY = {
  player: { race: ["NE"], groups: [{ steps: [{ kind: "hero", codes: ["Edem"], nth: 1 }, { kind: "unit", codes: ["earc"], count: 5, to_s: 360 }] }] },
  opponent: { race: ["OC"], groups: [{ steps: [{ kind: "hero", codes: ["Obla"], nth: 1 }] }] },
};
type Event = { player_id: number; time_ms: number; event_type: string; code: string };
type Replay = { players: { player_id: number; name: string; team_id: number }[]; events: Event[] };
const mss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

test.describe("step marks", () => {
  test("a game opened from a search marks each step's orders with its number", async ({ page, request }) => {
    const answer = await search(request, BODY);
    const row = answer.replays[0];
    const r: Replay = await (await request.get(`${API}/replays/${row.replay_id}`)).json();
    const me = r.players.find((p) => p.name === row.player.name)!;
    const other = r.players.find((p) => p.team_id !== me.team_id)!;
    const mine = r.events.filter((e) => e.player_id === me.player_id);
    // step 1: the Demon Hunter's arrival; step 2: the first five Archer orders by 6:00
    const dh = mine.find((e) => e.event_type === "hero_trained" && e.code === "Edem")!;
    const archers = mine.filter((e) => e.event_type === "unit" && e.code === "earc" && e.time_ms <= 360000).slice(0, 5);
    const bm = r.events.find((e) => e.player_id === other.player_id && e.event_type === "hero_trained" && e.code === "Obla")!;

    await page.goto(q(SEARCH));
    await page.locator("table.games tbody tr").first().getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/replays/${row.replay_id}\\?q=.+&side=`));

    const player = page.getByRole("list", { name: "Steps of the player" });
    await expect(player.getByRole("listitem")).toHaveText([`11st hero Demon Hunter${mss(dh.time_ms)}`, `2Trained Archer ×5 by 6:00${mss(archers[0].time_ms)} to ${mss(archers[4].time_ms)}`]);
    await expect(page.getByRole("list", { name: "Steps of the opponent" }).getByRole("listitem")).toHaveText([`11st hero Blademaster${mss(bm.time_ms)}`]);

    // on the chart, the marks holding those orders carry the step number
    const lanes = page.getByRole("group", { name: `Orders of ${me.name}` });
    await expect(lanes.getByRole("img", { name: /Step 1 of the search$/ })).toHaveCount(1);
    expect(await lanes.getByRole("img", { name: /Step 2 of the search$/ }).count()).toBeGreaterThanOrEqual(1);
    await expect(page.getByRole("group", { name: `Orders of ${other.name}` }).getByRole("img", { name: /Step 1 of the search$/ })).toHaveCount(1);

    // the list view too, and turning a kind off keeps the search in the URL
    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(page.getByRole("list", { name: `Orders of ${me.name}` }).locator(".step-no")).not.toHaveCount(0);
    await page.getByRole("button", { name: "Items", exact: true }).click();
    await expect(page).toHaveURL(/[?&]q=.+&side=.+&kinds=/);

    await page.getByRole("link", { name: "Back to the search" }).click();
    await expect(page).toHaveURL(/\/\?race=NE&steps=/);
  });

  test("a game opened without steps has no marks", async ({ page, request }) => {
    const answer = await search(request, { player: { race: ["NE"] } });
    await page.goto(q({ race: "NE" }));
    await expect(page.locator("table.games tbody tr").first().getByRole("link")).toHaveAttribute("href", `/replays/${answer.replays[0].replay_id}`);
    await page.goto(`/replays/${answer.replays[0].replay_id}`);
    await expect(page.locator(".step-no")).toHaveCount(0);
  });
});
