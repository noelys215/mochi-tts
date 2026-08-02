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
const player = '[data-mochi-audio-ui="in-page-player"]';
let context;
let serviceWorker;
let server;
let extensionId;
let generatedTexts;
let delayGeneration;
let abortedGenerations;

const leetCodeFixture = `<!doctype html><html lang="en"><head><title>Sliding window</title></head><body>
  <nav>Lesson navigation should never be spoken.</nav>
  <div class="article-inner">
    <div class="content-title-base"><span class="content-title">Sliding window</span><a>Report Issue</a></div>
    <div class="block-markdown">
      <blockquote><p id="intro">Introductory prose explains how a moving range helps process sequential values efficiently.</p></blockquote>
      <p id="lesson">A paragraph with <strong id="bold">bold text</strong>, <code id="inline-code">[1, 2, 3]</code>, and inline math
        <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>O</mi><mo>(</mo><mi>n</mi><mo>)</mo></mrow><annotation encoding="application/x-tex">O(n)</annotation></semantics></math></span><span aria-hidden="true">O(n) duplicate visual math</span></span>
        remains useful explanatory prose for the lesson.</p>
      <p id="second">A second substantial paragraph describes how left and right boundaries advance through the input.</p>
      <p id="empty"><br></p>
      <div class="codehilite" id="full-code"><pre>function example() { return 1; }</pre></div>
      <details id="details"><summary>More detail</summary><p id="details-copy">Initially hidden explanatory prose becomes readable after the disclosure opens.</p></details>
    </div>
  </div>
  <aside>Unrelated sidebar controls and commentary.</aside>
</body></html>`;

test.beforeAll(async () => {
  generatedTexts = [];
  delayGeneration = false;
  abortedGenerations = 0;
  const mock = createTtsProvider({ mockMode: true });
  const app = createApp({
    ttsProvider: {
      ...mock,
      async synthesize(request) {
        generatedTexts.push(request.text);
        if (delayGeneration) {
          await new Promise((resolve, reject) => {
            if (request.signal.aborted) return reject(new DOMException("Cancelled", "AbortError"));
            request.signal.addEventListener("abort", () => {
              abortedGenerations += 1;
              reject(new DOMException("Cancelled", "AbortError"));
            }, { once: true });
          });
        }
        return mock.synthesize(request);
      },
    },
  });
  app.get("/hover-fixture", (_request, response) => response.type("html").send(`<!doctype html><html><body>
    <article><h1 id="title">Reef lesson</h1>
      <div><p id="first">Coral reef ecosystems contain diverse species and support important coastal habitats.</p></div>
      <p id="second">Healthy reefs reduce wave energy while providing food and shelter for marine life.</p>
    </article><nav><p id="nav-copy">Navigation words must never become a passage hover target.</p></nav>
  </body></html>`));
  server = app.listen(3000, "127.0.0.1");
  await once(server, "listening");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  await context.route("https://leetcode.com/learn/sliding-window", (route) => route.fulfill({
    status: 200, contentType: "text/html", body: leetCodeFixture,
  }));
  serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  extensionId = new URL(serviceWorker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
  if (server) await once(server, "close");
});

test.beforeEach(() => { generatedTexts.length = 0; delayGeneration = false; abortedGenerations = 0; });
test.afterEach(async () => {
  await serviceWorker.evaluate(() => chrome.runtime.sendMessage({ type: "PLAYBACK_SESSION_STOP" })).catch(() => {});
  await Promise.all(context.pages().filter((page) => page.url() !== "about:blank").map((page) => page.close()));
});

async function genericPage() {
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:3000/hover-fixture");
  return page;
}

async function leetCodePage() {
  const page = await context.newPage();
  await page.goto("https://leetcode.com/learn/sliding-window");
  return page;
}

async function popupFor(page) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.bringToFront();
  return popup;
}

async function commandFromTab(page, type) {
  await page.bringToFront();
  const tabId = await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab.id;
  });
  return serviceWorker.evaluate(async ({ id, command }) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: (messageType) => chrome.runtime.sendMessage({ type: messageType }),
      args: [command],
    });
    return result.result;
  }, { id: tabId, command: type });
}

async function renderPlayerState(page, payload) {
  await page.bringToFront();
  const tabId = await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab.id;
  });
  await serviceWorker.evaluate(({ id, state }) => chrome.tabs.sendMessage(id, {
    target: "content", type: "TAB_PLAYBACK_STATE_CHANGED", payload: state,
  }), { id: tabId, state: payload });
}

