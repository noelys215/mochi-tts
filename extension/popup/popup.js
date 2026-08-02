import { MESSAGE_TYPES } from "../shared/messages.js";
import { speechText } from "../shared/dsa-normalizer.js";

const readButton = document.querySelector("#read-selection");
const articleButton = document.querySelector("#read-article");
const passageHoverToggle = document.querySelector("#passage-hover-toggle");
const articlePreview = document.querySelector("#article-preview");
const articleSpeech = document.querySelector("#article-speech");
const playbackToggle = document.querySelector("#playback-toggle");
const playbackProgress = document.querySelector("#playback-progress");
const playbackRate = document.querySelector("#playback-rate");
const status = document.querySelector("#status");
const budgetWarning = document.querySelector("#budget-warning");
const HOVER_MINIMUM_LENGTH = 40;
let passageHoverEnabled = false;
let appSettings;
let articleOriginalText = "";
let articleTabId = null;
let articleGenerationId = null;
let estimateTimer;
let playbackState = {
  status: "idle", requestId: null, currentTime: 0, duration: 0, playbackRate: 1,
};
let playbackView = { session: { ownsPlayback: false, otherTabActive: false }, playback: playbackState };

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

function renderPlayback(view) {
  if (!view) return;
  const next = view.playback || view;
  playbackView = view.playback ? view : { session: { ownsPlayback: true, otherTabActive: false }, playback: next };
  playbackState = next;
  const generation = playbackView.generation || { status: "idle" };
  const generating = ["validating", "generating", "buffering"].includes(generation.status);
  const generationBlocking = generating || generation.status === "awaiting-confirmation";
  const generationStatus = document.querySelector("#generation-status");
  generationStatus.hidden = !generating;
  document.querySelector("#generation-status-text").textContent = generation.otherTabGenerating
    ? "Audio is being prepared in another tab"
    : `Preparing ${generation.sourceType === "page" ? "page" : generation.sourceType === "selection" ? "selected text" : "passage"} audio…`;
  document.querySelector("#cancel-generation").textContent = generation.otherTabGenerating ? "Cancel other request" : "Cancel";
  readButton.disabled = generationBlocking;
  articleButton.disabled = generationBlocking;
  const otherTabActive = playbackView.session?.otherTabActive === true;
  document.querySelector("#playback-owner-controls").hidden = otherTabActive;
  document.querySelector("#other-playback-status").hidden = !otherTabActive;
  document.querySelector("#stop-other-playback").hidden = !otherTabActive;
  if (otherTabActive) setStatus("Audio is playing in another tab.");
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
  playbackToggle.disabled = generating && next.status === "idle";
  document.querySelectorAll("[data-queue]").forEach((button) => { button.disabled = generating; });
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
      target: { tabId }, files: ["content/article-extractor.js", "content/content-region.js"],
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

function updatePassageHoverControl(enabled) {
  passageHoverEnabled = enabled;
  passageHoverToggle.setAttribute("aria-pressed", String(enabled));
  passageHoverToggle.textContent = `Passage hover controls: ${enabled ? "On" : "Off"}`;
}

async function sendTabMessage(tabId, message) {
  return chrome.tabs.sendMessage(tabId, { target: "content", ...message });
}

async function injectPassageHoverControls(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["content/in-page-controls.css"] });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [
      "content/article-extractor.js", "content/content-region.js", "content/in-page-targets.js",
      "content/in-page-player-state.js", "content/in-page-controls.js",
    ],
  });
}

async function refreshPassageHoverStatus() {
  try {
    const tab = await getActiveTab();
    const response = await sendTabMessage(tab.id, { type: MESSAGE_TYPES.PASSAGE_HOVER_CONTROLS_STATUS_REQUEST });
    updatePassageHoverControl(Boolean(response?.enabled));
  } catch { updatePassageHoverControl(false); }
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
    const tab = await getActiveTab();
    articleTabId = tab.id;
    articleGenerationId = crypto.randomUUID();
    const prepared = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.GENERATION_PREPARE_REQUEST,
      payload: { requestId: articleGenerationId, sourceType: "page", pageUrl: tab.url },
    });
    if (!prepared?.ok) throw new Error(prepared?.error || "Another request is already active.");
    await refreshArticleExtraction();
    await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.GENERATION_AWAIT_CONFIRMATION,
      payload: { requestId: articleGenerationId, sourceType: "page", pageUrl: tab.url },
    });
    articlePreview.hidden = false;
    setStatus("Review the extracted text before reading.");
  } catch (error) {
    if (articleGenerationId) await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.GENERATION_CANCEL, payload: { requestId: articleGenerationId },
    }).catch(() => {});
    articleGenerationId = null;
    articlePreview.hidden = true;
    setStatus(error.message || "The page could not be extracted.", "error");
  } finally { await refreshPlayback(); }
});

