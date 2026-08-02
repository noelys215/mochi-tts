import { MESSAGE_TYPES } from "../shared/messages.js";
import { speechText } from "../shared/dsa-normalizer.js";

const readButton = document.querySelector("#read-selection");
const articleButton = document.querySelector("#read-article");
const hoverToggle = document.querySelector("#hover-toggle");
const inPageToggle = document.querySelector("#in-page-toggle");
const articlePreview = document.querySelector("#article-preview");
const articleSpeech = document.querySelector("#article-speech");
const playbackToggle = document.querySelector("#playback-toggle");
const playbackProgress = document.querySelector("#playback-progress");
const playbackRate = document.querySelector("#playback-rate");
const status = document.querySelector("#status");
const budgetWarning = document.querySelector("#budget-warning");
const HOVER_MINIMUM_LENGTH = 40;
let hoverEnabled = false;
let inPageEnabled = false;
let appSettings;
let articleOriginalText = "";
let articleTabId = null;
let estimateTimer;
let playbackState = {
  status: "idle", requestId: null, currentTime: 0, duration: 0, playbackRate: 1,
};

function formatUsage(value) {
  return `${value.inputBytes.toLocaleString()} bytes · $${(value.estimatedCostMicrousd / 1_000_000).toFixed(2)}`;
}

function formatTime(seconds) {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function renderUsage(state) {
  document.querySelector("#usage-today").textContent = formatUsage(state.aggregates.today);
  document.querySelector("#usage-month").textContent = formatUsage(state.aggregates.month);
  const settings = state.settings;
  document.querySelector("#budget-status").textContent = settings.monthlyLimitMicrousd
    ? `${settings.pricingMode} · $${(settings.monthlyLimitMicrousd / 1_000_000).toFixed(2)} limit`
    : `${settings.pricingMode[0].toUpperCase()}${settings.pricingMode.slice(1)} mode`;
}

async function refreshUsage() {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.USAGE_STATE_REQUEST });
  if (response?.ok) renderUsage(response.state);
}

function setStatus(message, kind = "info") {
  status.textContent = message;
  status.dataset.kind = kind;
  status.setAttribute("role", kind === "error" ? "alert" : "status");
  budgetWarning.hidden = !/monthly spending limit reached/i.test(message);
}

function renderPlayback(next) {
  if (!next) return;
  playbackState = next;
  const duration = Number.isFinite(next.duration) ? next.duration : 0;
  const currentTime = Math.min(Number.isFinite(next.currentTime) ? next.currentTime : 0, duration || Infinity);
  const playing = next.status === "playing";
  const paused = next.status === "paused";
  playbackToggle.textContent = playing ? "Pause" : paused ? "Resume" : "Play";
  playbackToggle.setAttribute("aria-label", playbackToggle.textContent);
  playbackToggle.setAttribute("aria-pressed", String(playing));
  playbackProgress.max = String(duration);
  playbackProgress.value = String(currentTime);
  playbackProgress.disabled = duration <= 0;
  document.querySelector("#playback-time").textContent = `${formatTime(currentTime)} / ${duration ? formatTime(duration) : "0:00"}`;
  playbackRate.value = String(next.playbackRate || appSettings?.defaultPlaybackSpeed || 1);
}

async function refreshPlayback() {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.PLAYBACK_STATE_REQUEST });
  if (response?.ok) renderPlayback(response.state);
}

async function refreshAppState() {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.APP_STATE_REQUEST });
  if (!response?.ok) return;
  appSettings = response.state.settings;
  if (playbackState.status === "idle") playbackRate.value = String(appSettings.defaultPlaybackSpeed);
  if (status.textContent === "Ready.") {
    setStatus(response.state.backend.status === "connected"
      ? `${response.state.backend.mode} backend ready.`
      : "Backend unavailable.", response.state.backend.status === "connected" ? "info" : "error");
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("This page cannot be read.");
  return tab;
}

async function extractSelection(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId }, files: ["content/selection.js"],
    });
    return typeof results[0]?.result === "string" ? results[0].result : "";
  } catch {
    throw new Error("This page does not allow text reading.");
  }
}

async function extractArticle(tabId, codeMode) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId }, files: ["content/article-extractor.js"],
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (mode) => globalThis.__mochiAudioArticleExtractor.extractArticle({ codeMode: mode }),
      args: [codeMode],
    });
    return results[0]?.result?.text || "";
  } catch {
    throw new Error("This page does not allow page extraction.");
  }
}

