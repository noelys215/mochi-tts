import { MESSAGE_TYPES } from "../shared/messages.js";

const readButton = document.querySelector("#read-selection");
const hoverToggle = document.querySelector("#hover-toggle");
const playbackRate = document.querySelector("#playback-rate");
const status = document.querySelector("#status");
const HOVER_MINIMUM_LENGTH = 40;
let hoverEnabled = false;

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
}

async function refreshUsage() {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.USAGE_STATE_REQUEST });
  if (response?.ok) renderUsage(response.state);
}

function setStatus(message) {
  status.textContent = message;
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

function updateHoverControl(enabled) {
  hoverEnabled = enabled;
  hoverToggle.setAttribute("aria-pressed", String(enabled));
  hoverToggle.textContent = enabled ? "Disable hover mode" : "Enable hover mode";
}

async function sendTabMessage(tabId, message) {
  return chrome.tabs.sendMessage(tabId, { target: "content", ...message });
}

async function injectHoverReader(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/hover-target.js", "content/hover-reader.js"],
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
      : "Playing selection.");
    await refreshUsage();
  } catch (error) {
    setStatus(error.message || "The selection could not be read.");
  } finally {
    readButton.disabled = false;
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
        payload: { minimumLength: HOVER_MINIMUM_LENGTH },
      });
      updateHoverControl(true);
      setStatus("Hover mode enabled. Press Escape to disable it.");
    }
  } catch {
    updateHoverControl(false);
    setStatus("This page does not allow hover reading.");
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
    setStatus(response?.ok ? "Queue updated." : response?.error || "Queue is unavailable.");
  });
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
  link.download = "fish-study-reader-usage.json";
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
