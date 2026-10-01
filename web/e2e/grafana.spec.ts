import path from "node:path";
import { expect, test } from "@playwright/test";

// The provisioned Grafana dashboards: every panel query returns rows, and every panel renders.
// Needs a `just dbt build` in the last 7 days. It makes its own API traffic, and a query may wait one
// system.query_log flush (7.5 s) before its rows show.
const GRAFANA = process.env.GRAFANA_URL ?? "http://grafana:3000";
const API = process.env.API_URL ?? "http://api:8000";
const DASHBOARDS = [
  ["server", "clickhouse-server"],
  ["api", "query-api"],
  ["data", "warehouse-data"],
] as const;

type Target = { refId: string; rawSql: string };
type Panel = { title: string; interval?: string; targets: Target[] };

const UNIT_MS: Record<string, number> = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 };
// "now-6h" or "1m" in milliseconds
const ms = (span: string) => {
  const [, n, unit] = span.match(/(\d+)([smhd])$/)!;
  return Number(n) * UNIT_MS[unit];
};

// One tall viewport holds every panel, so none waits for a scroll to load.
test.use({ viewport: { width: 1600, height: 1400 } });

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext();
  expect((await api.post(`${API}/query`, { data: { measures: ["games"] } })).ok()).toBe(true);
  await api.dispose();
});

for (const [name, uid] of DASHBOARDS) {
  test.describe(`grafana ${name}`, () => {
    test("every panel query returns rows", async ({ request }) => {
      const { dashboard } = await (await request.get(`${GRAFANA}/api/dashboards/uid/${uid}`)).json();
      const range = ms(dashboard.time.from);
      for (const panel of dashboard.panels as Panel[]) {
        for (const target of panel.targets) {
          const intervalMs = Math.max(panel.interval ? ms(panel.interval) : 1000, Math.round(range / 1000));
          let error: string | undefined;
          let rows = 0;
          // -1 while the query errors, so an error fails the poll as well as no rows
          await expect.poll(async () => {
            const res = await request.post(`${GRAFANA}/api/ds/query`, {
              data: { from: dashboard.time.from, to: dashboard.time.to, queries: [{ ...target, intervalMs, maxDataPoints: 1000 }] },
            });
            const result = (await res.json()).results[target.refId];
            error = result.error;
            rows = (result.frames ?? []).reduce((sum: number, f: { data: { values: unknown[][] } }) => sum + (f.data.values[0]?.length ?? 0), 0);
            return error ? -1 : rows;
          }, { message: `${panel.title} ${target.refId}`, timeout: 20_000 }).toBeGreaterThan(0);
          console.log(`${uid} | ${panel.title} | ${target.refId} | ${error ?? "ok"} | ${rows} rows`);
        }
      }
    });

    test("every panel renders", async ({ page }) => {
      await page.goto(`${GRAFANA}/d/${uid}?orgId=1&kiosk`);
      const { dashboard } = await (await page.request.get(`${GRAFANA}/api/dashboards/uid/${uid}`)).json();
      for (const panel of dashboard.panels as Panel[])
        await expect(page.getByTestId(`data-testid Panel header ${panel.title}`)).toBeVisible();
      await expect(page.getByLabel("Panel loading bar")).toHaveCount(0);
      await page.waitForLoadState("networkidle");
      await expect(page.getByText("No data", { exact: true })).toHaveCount(0);
      await expect(page.getByTestId("data-testid Panel status error")).toHaveCount(0);
      await page.screenshot({ path: path.join(__dirname, "shots", `grafana-${name}.png`), fullPage: true });
    });
  });
}