async function expectPlayerContained(page) {
  const bar = page.locator(`${player} .player`);
  const barBox = await bar.boundingBox();
  expect(barBox.x).toBeGreaterThanOrEqual(0);
  expect(barBox.x + barBox.width).toBeLessThanOrEqual(page.viewportSize().width);
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(page.viewportSize().height);
  const boxes = await page.locator(`${player} button:visible,${player} select:visible,${player} input:visible`)
    .evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }));
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(barBox.x - 1);
    expect(box.right).toBeLessThanOrEqual(barBox.x + barBox.width + 1);
    expect(box.top).toBeGreaterThanOrEqual(barBox.y - 1);
    expect(box.bottom).toBeLessThanOrEqual(barBox.y + barBox.height + 1);
  }
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      const overlapWidth = Math.min(boxes[left].right, boxes[right].right) -
        Math.max(boxes[left].left, boxes[right].left);
      const overlapHeight = Math.min(boxes[left].bottom, boxes[right].bottom) -
        Math.max(boxes[left].top, boxes[right].top);
      expect(Math.min(overlapWidth, overlapHeight)).toBeLessThanOrEqual(1);
    }
  }
}

async function enable(page) {
  const popup = await popupFor(page);
  await popup.evaluate(() => document.querySelector("#passage-hover-toggle").click());
  await expect(popup.locator("#passage-hover-toggle")).toHaveAttribute("aria-pressed", "true");
  return popup;
}

test("unified controls are opt-in and reuse one hover passage button", async () => {
  const page = await genericPage();
  await expect(page.locator("#mochi-audio-in-page-overlay")).toHaveCount(0);
  const popup = await enable(page);
  await expect(page.locator(passageButton)).toBeHidden();
  await expect(page.locator(pageButton)).toBeHidden();
  expect(generatedTexts).toHaveLength(0);

  await page.locator("#first").hover();
  const button = page.locator(passageButton);
  await expect(button).toBeVisible();
  await button.evaluate((node) => { node.dataset.testIdentity = "single"; });
  const targetBox = await page.locator("#first").boundingBox();
  const buttonBox = await button.boundingBox();
  expect(Math.abs(buttonBox.x + buttonBox.width - targetBox.x - targetBox.width)).toBeLessThanOrEqual(12);
  await button.hover();
  await page.waitForTimeout(260);
  await expect(button).toBeVisible();
  await page.locator("#second").hover();
  await expect(page.locator(`${passageButton}[data-test-identity="single"]`)).toHaveCount(1);
  expect(generatedTexts).toHaveLength(0);

  await button.click();
  await expect.poll(() => generatedTexts.length).toBe(1);
  expect(generatedTexts[0]).toContain("Healthy reefs reduce wave energy");
  await expect(page.locator(player)).toHaveCount(1);
  await page.locator(`${player} [data-command="PLAYBACK_STOP"]`).click();
  await expect(page.locator(player)).toHaveCount(0);
  await popup.close();
});

test("generation feedback prevents duplicate clicks and Cancel restores controls without usage", async () => {
  delayGeneration = true;
  const page = await genericPage();
  const popup = await enable(page);
  const before = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "USAGE_STATE_REQUEST" }));
  await page.locator("#first").hover();
  const button = page.locator(passageButton);
  await button.click();
  await expect(button).toHaveAttribute("aria-busy", "true");
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute("aria-label", "Generating passage audio");
  await expect(page.locator(`${player} [data-player-status]`)).toHaveText("Preparing audio…");
  await expect(page.locator(`${player} [data-controls]`)).toBeHidden();
  await expect(page.locator(`${player} [data-progress-row]`)).toBeHidden();
  await expect(page.locator(`${player} [data-action="cancel-generation"]`)).toBeVisible();
  await expect(page.locator(player)).not.toContainText(/Chunk|Queue|0:00/);
  await expect(page.locator(pageButton)).toBeDisabled();

  await button.evaluate((node) => { node.click(); node.click(); });
  await expect.poll(() => generatedTexts.length).toBe(1);
  await page.locator(`${player} [data-action="cancel-generation"]`).click();
  await expect.poll(() => abortedGenerations).toBe(1);
  await expect(page.locator(player)).toHaveCount(0);
  await page.locator("#first").hover();
  await expect(button).toBeEnabled();
  await expect(button).toHaveAttribute("aria-busy", "false");
  const after = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "USAGE_STATE_REQUEST" }));
  expect(after.state.records).toHaveLength(before.state.records.length);
  await popup.close();
});

