import { MESSAGE_TYPES } from "../shared/messages.js";
import { speechText } from "../shared/dsa-normalizer.js";

const readButton = document.querySelector("#read-selection");
const hoverToggle = document.querySelector("#hover-toggle");
const articleButton = document.querySelector("#read-article");
const articlePreview = document.querySelector("#article-preview");
const articleSpeech = document.querySelector("#article-speech");
const playbackRate = document.querySelector("#playback-rate");
const status = document.querySelector("#status");
const HOVER_MINIMUM_LENGTH = 40;
let hoverEnabled = false;
let appSettings;
let articleOriginalText = "";
let articleTabId = null;
let estimateTimer;

function formatUsage(value) {
  return `${value.inputBytes.toLocaleString()} bytes · $${(value.estimatedCostMicrousd / 1_000_000).toFixed(6)}`;
}

function renderUsage(state) {
  document.querySelector("#usage-current").textContent = state.aggregates.current
    ? formatUsage(state.aggregates.current)
    : "—";
  document.querySelector("#usage-today").textContent = formatUsage(state.aggregates.today);
  document.querySelector("#usage-month").textContent = formatUsage(state.aggregates.month);
  const settings = state.settings;
  document.querySelector("#pricing-mode").value = settings.pricingMode;
  document.querySelector("#custom-price").value = settings.customPricePerMillionBytes;
  document.querySelector("#monthly-limit").value = settings.monthlyLimitMicrousd / 1_000_000;
  document.querySelector("#warning-threshold").value = settings.warningThresholdPercent;
  document.querySelector("#hard-stop").checked = settings.hardStop;
  document.querySelector("#budget-status").textContent = settings.monthlyLimitMicrousd
    ? `${settings.pricingMode} · $${(settings.monthlyLimitMicrousd / 1_000_000).toFixed(2)} limit`
    : `${settings.pricingMode} · no limit`;
  const history = document.querySelector("#recent-history");
  history.replaceChildren(...(state.records.length
    ? state.records.slice(-3).reverse().map((record) => {
      const item = document.createElement("li");
      item.textContent = `${record.source} · ${record.inputBytes} bytes · $${(record.estimatedCostMicrousd / 1_000_000).toFixed(6)}`;
      return item;
    })
    : [Object.assign(document.createElement("li"), { textContent: "No generated requests yet." })]));
}

async function refreshUsage() {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.USAGE_STATE_REQUEST });
  if (response?.ok) renderUsage(response.state);
}

function setStatus(message, kind = "info") {
  status.textContent = message;
  status.dataset.kind = kind;
  status.setAttribute("role", kind === "error" ? "alert" : "status");
}

function setCurrentText(source, text) {
  document.querySelector("#source-status").textContent = source;
  document.querySelector("#preview-status").textContent = text.length > 42
    ? `${text.slice(0, 39)}…`
    : text;
}

function renderQueue(queue) {
  const current = queue.currentIndex;
  document.querySelector("#queue-status").textContent = queue.entries.length
    ? `${current + 1} of ${queue.entries.length} · ${queue.entries[current]?.status || "pending"}`
    : "Empty";
}

async function refreshAppState() {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.APP_STATE_REQUEST });
  if (!response?.ok) return;
  appSettings = response.state.settings;
  renderQueue(response.state.queue);
  const activeEntry = response.state.queue.entries[response.state.queue.currentIndex];
  const currentUsage = response.state.aggregates.current;
  if (activeEntry || currentUsage) {
    document.querySelector("#source-status").textContent = activeEntry?.source || currentUsage.source;
    document.querySelector("#preview-status").textContent = activeEntry
      ? "Current queued passage"
      : "Text not retained";
  }
  document.querySelector("#backend-status").textContent = response.state.backend.status === "connected"
    ? `${response.state.backend.mode} · connected`
    : "Unavailable";
  document.querySelector("#budget-status").textContent = appSettings.monthlyLimitMicrousd
    ? `${appSettings.pricingMode} · $${(appSettings.monthlyLimitMicrousd / 1_000_000).toFixed(2)} limit`
    : `${appSettings.pricingMode} · no limit`;
  playbackRate.value = String(appSettings.defaultPlaybackSpeed);
  document.querySelector("#article-code-mode").value = appSettings.skipCode ? "skip" : "literal";
  document.querySelector("#normalize-dsa").checked = appSettings.dsaNormalization;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("This page cannot be read.");
  }
  return tab;
}

