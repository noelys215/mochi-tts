import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, expect, test } from "@playwright/test";

import { createApp } from "../../server/src/app.js";
import { createTtsProvider } from "../../server/src/tts-provider.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const extensionPath = path.join(projectRoot, "extension");
const passageButton = ".mochi-audio-passage-button";
const pageButton = ".mochi-audio-page-button";
let context;
let serviceWorker;
let server;
let extensionId;
let generatedTexts;

test.beforeAll(async () => {
  generatedTexts = [];
  const mock = createTtsProvider({ mockMode: true });
  const app = createApp({
    ttsProvider: {
      ...mock,
      async synthesize(request) {
        generatedTexts.push(request.text);
        return mock.synthesize(request);
      },
    },
  });
  app.get("/in-page-fixture", (_request, response) => {
    response.type("html").send(`<!doctype html><html lang="en"><body>
      <header>Site header</header>
      <main>
        <article id="lesson">
          <h1>Reef lesson</h1>
          <div id="wrapper">
            <p id="first">Coral reef ecosystems contain diverse species and support important coastal habitats.</p>
            <p id="second">Healthy reefs reduce wave energy while providing food and shelter for marine life.</p>
          </div>
          <div id="leaf">Standalone field notes explain how scientists measure coral cover over time.</div>
          <pre><code>ignored_code()</code></pre>
        </article>
      </main>
      <nav><p id="navigation">Navigation contains enough words but must never receive a reading action.</p></nav>
      <form><p id="form-copy">Form instructions contain enough words but must remain untouched by the extension.</p></form>
      <p id="short">Too short.</p>
      <button id="site-button" onclick="this.dataset.clicked='yes'">Site action</button>
      <div id="dynamic"></div>
    </body></html>`);
  });
  server = app.listen(3000, "127.0.0.1");
  await once(server, "listening");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  extensionId = new URL(serviceWorker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
  if (server) await once(server, "close");
});

test.beforeEach(() => { generatedTexts.length = 0; });
test.afterEach(async () => {
  await Promise.all(context.pages().filter((page) => page.url() !== "about:blank").map((page) => page.close()));
});

async function fixture() {
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:3000/in-page-fixture");
  await page.bringToFront();
  return page;
}

async function popup() {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  return page;
}

async function enableFromPopup(page) {
  const controls = await popup();
  await page.bringToFront();
  await controls.evaluate(() => document.querySelector("#in-page-toggle").click());
  await expect(controls.locator("#in-page-toggle")).toHaveAttribute("aria-pressed", "true");
  return controls;
}

test("controls are opt-in and select paragraphs and leaf prose without wrappers", async () => {
  const page = await fixture();
  await expect(page.locator(passageButton)).toHaveCount(0);
  const controls = await enableFromPopup(page);

  await expect(page.locator(passageButton)).toHaveCount(3);
  await expect(page.locator(pageButton)).toHaveCount(1);
  await page.waitForTimeout(180);
  expect(generatedTexts).toHaveLength(0);
  await page.locator("#site-button").click();
  await expect(page.locator("#site-button")).toHaveAttribute("data-clicked", "yes");
  await expect(controls.locator("#in-page-status")).toHaveText("On");
});

test("a passage reads only its cleaned text and opens the synchronized player", async () => {
  const page = await fixture();
  const controls = await enableFromPopup(page);
  await page.locator(passageButton).first().click();

  await expect.poll(() => generatedTexts.length).toBe(1);
  expect(generatedTexts[0]).toBe(
    "Coral reef ecosystems contain diverse species and support important coastal habitats.",
  );
  const player = page.locator('[data-mochi-audio-ui="in-page-player"]');
  await expect(player).toHaveCount(1);
  await expect(player.locator('input[aria-label="Current chunk playback position"]')).toBeVisible();
  await expect(player.locator("[data-queue]")).toHaveText("Chunk 1 of 1");

  await player.locator('button[aria-label="Pause"]').click();
  await controls.locator('[data-playback="PLAYBACK_RESUME"]').click();
  await expect(player.locator("[data-status]")).toContainText(/playing|ended/);
  await player.locator('button[aria-label="Stop"]').click();
  const playback = await controls.evaluate(() => chrome.runtime.sendMessage({ type: "PLAYBACK_STATE_REQUEST" }));
  expect(playback.state.status).toBe("idle");
});

test("Read this page reuses extraction and requires confirmation", async () => {
  const page = await fixture();
  await enableFromPopup(page);
  await page.locator(pageButton).click();
  const confirmation = page.locator(".mochi-audio-confirmation");
  await expect(confirmation).toBeVisible();
  await expect(confirmation.locator("textarea")).toHaveValue(/Coral reef ecosystems/);
  await expect(confirmation.locator("textarea")).not.toHaveValue(/ignored_code|Navigation contains/);
  expect(generatedTexts).toHaveLength(0);
  await confirmation.locator('[data-action="confirm-page"]').click();
  await expect.poll(() => generatedTexts.length).toBe(1);
  expect(generatedTexts[0]).toContain("Healthy reefs reduce wave energy");
  expect(generatedTexts[0]).not.toContain("ignored_code");
});

test("dynamic passages are deduplicated and disabling performs complete UI cleanup", async () => {
  const page = await fixture();
  const controls = await enableFromPopup(page);
  await page.locator("#dynamic").evaluate((root) => {
    root.innerHTML = '<div><div><p id="added">A dynamically inserted paragraph contains enough useful prose for a new reading control.</p></div></div>';
  });
  await expect(page.locator(passageButton)).toHaveCount(4);

  await controls.evaluate(() => document.querySelector("#in-page-toggle").click());
  await expect(page.locator(passageButton)).toHaveCount(0);
  await expect(page.locator(pageButton)).toHaveCount(0);
  await expect(page.locator('[data-mochi-audio-ui="in-page-player"]')).toHaveCount(0);

  await page.bringToFront();
  await controls.evaluate(() => document.querySelector("#in-page-toggle").click());
  await expect(page.locator(passageButton)).toHaveCount(4);
  await controls.evaluate(() => document.querySelector("#in-page-toggle").click());
  await expect(page.locator('[data-mochi-audio-ui]')).toHaveCount(0);
});
