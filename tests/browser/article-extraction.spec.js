import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, expect, test } from "@playwright/test";

import { createApp } from "../../server/src/app.js";
import { createTtsProvider } from "../../server/src/tts-provider.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const extensionPath = path.join(projectRoot, "extension");
let context;
let serviceWorker;
let server;
let extensionId;
let generatedTexts;

const fixtures = {
  blog: `<nav>Blog navigation noise</nav><article><h1>Reef Notes</h1><p>Coral reefs support diverse marine life.</p><ul><li>Protect shallow habitats.</li></ul><pre>ignored()</pre><p hidden>Hidden draft.</p></article><footer>Footer noise</footer>`,
  docs: `<main><aside>Table of contents</aside><h1>Queue Guide</h1><p>A queue processes items in order.</p><ol><li>Enqueue an item.</li><li>Dequeue an item.</li></ol></main>`,
  dsa: `<article><h1>Binary Search</h1><p>Binary search runs in O(log n).</p><pre>// compare the midpoint\nif (arr[mid] == target) return mid;</pre></article>`,
  poor: `<div><h1>Untidy Study Page</h1><p>Useful prose remains readable without semantic article markup.</p></div>`,
  nested: `<article><nav><p>Nested navigation must disappear.</p></nav><h1>Actual Lesson</h1><p>Main lesson prose stays.</p></article>`,
  hidden: `<article><h1>Visible Heading</h1><p style="display:none">Invisible paragraph.</p><p aria-hidden="true">Aria hidden paragraph.</p><p>Visible paragraph.</p></article>`,
};

test.beforeAll(async () => {
  generatedTexts = [];
  const mock = createTtsProvider({ mockMode: true });
  const provider = {
    ...mock,
    async synthesize(request) {
      generatedTexts.push(request.text);
      return mock.synthesize(request);
    },
  };
  const app = createApp({ ttsProvider: provider });
  app.get("/article/:kind", (request, response) => {
    response.type("html").send(`<!doctype html><html><body>${fixtures[request.params.kind]}</body></html>`);
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

async function fixture(kind) {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:3000/article/${kind}`);
  return page;
}

async function extract(page, codeMode = "skip") {
  await page.bringToFront();
  const tabId = await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab.id;
  });
  return serviceWorker.evaluate(async ({ id, mode }) => {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ["content/article-extractor.js"] });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: (value) => globalThis.__mochiAudioArticleExtractor.extractArticle({ codeMode: value }),
      args: [mode],
    });
    return result.result.text;
  }, { id: tabId, mode: codeMode });
}

test("extracts prose from blog, docs, poor structure, navigation, and hidden fixtures", async () => {
  const expectations = {
    blog: ["Reef Notes", "Coral reefs", "Protect shallow habitats."],
    docs: ["Queue Guide", "A queue processes", "Enqueue an item."],
    poor: ["Untidy Study Page", "Useful prose remains"],
    nested: ["Actual Lesson", "Main lesson prose stays."],
    hidden: ["Visible Heading", "Visible paragraph."],
  };
  for (const [kind, included] of Object.entries(expectations)) {
    const page = await fixture(kind);
    const text = await extract(page);
    for (const phrase of included) expect(text).toContain(phrase);
    expect(text).not.toMatch(/navigation noise|Footer noise|Table of contents|Nested navigation|Invisible|Aria hidden|ignored\(\)/);
    await page.close();
  }
});

test("supports skip, comments-only, and literal code modes", async () => {
  const page = await fixture("dsa");
  expect(await extract(page, "skip")).not.toContain("midpoint");
  const comments = await extract(page, "comments");
  expect(comments).toContain("compare the midpoint");
  expect(comments).not.toContain("arr[mid]");
  expect(await extract(page, "literal")).toContain("arr[mid] == target");
  await page.close();
});

test("popup previews editable normalized text and waits for confirmation", async () => {
  const page = await fixture("dsa");
  await page.bringToFront();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.evaluate(() => chrome.runtime.sendMessage({
    type: "USAGE_SETTINGS_UPDATE", payload: { dsaNormalization: true },
  }));
  await popup.reload();
  await expect(popup.locator("#status")).toContainText(/backend ready/i);
  await page.bringToFront();
  await popup.locator("#read-article").click();
  await expect(popup.locator("#article-preview")).toBeVisible();
  expect(generatedTexts).toHaveLength(0);
  await expect(popup.locator("#article-speech")).toHaveValue(/big O of log n/);
  await popup.locator("#article-speech").fill("Edited speech preview.");
  expect(generatedTexts).toHaveLength(0);
  await popup.locator("#confirm-article").click();
  await expect.poll(() => generatedTexts).toEqual(["Edited speech preview."]);
  await popup.close();
  await page.close();
});
