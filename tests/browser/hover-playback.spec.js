import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, expect, test } from "@playwright/test";

import { createApp } from "../../server/src/app.js";
import { createTtsProvider } from "../../server/src/tts-provider.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const extensionPath = path.join(projectRoot, "extension");
const hoverButton = '[data-mochi-audio-ui="button"]';
let context;
let serviceWorker;
let server;
let extensionId;
let generatedTexts;

test.beforeAll(async () => {
  generatedTexts = [];
  const mockProvider = createTtsProvider({ mockMode: true });
  const ttsProvider = {
    mode: "mock",
    async synthesize(request) {
      generatedTexts.push(request.text);
      return mockProvider.synthesize(request);
    },
  };
  const app = createApp({ ttsProvider });
  app.get("/hover-fixture", (_request, response) => {
    response.type("html").send(`
      <!doctype html>
      <html lang="en">
        <body>
          <article id="article">
            Article introduction provides enough study context for reading.
            <p id="paragraph">
              Paragraph passage explains coral ecosystems in useful detail.
              <span id="inside">Focus here.</span>
              <span hidden>Hidden words must not be read.</span>
              <code>ignored_code()</code>
            </p>
            <div id="article-only">Additional article details live here.</div>
          </article>
          <nav><p id="nav-passage">Navigation text must never be selected for reading.</p></nav>
          <p id="short">Too short.</p>
        </body>
      </html>
    `);
  });
  server = app.listen(3000, "127.0.0.1");
  await once(server, "listening");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  serviceWorker =
    context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  extensionId = new URL(serviceWorker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
  if (server) {
    await once(server, "close");
  }
});

test.beforeEach(async () => {
  generatedTexts.length = 0;
});

test.afterEach(async () => {
  const disposablePages = context
    .pages()
    .filter((page) => page.url() !== "about:blank");
  await Promise.all(disposablePages.map((page) => page.close()));
});

async function fixturePage() {
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:3000/hover-fixture");
  await page.bringToFront();
  return page;
}

async function activeTabId(page) {
  await page.bringToFront();
  return serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab.id;
  });
}

async function injectHoverReader(page) {
  const tabId = await activeTabId(page);
  await serviceWorker.evaluate(async (id) => {
    await chrome.scripting.executeScript({
      target: { tabId: id },
      files: [
        "content/article-extractor.js",
        "content/hover-target.js",
        "content/hover-reader.js",
      ],
    });
  }, tabId);
  return tabId;
}

async function contentMessage(tabId, type, payload) {
  return serviceWorker.evaluate(
    ({ id, messageType, messagePayload }) =>
      chrome.tabs.sendMessage(id, {
        target: "content",
        type: messageType,
        payload: messagePayload,
      }),
    { id: tabId, messageType: type, messagePayload: payload },
  );
}

async function enableHover(page) {
  const tabId = await injectHoverReader(page);
  await contentMessage(tabId, "HOVER_MODE_ENABLE", { minimumLength: 40 });
  return tabId;
}

async function extensionPage() {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  return page;
}

async function playbackMessage(page, type, payload) {
  return page.evaluate(
    ({ messageType, messagePayload }) =>
      chrome.runtime.sendMessage({
        target: "offscreen",
        type: messageType,
        payload: messagePayload,
      }),
    { messageType: type, messagePayload: payload },
  );
}

