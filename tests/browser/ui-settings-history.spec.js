import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, expect, test } from "@playwright/test";

import { createApp } from "../../server/src/app.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let context;
let worker;
let extensionId;
let server;

test.beforeAll(async () => {
  server = createApp().listen(3000, "127.0.0.1");
  await once(server, "listening");
  const extensionPath = path.join(root, "extension");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
  if (server) await once(server, "close");
});

async function extensionPage(pathname) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${pathname}`);
  return page;
}

test("options persist all reader defaults without a credential field", async () => {
  const page = await extensionPage("options/options.html");
  await expect(page.getByLabel("Backend URL")).toHaveValue("http://127.0.0.1:3000");
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByLabel("Backend URL").fill("http://localhost:3000/private/path");
  await page.getByLabel("Pricing mode").selectOption("custom");
  await page.getByLabel("Custom USD per million bytes").fill("7");
  await page.getByLabel("Monthly limit (USD)").fill("3.25");
  await page.getByLabel("Warning threshold (%)").fill("75");
  await page.getByLabel("Playback speed").fill("1.5");
  await page.getByLabel("Chunk limit (UTF-8 bytes)").fill("500");
  await page.getByLabel("Minimum hover length").fill("60");
  await page.getByLabel("Skip code by default").uncheck();
  await page.getByLabel("Normalize DSA notation by default").check();
  await page.getByRole("button", { name: "Save options" }).click();
  await expect(page.locator("#status")).toHaveText("Options saved.");
  await expect(page.locator("#backend-status")).toHaveText("Backend status: connected.");

  const settings = await page.evaluate(async () =>
    (await chrome.runtime.sendMessage({ type: "USAGE_STATE_REQUEST" })).state.settings);
  expect(settings).toMatchObject({
    backendUrl: "http://localhost:3000", pricingMode: "custom",
    customPricePerMillionBytes: 7, monthlyLimitMicrousd: 3_250_000,
    warningThresholdPercent: 75, defaultPlaybackSpeed: 1.5,
    chunkLimit: 500, minimumHoverLength: 60, skipCode: false,
    dsaNormalization: true,
  });
  await page.close();
});

test("popup exposes labeled status and keyboard focus", async () => {
  const page = await extensionPage("popup/popup.html");
  await expect(page.locator("#backend-status")).toContainText("connected");
  await expect(page.locator("#budget-status")).toContainText("custom");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
  await expect(page.locator("#status")).toHaveAttribute("aria-live", "polite");
  await page.close();
});

test("history lists metadata, excludes text, exports, and resets with confirmation", async () => {
  const page = await extensionPage("history/history.html");
  await page.evaluate(() => chrome.runtime.sendMessage({
    type: "USAGE_SETTINGS_UPDATE",
    payload: { pricingMode: "free", backendUrl: "http://127.0.0.1:3000" },
  }));
  await page.evaluate(() => chrome.runtime.sendMessage({
    type: "SELECTION_READ_REQUEST",
    payload: { text: "Secret study passage must not be retained.", requestId: "history_request_123" },
  }));
  await page.reload();
  await expect(page.locator("#history-body")).toContainText("selection");
  await expect(page.locator("body")).not.toContainText("Secret study passage");
  const download = page.waitForEvent("download");
  await page.locator("#export").click();
  expect((await download).suggestedFilename()).toBe("fish-study-reader-usage.json");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#reset").click();
  await expect(page.locator("#history-body")).toContainText("No generated requests yet.");
  await page.close();
});