articleSpeech.addEventListener("input", () => {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(updateArticleEstimate, 150);
});

document.querySelector("#cancel-article").addEventListener("click", async () => {
  articlePreview.hidden = true;
  articleOriginalText = "";
  if (articleGenerationId) await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.GENERATION_CANCEL, payload: { requestId: articleGenerationId },
  }).catch(() => {});
  articleGenerationId = null;
  setStatus("Page preview cancelled.");
});

document.querySelector("#cancel-generation").addEventListener("click", async () => {
  const generation = playbackView.generation || {};
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.GENERATION_CANCEL,
    payload: {
      requestId: generation.requestId || undefined,
      global: generation.otherTabGenerating === true,
    },
  });
  setStatus(response?.ok ? "Generation cancelled." : response?.error || "Generation could not be cancelled.",
    response?.ok ? "info" : "error");
  await refreshPlayback();
});

document.querySelector("#confirm-article").addEventListener("click", async () => {
  const button = document.querySelector("#confirm-article");
  button.disabled = true;
  setStatus("Generating page audio…");
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.ARTICLE_READ_REQUEST,
      payload: { text: articleSpeech.value, requestId: articleGenerationId || crypto.randomUUID() },
    });
    if (!response?.ok) throw new Error(response?.error || "The page could not be read.");
    articlePreview.hidden = true;
    articleGenerationId = null;
    setStatus("Playing page.");
    await refreshUsage();
  } catch (error) {
    setStatus(error.message || "The page could not be read.", "error");
  } finally { button.disabled = false; }
});

passageHoverToggle.addEventListener("click", async () => {
  passageHoverToggle.disabled = true;
  try {
    const tab = await getActiveTab();
    if (passageHoverEnabled) {
      await sendTabMessage(tab.id, { type: MESSAGE_TYPES.PASSAGE_HOVER_CONTROLS_DISABLE });
      await chrome.scripting.removeCSS({
        target: { tabId: tab.id }, files: ["content/in-page-controls.css"],
      }).catch(() => {});
      updatePassageHoverControl(false);
      setStatus("Passage hover controls disabled. Audio continues until stopped.");
    } else {
      await injectPassageHoverControls(tab.id);
      await sendTabMessage(tab.id, {
        type: MESSAGE_TYPES.PASSAGE_HOVER_CONTROLS_ENABLE,
        payload: {
          minimumLength: appSettings?.minimumHoverLength || HOVER_MINIMUM_LENGTH,
          skipCode: appSettings?.skipCode !== false,
        },
      });
      updatePassageHoverControl(true);
      setStatus("Passage hover controls enabled on this tab.");
    }
  } catch {
    updatePassageHoverControl(false);
    setStatus("This page does not allow passage hover controls.", "error");
  } finally { passageHoverToggle.disabled = false; }
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

document.querySelector("#stop-other-playback").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.PLAYBACK_SESSION_STOP });
  setStatus(response?.ok ? "Other playback stopped." : response?.error || "Playback could not be stopped.",
    response?.ok ? "info" : "error");
  await refreshPlayback();
});

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

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === MESSAGE_TYPES.TAB_PLAYBACK_STATE_CHANGED ||
      message?.type === MESSAGE_TYPES.PLAYBACK_STATE_CHANGED) refreshPlayback().catch(() => {});
  if (message?.type === MESSAGE_TYPES.PASSAGE_HOVER_CONTROLS_STATUS_CHANGED && sender.tab?.id) {
    getActiveTab().then((tab) => {
      if (tab.id === sender.tab.id) updatePassageHoverControl(message.payload?.enabled === true);
    }).catch(() => {});
  }
  return false;
});

globalThis.__mochiAudioPopupRefreshPlayback = refreshPlayback;

refreshPassageHoverStatus();
refreshPlayback().catch(() => {});
refreshUsage().catch(() => {});
refreshAppState().catch(() => setStatus("Backend unavailable.", "error"));