test("hover mode is inactive until enabled from the popup", async () => {
  const page = await fixturePage();
  await injectHoverReader(page);
  await page.locator("#paragraph").hover();
  await expect(page.locator(hoverButton)).toHaveCount(0);

  const popup = await extensionPage();
  await page.bringToFront();
  await popup.evaluate(() => document.querySelector("#hover-toggle").click());
  await expect(popup.locator("#hover-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  await page.locator("#paragraph").hover();
  await expect(page.locator(hoverButton)).toBeVisible();
});

test("hover shows one button, prioritizes the paragraph, and makes no request", async () => {
  const page = await fixturePage();
  await enableHover(page);
  await page.locator("#inside").hover();

  await expect(page.locator(hoverButton)).toHaveCount(1);
  await expect(page.locator(hoverButton)).toBeVisible();
  await expect(page.locator("#paragraph")).toHaveClass(/__mochi-audio-hover-target/);
  await expect(page.locator("#article")).not.toHaveClass(/__mochi-audio-hover-target/);
  await page.waitForTimeout(220);
  expect(generatedTexts).toHaveLength(0);
});

test("moving from passage to its button does not hide it", async () => {
  const page = await fixturePage();
  await enableHover(page);
  await page.locator("#paragraph").hover();
  const button = page.locator(hoverButton);
  await button.hover();
  await page.waitForTimeout(220);
  await expect(button).toBeVisible();
});

test("clicking reads only the chosen visible passage", async () => {
  const page = await fixturePage();
  await enableHover(page);
  await page.locator("#inside").hover();
  await page.locator(hoverButton).click();

  await expect.poll(() => generatedTexts.length).toBe(1);
  expect(generatedTexts[0]).toBe(
    "Paragraph passage explains coral ecosystems in useful detail. Focus here.",
  );
});

test("hovered articles reuse cleaning and require confirmation", async () => {
  const page = await fixturePage();
  await enableHover(page);
  await page.locator("#article-only").hover();
  const button = page.locator(hoverButton);
  await expect(button).toHaveText("Preview article");
  await button.click();
  await expect(button).toHaveText("Confirm article");
  expect(generatedTexts).toHaveLength(0);
  await button.click();

  await expect.poll(() => generatedTexts.length).toBe(1);
  expect(generatedTexts[0]).toContain("Paragraph passage explains coral ecosystems");
  expect(generatedTexts[0]).not.toContain("Hidden words");
  expect(generatedTexts[0]).not.toContain("ignored_code");
});

test("Escape removes hover UI and disables the mode", async () => {
  const page = await fixturePage();
  const tabId = await enableHover(page);
  await page.locator("#paragraph").hover();
  await expect(page.locator(hoverButton)).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(page.locator(hoverButton)).toHaveCount(0);
  await expect(page.locator("#paragraph")).not.toHaveClass(
    /__mochi-audio-hover-target/,
  );
  await expect
    .poll(async () =>
      (await contentMessage(tabId, "HOVER_MODE_STATUS_REQUEST")).enabled,
    )
    .toBe(false);
});

test("repeated enable and disable does not duplicate controls", async () => {
  const page = await fixturePage();
  const tabId = await injectHoverReader(page);
  for (let index = 0; index < 3; index += 1) {
    await contentMessage(tabId, "HOVER_MODE_ENABLE", { minimumLength: 40 });
    await contentMessage(tabId, "HOVER_MODE_DISABLE");
  }
  await contentMessage(tabId, "HOVER_MODE_ENABLE", { minimumLength: 40 });
  await page.locator("#paragraph").hover();
  await expect(page.locator(hoverButton)).toHaveCount(1);
  await contentMessage(tabId, "HOVER_MODE_DISABLE");
  await expect(page.locator(hoverButton)).toHaveCount(0);
});

test("playback controls work after the initiating popup closes", async () => {
  const page = await fixturePage();
  await enableHover(page);
  const controls = await extensionPage();
  await page.bringToFront();
  await page.locator("#paragraph").hover();
  await page.locator(hoverButton).click();
  await expect.poll(() => generatedTexts.length).toBe(1);

  await expect(controls.locator("#playback-toggle")).toHaveText("Pause");
  await controls.locator("#playback-toggle").click();
  await expect(controls.locator("#status")).toHaveText("Playback: paused.");
  await controls.locator("#playback-rate").selectOption("1.5");
  await expect(controls.locator("#playback-toggle")).toHaveText("Resume");
  await controls.locator("#playback-toggle").click();
  await expect(controls.locator("#status")).toHaveText(/Playback: (playing|ended)\./);
  const resumed = await playbackMessage(controls, "PLAYBACK_STATE_REQUEST");
  expect(resumed.state.playbackRate).toBe(1.5);
  const requestId = resumed.state.requestId;

  await controls.close();
  const reopened = await extensionPage();
  const persisted = await playbackMessage(reopened, "PLAYBACK_STATE_REQUEST");
  expect(persisted.state.requestId).toBe(requestId);
  expect(["playing", "ended"]).toContain(persisted.state.status);
  await reopened.locator("#playback-stop").click();
  await expect(reopened.locator("#status")).toHaveText("Playback: idle.");
});