async function updateArticleEstimate() {
  const text = articleSpeech.value.trim();
  if (!text) {
    document.querySelector("#article-estimate").textContent = "No speech text to read.";
    return;
  }
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.ARTICLE_PREVIEW_ESTIMATE_REQUEST, payload: { text },
  });
  document.querySelector("#article-estimate").textContent = response?.ok
    ? `${response.estimate.inputBytes.toLocaleString()} UTF-8 bytes · ${response.estimate.chunks} chunk(s) · $${(response.estimate.estimatedCostMicrousd / 1_000_000).toFixed(6)} · about ${formatTime(response.estimate.durationSeconds)}`
    : response?.error || "Estimate unavailable.";
}

async function refreshArticleExtraction() {
  articleOriginalText = await extractArticle(articleTabId, appSettings?.skipCode === false ? "literal" : "skip");
  if (!articleOriginalText) throw new Error("No readable page prose was found.");
  articleSpeech.value = speechText(articleOriginalText, appSettings?.dsaNormalization === true);
  await updateArticleEstimate();
}

function updateHoverControl(enabled) {
  hoverEnabled = enabled;
  hoverToggle.setAttribute("aria-pressed", String(enabled));
  hoverToggle.textContent = `Hover mode: ${enabled ? "On" : "Off"}`;
}

function updateInPageControl(enabled) {
  inPageEnabled = enabled;
  inPageToggle.setAttribute("aria-pressed", String(enabled));
  inPageToggle.textContent = `Passage controls: ${enabled ? "On" : "Off"}`;
}

async function sendTabMessage(tabId, message) {
  return chrome.tabs.sendMessage(tabId, { target: "content", ...message });
}

async function injectHoverReader(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/article-extractor.js", "content/hover-target.js", "content/hover-reader.js"],
  });
}

async function injectInPageControls(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["content/in-page-controls.css"] });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [
      "content/article-extractor.js", "content/in-page-targets.js",
      "content/in-page-player-state.js", "content/in-page-controls.js",
    ],
  });
}

async function refreshHoverStatus() {
  try {
    const tab = await getActiveTab();
    const response = await sendTabMessage(tab.id, { type: MESSAGE_TYPES.HOVER_MODE_STATUS_REQUEST });
    updateHoverControl(Boolean(response?.enabled));
  } catch { updateHoverControl(false); }
}

async function refreshInPageStatus() {
  try {
    const tab = await getActiveTab();
    const response = await sendTabMessage(tab.id, { type: MESSAGE_TYPES.IN_PAGE_CONTROLS_STATUS_REQUEST });
    updateInPageControl(Boolean(response?.enabled));
  } catch { updateInPageControl(false); }
}

async function sendPlayback(type, payload, { silent = false } = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type, payload });
    if (!response?.ok) throw new Error(response?.error || "Playback is unavailable.");
    if (response.state) renderPlayback(response.state);
    if (!silent) setStatus(`Playback: ${response.state?.status || "updated"}.`);
    return response;
  } catch (error) {
    if (!silent) setStatus(error.message || "Playback is unavailable.", "error");
    return null;
  }
}

readButton.addEventListener("click", async () => {
  readButton.disabled = true;
  setStatus("Checking the current selection…");
  try {
    const tab = await getActiveTab();
    const text = await extractSelection(tab.id);
    if (!text) throw new Error("Select some text on the page first.");
    setStatus("Generating selection audio…");
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.SELECTION_READ_REQUEST,
      payload: { text, requestId: crypto.randomUUID() },
    });
    if (!response?.ok) throw new Error(response?.error || "The selection could not be read.");
    setStatus(response.usage.warning ? "Playing selection · budget warning." : "Playing selection.",
      response.usage.warning ? "warning" : "info");
    await refreshUsage();
  } catch (error) {
    setStatus(error.message || "The selection could not be read.", "error");
  } finally { readButton.disabled = false; }
});

articleButton.addEventListener("click", async () => {
  articleButton.disabled = true;
  setStatus("Extracting page…");
  try {
    articleTabId = (await getActiveTab()).id;
    await refreshArticleExtraction();
    articlePreview.hidden = false;
    setStatus("Review the extracted text before reading.");
  } catch (error) {
    articlePreview.hidden = true;
    setStatus(error.message || "The page could not be extracted.", "error");
  } finally { articleButton.disabled = false; }
});

articleSpeech.addEventListener("input", () => {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(updateArticleEstimate, 150);
});

document.querySelector("#cancel-article").addEventListener("click", () => {
  articlePreview.hidden = true;
  articleOriginalText = "";
  setStatus("Page preview cancelled.");
});