async function extractSelection(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/selection.js"],
    });
    return typeof results[0]?.result === "string" ? results[0].result : "";
  } catch {
    throw new Error("This page does not allow text reading.");
  }
}

async function extractArticle(tabId, codeMode) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/article-extractor.js"],
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (mode) => globalThis.__mochiAudioArticleExtractor.extractArticle({ codeMode: mode }),
      args: [codeMode],
    });
    return results[0]?.result?.text || "";
  } catch {
    throw new Error("This page does not allow article extraction.");
  }
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

async function updateArticleEstimate() {
  const text = articleSpeech.value.trim();
  if (!text) {
    document.querySelector("#article-estimate").textContent = "No speech text to read.";
    return;
  }
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.ARTICLE_PREVIEW_ESTIMATE_REQUEST,
    payload: { text },
  });
  document.querySelector("#article-estimate").textContent = response?.ok
    ? `${response.estimate.inputBytes.toLocaleString()} UTF-8 bytes · ${response.estimate.chunks} chunk(s) · $${(response.estimate.estimatedCostMicrousd / 1_000_000).toFixed(6)} · about ${formatDuration(response.estimate.durationSeconds)}`
    : response?.error || "Estimate unavailable.";
}

function renderArticleSpeech() {
  articleSpeech.value = speechText(
    articleOriginalText,
    document.querySelector("#normalize-dsa").checked,
  );
  updateArticleEstimate();
}

async function refreshArticleExtraction() {
  articleOriginalText = await extractArticle(
    articleTabId,
    document.querySelector("#article-code-mode").value,
  );
  if (!articleOriginalText) throw new Error("No readable article prose was found.");
  document.querySelector("#article-original").textContent = articleOriginalText;
  renderArticleSpeech();
}

function updateHoverControl(enabled) {
  hoverEnabled = enabled;
  hoverToggle.setAttribute("aria-pressed", String(enabled));
  hoverToggle.textContent = enabled ? "Disable hover mode" : "Enable hover mode";
  document.querySelector("#hover-status").textContent = enabled ? "On" : "Off";
}

async function sendTabMessage(tabId, message) {
  return chrome.tabs.sendMessage(tabId, { target: "content", ...message });
}

async function injectHoverReader(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [
      "content/article-extractor.js",
      "content/hover-target.js",
      "content/hover-reader.js",
    ],
  });
}

async function refreshHoverStatus() {
  try {
    const tab = await getActiveTab();
    const response = await sendTabMessage(tab.id, {
      type: MESSAGE_TYPES.HOVER_MODE_STATUS_REQUEST,
    });
    updateHoverControl(Boolean(response?.enabled));
  } catch {
    updateHoverControl(false);
  }
}

async function sendPlayback(type, payload, { silent = false } = {}) {
  try {
    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type,
      payload,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Playback is unavailable.");
    }
    const playback = response.state;
    if (playback) {
      playbackRate.value = String(playback.playbackRate);
      setStatus(`Playback: ${playback.status}.`);
    }
  } catch (error) {
    if (!silent) {
      setStatus(error.message || "Playback is unavailable.");
    }
  }
}

readButton.addEventListener("click", async () => {
  readButton.disabled = true;
  setStatus("Checking the current selection…");
  try {
    const tab = await getActiveTab();
    const text = await extractSelection(tab.id);
    if (!text) {
      throw new Error("Select some text on the page first.");
    }
    setCurrentText("Selection", text);

    setStatus("Generating audio…");
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.SELECTION_READ_REQUEST,
      payload: { text, requestId: crypto.randomUUID() },
    });
    if (!response?.ok) {
      throw new Error(response?.error || "The selection could not be read.");
    }
    setStatus(response.usage.warning
      ? "Playing selection. Monthly usage is above your warning threshold."
      : "Playing selection.", response.usage.warning ? "warning" : "info");
    await refreshUsage();
    await refreshAppState();
  } catch (error) {
    setStatus(error.message || "The selection could not be read.", "error");
  } finally {
    readButton.disabled = false;
  }
});

articleButton.addEventListener("click", async () => {
  articleButton.disabled = true;
  setStatus("Extracting article…");
  try {
    articleTabId = (await getActiveTab()).id;
    await refreshArticleExtraction();
    setCurrentText("Article", articleOriginalText);
    articlePreview.hidden = false;
    setStatus("Review and edit the preview before confirming.");
  } catch (error) {
    articlePreview.hidden = true;
    setStatus(error.message || "The article could not be extracted.", "error");
  } finally {
    articleButton.disabled = false;
  }
});

