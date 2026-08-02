import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  use: {
    browserName: "chromium",
    channel: "chromium",
    headless: true,
  },
});
