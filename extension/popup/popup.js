import { MESSAGE_TYPES } from "../shared/messages.js";

const readButton = document.querySelector("#read-selection");
const status = document.querySelector("#status");

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

readButton.addEventListener("click", async () => {
  readButton.disabled = true;
  setStatus("Checking the current selection…");
  try {
    const tab = await getActiveTab();
    const text = await extractSelection(tab.id);
    if (!text) {
      throw new Error("Select some text on the page first.");
    }

    setStatus("Generating mock audio…");
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