document.querySelector("#article-code-mode").addEventListener("change", async () => {
  try { await refreshArticleExtraction(); } catch (error) { setStatus(error.message); }
});

document.querySelector("#normalize-dsa").addEventListener("change", renderArticleSpeech);

articleSpeech.addEventListener("input", () => {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(updateArticleEstimate, 150);
});

document.querySelector("#cancel-article").addEventListener("click", () => {
  articlePreview.hidden = true;
  articleOriginalText = "";
  setStatus("Article preview cancelled.");
});

document.querySelector("#confirm-article").addEventListener("click", async () => {
  const button = document.querySelector("#confirm-article");
  button.disabled = true;
  setStatus("Generating article audio…");
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.ARTICLE_READ_REQUEST,
      payload: { text: articleSpeech.value, requestId: crypto.randomUUID() },
    });
    if (!response?.ok) throw new Error(response?.error || "The article could not be read.");
    articlePreview.hidden = true;
    setStatus("Playing article.");
    await refreshUsage();
    await refreshAppState();
  } catch (error) {
    setStatus(error.message || "The article could not be read.", "error");
  } finally {
    button.disabled = false;
  }
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
      setStatus("Hover mode enabled. Press Escape to disable it.");
    }
  } catch {
    updateHoverControl(false);
    setStatus("This page does not allow hover reading.", "error");
  } finally {
    hoverToggle.disabled = false;
  }
});

document.querySelectorAll("[data-playback]").forEach((button) => {
  button.addEventListener("click", () => sendPlayback(button.dataset.playback));
});

document.querySelectorAll("[data-queue]").forEach((button) => {
  button.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({ type: button.dataset.queue });
    if (response?.state) renderQueue(response.state);
    setStatus(response?.ok ? "Queue updated." : response?.error || "Queue is unavailable.");
  });
});

document.querySelector("#open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.querySelector("#open-history").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("history/history.html") });
});

document.querySelector("#save-budget").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.USAGE_SETTINGS_UPDATE,
    payload: {
      pricingMode: document.querySelector("#pricing-mode").value,
      customPricePerMillionBytes: Number(document.querySelector("#custom-price").value),
      monthlyLimitMicrousd: Math.round(Number(document.querySelector("#monthly-limit").value) * 1_000_000),
      warningThresholdPercent: Number(document.querySelector("#warning-threshold").value),
      hardStop: document.querySelector("#hard-stop").checked,
    },
  });
  if (response?.ok) renderUsage(response.state);
  setStatus(response?.ok ? "Spending safeguards saved." : "Could not save safeguards.");
});

document.querySelector("#override-once").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.BUDGET_OVERRIDE_ONCE });
  setStatus(response?.ok ? "One generation may exceed the limit." : "Override unavailable.");
});

document.querySelector("#export-usage").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.USAGE_EXPORT_REQUEST });
  if (!response?.ok) return setStatus("Usage export failed.");
  const url = URL.createObjectURL(new Blob([JSON.stringify(response.data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "mochi-audio-usage.json";
  link.click();
  URL.revokeObjectURL(url);
  setStatus("Usage exported.");
});

document.querySelector("#reset-usage").addEventListener("click", async () => {
  if (!window.confirm("Reset all local usage history?")) return;
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.USAGE_RESET });
  if (response?.ok) renderUsage(response.state);
  setStatus(response?.ok ? "Usage reset." : "Usage reset failed.");
});

document.querySelectorAll("[data-seek]").forEach((button) => {
  button.addEventListener("click", () =>
    sendPlayback(MESSAGE_TYPES.PLAYBACK_SEEK, {
      deltaSeconds: Number(button.dataset.seek),
    }),
  );
});

playbackRate.addEventListener("change", () => {
  sendPlayback(MESSAGE_TYPES.PLAYBACK_RATE_SET, {
    rate: Number(playbackRate.value),
  });
});

refreshHoverStatus();
sendPlayback(MESSAGE_TYPES.PLAYBACK_STATE_REQUEST, undefined, { silent: true });
refreshUsage().catch(() => {});
refreshAppState().catch(() => {
  document.querySelector("#backend-status").textContent = "Unavailable";
});