test("compact player uses one stateful action and responsive part controls", async () => {
  const page = await genericPage();
  await page.setViewportSize({ width: 320, height: 568 });
  await enable(page);
  const session = { ownsPlayback: true, otherTabActive: false };
  const generation = { status: "idle", ownsGeneration: false, cancellable: false };
  await renderPlayerState(page, {
    session: { ownsPlayback: false, otherTabActive: false },
    generation: { status: "generating", ownsGeneration: true, cancellable: true },
    playback: { status: "idle", requestId: null, currentTime: 0, duration: 0, playbackRate: 1 },
    queue: { currentIndex: -1, entries: [{}] },
  });
  await expect(page.locator(`${player} [data-player-status]`)).toHaveText("Preparing audio…");
  await expect(page.locator(`${player} [data-controls]`)).toBeHidden();
  await expectPlayerContained(page);

  await renderPlayerState(page, {
    session, generation,
    playback: { status: "playing", requestId: "request_ui_123", currentTime: 22, duration: 36, playbackRate: 1 },
    queue: { currentIndex: 0, entries: [{}] },
  });
  await expect(page.locator(`${player} [data-player-status]`)).toHaveText("Playing");
  await expect(page.locator(`${player} [data-primary]`)).toHaveAttribute("aria-label", "Pause audio");
  await expect(page.locator(`${player} [data-previous]`)).toBeHidden();
  await expect(page.locator(`${player} [data-next]`)).toBeHidden();
  await expect(page.locator(`${player} [data-time]`)).toHaveText("0:22 / 0:36");
  await expect(page.locator(player)).not.toContainText(/Chunk|Queue/);
  await expectPlayerContained(page);

  await renderPlayerState(page, {
    session, generation,
    playback: { status: "paused", requestId: "request_ui_123", currentTime: 22, duration: 36, playbackRate: 1.25 },
    queue: { currentIndex: 1, entries: [{}, {}, {}] },
  });
  await expect(page.locator(`${player} [data-primary]`)).toHaveAttribute("aria-label", "Resume audio");
  await expect(page.locator(`${player} [data-part]`)).toHaveText("Part 2 of 3");
  await expect(page.locator(`${player} [data-previous]`)).toBeEnabled();
  await expect(page.locator(`${player} [data-next]`)).toBeEnabled();
  await expectPlayerContained(page);

  await page.setViewportSize({ width: 375, height: 667 });
  await expectPlayerContained(page);
  await renderPlayerState(page, {
    session, generation,
    playback: { status: "ended", requestId: "request_ui_123", currentTime: 36, duration: 36, playbackRate: 1 },
    queue: { currentIndex: 0, entries: [{}] },
  });
  await expect(page.locator(`${player} [data-player-status]`)).toHaveText("Playback finished");
  await expect(page.locator(`${player} [data-primary]`)).toHaveAttribute("aria-label", "Replay audio");
  await renderPlayerState(page, {
    session: { ownsPlayback: false, otherTabActive: false },
    generation: { status: "failed", ownsGeneration: true, cancellable: false },
    playback: { status: "idle", requestId: null, currentTime: 0, duration: 0, playbackRate: 1 },
    queue: { currentIndex: -1, entries: [] },
  });
  await expect(page.locator(`${player} [data-player-status]`)).toHaveText("Could not prepare audio");
  await expect(page.locator(`${player} [data-action="retry-generation"]`)).toBeVisible();
  await expect(page.locator(`${player} [data-action="cancel-generation"]`)).toBeHidden();
  await expect(page.locator(`${player} [data-controls]`)).toBeHidden();
  await page.locator(`${player} [data-close]`).click();
  await expect(page.locator(player)).toHaveCount(0);
});

test("LeetCode adapter preserves inline code, deduplicates math, and exposes page reading", async () => {
  const page = await leetCodePage();
  expect(await page.locator("article,main").count()).toBe(0);
  await enable(page);

  await page.locator("#inline-code").hover();
  await expect(page.locator("#lesson")).toHaveClass(/mochi-audio-hover-target-active/);
  await page.locator("#bold").hover();
  await expect(page.locator("#lesson")).toHaveClass(/mochi-audio-hover-target-active/);
  await page.locator(passageButton).click();
  await expect.poll(() => generatedTexts.length).toBe(1);
  expect(generatedTexts[0]).toContain("[1, 2, 3]");
  expect((generatedTexts[0].match(/O\(n\)/g) || [])).toHaveLength(1);

  await page.locator("#full-code").hover();
  await expect(page.locator(passageButton)).toBeHidden({ timeout: 1_000 });
  await page.locator("#empty").hover();
  await expect(page.locator(passageButton)).toBeHidden();
  await page.locator("#details-copy").hover({ force: true });
  await expect(page.locator(passageButton)).toBeHidden();
  await page.locator("#details").evaluate((node) => { node.open = true; });
  await page.locator("#details-copy").hover();
  await expect(page.locator(passageButton)).toBeVisible();
  await page.locator("#details").evaluate((node) => { node.open = false; });
  await expect(page.locator(passageButton)).toBeHidden({ timeout: 1_000 });

  await page.locator(".content-title").hover();
  await expect(page.locator(pageButton)).toBeVisible();
  await page.locator(pageButton).hover();
  await page.waitForTimeout(260);
  await expect(page.locator(pageButton)).toBeVisible();
  await page.locator(pageButton).click();
  const preview = page.locator(".mochi-audio-confirmation textarea");
  await expect(preview).toBeVisible();
  const text = await preview.inputValue();
  expect(text).toContain("[1, 2, 3]");
  expect((text.match(/O\(n\)/g) || [])).toHaveLength(1);
  expect(text).not.toMatch(/Report Issue|function example|Lesson navigation/);
});

