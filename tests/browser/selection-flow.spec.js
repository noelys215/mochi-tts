import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, expect, test } from "@playwright/test";

import { createApp } from "../../server/src/app.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("unpacked extension reads selected fixture text through mock audio", async () => {
  const app = createApp();
  app.get("/fixture", (_request, response) => {
    response.type("html").send(`
      <!doctype html>
      <html lang="en">
        <body><p id="passage">Mochi studies coral reef ecology.</p></body>
      </html>
    `);
  });
  const server = app.listen(3000, "127.0.0.1");
  await once(server, "listening");
  const extensionPath = path.join(projectRoot, "extension");
  let context;

  try {
    context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    const serviceWorker =
      context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
    expect(serviceWorker.url()).toContain("background/service-worker.js");

    const fixturePage = await context.newPage();
    await fixturePage.goto("http://127.0.0.1:3000/fixture");
    await fixturePage.locator("#passage").selectText();

    const selectionResults = await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/selection.js"],
      });
    });
    const selectedText = selectionResults[0]?.result;
    expect(selectedText).toBe("Mochi studies coral reef ecology.");

    const extensionId = new URL(serviceWorker.url()).host;
    const extensionPage = await context.newPage();
    await extensionPage.goto(
      `chrome-extension://${extensionId}/popup/popup.html`,
    );
    const emptyResult = await extensionPage.evaluate(() =>
      chrome.runtime.sendMessage({
        type: "SELECTION_READ_REQUEST",
        payload: { text: "", requestId: "browser_empty_123" },
      }),
    );
    expect(emptyResult).toEqual({
      ok: false,
      error: "Select some text to read first.",
    });
    const oversizedResult = await extensionPage.evaluate(() =>
      chrome.runtime.sendMessage({
        type: "SELECTION_READ_REQUEST",
        payload: { text: "🐟".repeat(125_001), requestId: "browser_large_123" },
      }),
    );
    expect(oversizedResult).toEqual({
      ok: false,
      error: "Text exceeds the 500000-byte limit.",
    });

    const result = await extensionPage.evaluate(async (text) => {
      return chrome.runtime.sendMessage({
        type: "SELECTION_READ_REQUEST",
        payload: { text, requestId: "browser_request_123" },
      });
    }, selectedText);

    expect(result).toEqual({
      ok: true,
      usage: {
        requestId: "browser_request_123",
        inputBytes: Buffer.byteLength(selectedText),
        estimatedCostMicrousd: 0,
        pricingMode: "mock",
        model: "mock",
        warning: false,
      },
    });
    const offscreenContexts = await serviceWorker.evaluate(() =>
      chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }),
    );
    expect(offscreenContexts).toHaveLength(1);
  } finally {
    await context?.close();
    server.close();
    await once(server, "close");
  }
});
