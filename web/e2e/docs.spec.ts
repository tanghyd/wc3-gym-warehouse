import path from "node:path";
import { expect, test } from "@playwright/test";

// dbt's docs site (`just local::docs`): a React app that reads info_schema/v1/*.parquet through DuckDB-WASM.
const DOCS = process.env.DOCS_URL ?? "http://docs";

test("dbt docs list the warehouse models", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(DOCS);
  // the tree counts come from the parquet files, so a count proves the data loaded
  const models = page.getByRole("button", { name: "Models 12" });
  await expect(models).toBeVisible({ timeout: 30_000 });
  await models.click();
  for (const model of ["player_games", "replay_events", "raw_replays"])
    await expect(page.getByText(model, { exact: true }).first()).toBeVisible();
  await page.getByText("player_games", { exact: true }).first().click();
  await expect(page.getByText("One row per player per 1v1 replay.").first()).toBeVisible();
  await page.screenshot({ path: path.join(__dirname, "shots", "dbt-docs.png"), fullPage: true });
});