document.querySelector("#confirm-article").addEventListener("click", async () => {
  const button = document.querySelector("#confirm-article");
  button.disabled = true;
  setStatus("Generating page audio…");
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.ARTICLE_READ_REQUEST,
      payload: { text: articleSpeech.value, requestId: crypto.randomUUID() },
    });
    if (!response?.ok) throw new Error(response?.error || "The page could not be read.");
    articlePreview.hidden = true;
    setStatus("Playing page.");
    await refreshUsage();
  } catch (error) {
    setStatus(error.message || "The page could not be read.", "error");
  } finally { button.disabled = false; }
});

hoverToggle.addEventListener("click", async () => {
  hoverToggle.disabled = true;
  try {
    const tab = await getActiveTab();
    if (hoverEnabled) {
      await sendTabMessage(tab.id, { type: MESSAGE_TYPES.HOVER_MODE_DISABLE });
      updateHoverControl(false);
      setStatus("Hover mode disabled.");
    } else {
      await injectHoverReader(tab.id);
      await sendTabMessage(tab.id, {
        type: MESSAGE_TYPES.HOVER_MODE_ENABLE,
        payload: { minimumLength: appSettings?.minimumHoverLength || HOVER_MINIMUM_LENGTH },
      });
      updateHoverControl(true);
      setStatus("Hover mode enabled.");
    }
  } catch {
    updateHoverControl(false);
    setStatus("This page does not allow hover reading.", "error");
  } finally { hoverToggle.disabled = false; }
});

inPageToggle.addEventListener("click", async () => {
  inPageToggle.disabled = true;
  try {
    const tab = await getActiveTab();
    if (inPageEnabled) {
      await sendTabMessage(tab.id, { type: MESSAGE_TYPES.IN_PAGE_CONTROLS_DISABLE });
      await chrome.scripting.removeCSS({
        target: { tabId: tab.id }, files: ["content/in-page-controls.css"],
      }).catch(() => {});
      updateInPageControl(false);
      setStatus("Passage controls disabled. Audio continues until stopped.");
    } else {
      await injectInPageControls(tab.id);
      await sendTabMessage(tab.id, {
        type: MESSAGE_TYPES.IN_PAGE_CONTROLS_ENABLE,
        payload: {
          minimumLength: appSettings?.minimumHoverLength || HOVER_MINIMUM_LENGTH,
          skipCode: appSettings?.skipCode !== false,
        },
      });
      updateInPageControl(true);
      setStatus("Passage controls enabled on this tab.");
    }
  } catch {
    updateInPageControl(false);
    setStatus("This page does not allow passage controls.", "error");
  } finally { inPageToggle.disabled = false; }
});

playbackToggle.addEventListener("click", () => {
  const type = playbackState.status === "playing"
    ? MESSAGE_TYPES.PLAYBACK_PAUSE
    : playbackState.status === "paused"
      ? MESSAGE_TYPES.PLAYBACK_RESUME
      : MESSAGE_TYPES.PLAYBACK_PLAY;
  sendPlayback(type);
});

document.querySelector("#playback-stop").addEventListener("click", () =>
  sendPlayback(MESSAGE_TYPES.PLAYBACK_STOP));

document.querySelectorAll("[data-queue]").forEach((button) => {
  button.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({ type: button.dataset.queue });
    setStatus(response?.ok ? "Queue updated." : response?.error || "Queue is unavailable.",
      response?.ok ? "info" : "error");
  });
});

playbackProgress.addEventListener("change", () => sendPlayback(MESSAGE_TYPES.PLAYBACK_SEEK, {
  deltaSeconds: Number(playbackProgress.value) - (playbackState.currentTime || 0),
}));

playbackRate.addEventListener("change", () => sendPlayback(MESSAGE_TYPES.PLAYBACK_RATE_SET, {
  rate: Number(playbackRate.value),
}));

document.querySelector("#open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.querySelector("#open-history").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("history/history.html") });
});

document.querySelector("#override-once").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.BUDGET_OVERRIDE_ONCE });
  budgetWarning.hidden = true;
  setStatus(response?.ok ? "One generation may exceed the limit." : "Override unavailable.",
    response?.ok ? "info" : "error");
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MESSAGE_TYPES.PLAYBACK_STATE_CHANGED) renderPlayback(message.payload);
  return false;
});

refreshHoverStatus();
refreshInPageStatus();
refreshPlayback().catch(() => {});
refreshUsage().catch(() => {});
refreshAppState().catch(() => setStatus("Backend unavailable.", "error"));
