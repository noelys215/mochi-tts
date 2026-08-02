import { MESSAGE_TYPES } from "../shared/messages.js";

const readButton = document.querySelector("#read-selection");
const hoverToggle = document.querySelector("#hover-toggle");
const playbackRate = document.querySelector("#playback-rate");
const status = document.querySelector("#status");
const HOVER_MINIMUM_LENGTH = 40;
let hoverEnabled = false;

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
    setStatus("Playing selection.");
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