test("dynamic lesson replacement re-resolves the primary region without duplicate UI", async () => {
  const page = await leetCodePage();
  await enable(page);
  await page.locator(".block-markdown").evaluate((node) => {
    const replacement = document.createElement("div");
    replacement.className = "block-markdown";
    replacement.innerHTML = '<p id="replacement-one">Replacement lesson prose contains enough detail for hover reading after navigation.</p><p id="replacement-two">Another replacement paragraph makes this a substantial primary content region.</p>';
    node.replaceWith(replacement);
    history.pushState({}, "", "/learn/replacement-lesson");
  });
  await page.waitForTimeout(180);
  await page.locator("#replacement-one").hover();
  await expect(page.locator(passageButton)).toBeVisible();
  await expect(page.locator("#mochi-audio-in-page-overlay")).toHaveCount(1);
  await expect(page.locator(passageButton)).toHaveCount(1);
});

test("one playback session transfers ownership between tabs and clears on owner close", async () => {
  const tabA = await genericPage();
  const popupA = await enable(tabA);
  await tabA.locator("#first").hover();
  await tabA.locator(passageButton).click();
  await expect.poll(() => generatedTexts.length).toBe(1);
  await expect(tabA.locator(player)).toHaveCount(1);

  const tabB = await genericPage();
  const popupB = await enable(tabB);
  await expect(tabB.locator(player)).toHaveCount(0);
  await tabB.bringToFront();
  await popupB.evaluate(() => globalThis.__mochiAudioPopupRefreshPlayback());
  await expect(popupB.locator("#other-playback-status")).toBeVisible();
  await expect(popupB.locator("#playback-owner-controls")).toBeHidden();

  await tabB.locator("#second").hover();
  await tabB.locator(passageButton).click();
  await expect.poll(() => generatedTexts.length).toBe(2);
  await expect(tabB.locator(player)).toHaveCount(1);
  await expect(tabA.locator(player)).toHaveCount(0);
  const rejected = await commandFromTab(tabA, "PLAYBACK_PAUSE");
  expect(rejected.ok).toBe(false);
  expect(rejected.error).toMatch(/another tab/i);

  await tabA.close();
  await expect(tabB.locator(player)).toHaveCount(1);
  await tabB.goto("http://127.0.0.1:3000/hover-fixture?next-lesson");
  await expect.poll(async () => {
    const response = await popupB.evaluate(() => chrome.runtime.sendMessage({ type: "PLAYBACK_STATE_REQUEST" }));
    return response.state.session.otherTabActive;
  }).toBe(false);
  await enable(tabB);
  await tabB.locator("#first").hover();
  await tabB.locator(passageButton).click();
  await expect.poll(() => generatedTexts.length).toBe(3);
  await tabB.close();
  await expect.poll(async () => {
    const response = await popupB.evaluate(() => chrome.runtime.sendMessage({ type: "PLAYBACK_STATE_REQUEST" }));
    return response.state.session.otherTabActive;
  }).toBe(false);
  await Promise.all([popupA.close(), popupB.close()]);
});

test("Escape disables passage hover controls and repeated toggles stay singular", async () => {
  const page = await genericPage();
  const popup = await enable(page);
  await page.locator("#first").hover();
  await page.keyboard.press("Escape");
  await expect(page.locator("#mochi-audio-in-page-overlay")).toHaveCount(0);
  await page.bringToFront();
  await popup.evaluate(() => globalThis.__mochiAudioPopupRefreshPlayback());
  for (let index = 0; index < 2; index += 1) {
    await popup.evaluate(() => document.querySelector("#passage-hover-toggle").click());
    await popup.evaluate(() => document.querySelector("#passage-hover-toggle").click());
  }
  await popup.evaluate(() => document.querySelector("#passage-hover-toggle").click());
  await page.locator("#first").hover();
  await expect(page.locator("#mochi-audio-in-page-overlay")).toHaveCount(1);
  await expect(page.locator(passageButton)).toHaveCount(1);
  expect(generatedTexts).toHaveLength(0);
});
