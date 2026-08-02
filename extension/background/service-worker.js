import { requestMockAudio } from "../shared/backend-client.js";
import {
  MESSAGE_TYPES,
  validateSelectionReadMessage,
} from "../shared/messages.js";

const CONTEXT_MENU_ID = "read-with-fish-study-reader";
const OFFSCREEN_PATH = "offscreen/offscreen.html";
let creatingOffscreenDocument;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "Read with Fish Study Reader",
      contexts: ["selection"],
    });
  });
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) {
    return;
  }
  const text = typeof info.selectionText === "string" ? info.selectionText.trim() : "";
  if (!text) {
    return;
  }
  readAndPlay({ text, requestId: crypto.randomUUID() }).catch((error) => {
    console.error("Selection read failed:", error.message);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MESSAGE_TYPES.SELECTION_READ_REQUEST) {
    return false;
  }
  const validationError = validateSelectionReadMessage(message);
  if (validationError) {
    sendResponse({ ok: false, error: validationError });
    return false;
  }

  readAndPlay(message.payload)
    .then((usage) => sendResponse({ ok: true, usage }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (existing.length === 0) {
    if (!creatingOffscreenDocument) {
      creatingOffscreenDocument = chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Play generated study-reader audio after the popup closes.",
      });
    }
    try {
      await creatingOffscreenDocument;
    } finally {
      creatingOffscreenDocument = undefined;
    }
  }
}

function arrayBufferToDataUrl(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

async function readAndPlay(payload) {
  const result = await requestMockAudio(payload);
  await ensureOffscreenDocument();
  const playback = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: MESSAGE_TYPES.PLAYBACK_LOAD,
    payload: {
      requestId: payload.requestId,
      audioUrl: arrayBufferToDataUrl(result.audio),
    },
  });
  if (!playback?.ok) {
    throw new Error(playback?.error || "Audio playback failed.");
  }
  return result.usage;
}
