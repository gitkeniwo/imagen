import { defineConfig, devices } from "@playwright/test";

const CI = !!process.env.CI;

// Each worker runs its own fake backend on 47920 + parallelIndex, so the
// worker count also bounds the port range (47920-47927).
const WORKERS = Number(process.env.IMAGEN_E2E_WORKERS || (CI ? 3 : 4));

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  timeout: 45_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: Math.min(WORKERS, 8),
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  outputDir: "test-results",
  use: {
    locale: "en-US",
    timezoneId: "Europe/Amsterdam",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /mobile\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "webkit",
      testIgnore: /mobile\.spec\.ts/,
      use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } },
    },
    {
      // Chromium so long-press can be driven with real touch events (CDP).
      name: "mobile",
      testMatch: /mobile\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 375, height: 812 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
