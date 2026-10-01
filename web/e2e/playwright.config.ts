import { defineConfig, devices } from "@playwright/test";

// The e2e compose service runs this on the compose network, against the inspector at web:3000.
export default defineConfig({
  testDir: ".",
  outputDir: "test-results",
  workers: 2,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.WEB_URL ?? "http://web:3000",
    screenshot: "only-on-failure",
    // Headless hinting rounds Alegreya Sans word spaces to near zero; a desktop browser does not.
    launchOptions: { args: ["--font-render-hinting=none"] },
  },
});
