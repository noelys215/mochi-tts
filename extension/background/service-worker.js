import { createQueueManager } from "./queue-manager.js";
import { requestAudio, requestBackendMetadata } from "../shared/backend-client.js";
import { evaluateBudget, priceForMode } from "../shared/budget.js";
import { chunkText } from "../shared/chunking.js";
import {
  MESSAGE_TYPES,
  validateArticleReadMessage,
  validateHoverPassageReadMessage,
  validateSelectionReadMessage,
} from "../shared/messages.js";
import {
  DEFAULT_USAGE_SETTINGS,
  USAGE_STORAGE_KEYS,
  addUsageRecord,
  aggregateUsage,
  byteLength,
  exportUsage,
  estimateCostMicrousd,
  mergeUsageSettings,
} from "../shared/usage.js";

const CONTEXT_MENU_ID = "read-with-mochi-audio";
const OFFSCREEN_PATH = "offscreen/offscreen.html";
let creatingOffscreenDocument;
let usageMutation = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "Read with Mochi Audio",
    contexts: ["selection"],
  }));
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
});

async function storageState() {
  const value = await chrome.storage.local.get([
    USAGE_STORAGE_KEYS.records,
    USAGE_STORAGE_KEYS.settings,
  ]);
  return {
    records: Array.isArray(value[USAGE_STORAGE_KEYS.records])
      ? value[USAGE_STORAGE_KEYS.records]
      : [],
    settings: mergeUsageSettings(value[USAGE_STORAGE_KEYS.settings] || DEFAULT_USAGE_SETTINGS),
  };
}

function mutateUsage(operation) {
  const result = usageMutation.then(operation, operation);
  usageMutation = result.catch(() => {});
  return result;
}

async function usageSummary() {
  const { records, settings } = await storageState();
  return { records, settings, aggregates: aggregateUsage(records) };
}

async function saveSettings(value) {
  return mutateUsage(async () => {
    const { settings } = await storageState();
    const merged = mergeUsageSettings({ ...settings, ...value });
    await chrome.storage.local.set({ [USAGE_STORAGE_KEYS.settings]: merged });
    return merged;
  });
}

async function recordSuccess(entry, usage, estimate) {
  const record = {
    id: crypto.randomUUID(),
    requestId: usage.requestId,
    timestamp: Date.now(),
    inputBytes: usage.inputBytes,
    estimatedCostMicrousd: estimate.estimatedCostMicrousd,
    pricingMode: estimate.pricingMode,
    model: usage.model,
    source: entry.source,
    status: "success",
  };
  return mutateUsage(async () => {
    const { records } = await storageState();
    const next = addUsageRecord(records, record);
    if (next !== records) {
      await chrome.storage.local.set({ [USAGE_STORAGE_KEYS.records]: next });
    }
    return record;
  });
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url],
  });
  if (existing.length === 0) {
    if (!creatingOffscreenDocument) {
      creatingOffscreenDocument = chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Play generated study-reader audio after the popup closes.",
      });
    }
    try { await creatingOffscreenDocument; } finally { creatingOffscreenDocument = undefined; }
  }
}

function arrayBufferToDataUrl(arrayBuffer, contentType) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

async function sendPlayback(type, payload) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ target: "offscreen", type, payload });
  if (!response?.ok) throw new Error(response?.error || "Audio playback failed.");
  return response;
}

const queue = createQueueManager({
  async generate(entry, signal) {
    const local = await storageState();
    const backend = await requestBackendMetadata({ backendUrl: local.settings.backendUrl });
    const monthCostMicrousd = aggregateUsage(local.records).month.estimatedCostMicrousd;
    const decision = evaluateBudget({
      inputBytes: byteLength(entry.text), monthCostMicrousd,
      settings: local.settings, backend,
    });
    if (!decision.allowed) throw new Error(decision.reason);
    if (decision.consumeOverride) await saveSettings({ oneTimeOverride: false });
    const result = await requestAudio({
      text: entry.text,
      requestId: entry.requestId,
      backendUrl: local.settings.backendUrl,
      signal,
    });
    const estimate = {
      estimatedCostMicrousd: local.settings.pricingMode === "custom"
        ? decision.estimatedCostMicrousd
        : result.usage.estimatedCostMicrousd,
      pricingMode: local.settings.pricingMode === "custom"
        ? "custom-estimate"
        : result.usage.pricingMode,
    };
    await recordSuccess(entry, result.usage, estimate);
    return {
      audioUrl: arrayBufferToDataUrl(result.audio, result.contentType),
      usage: { ...result.usage, ...estimate, warning: decision.warning },
    };
  },
  play: async (entry) => {
    const { settings } = await storageState();
    await sendPlayback(MESSAGE_TYPES.PLAYBACK_RATE_SET, {
      rate: settings.defaultPlaybackSpeed,
    });
    return sendPlayback(MESSAGE_TYPES.PLAYBACK_LOAD, {
      requestId: entry.requestId, audioUrl: entry.audioUrl,
    });
  },
  stop: async () => {
    try { await sendPlayback(MESSAGE_TYPES.PLAYBACK_STOP); } catch { /* Nothing loaded yet. */ }
  },
});

async function readAndPlay(payload, source) {
  const local = await storageState();
  const backend = await requestBackendMetadata({ backendUrl: local.settings.backendUrl });
  return queue.load({
    ...payload,
    source,
    maxBytes: Math.min(backend.maxInputBytes, local.settings.chunkLimit),
  });
}

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  const text = typeof info.selectionText === "string" ? info.selectionText.trim() : "";
  if (text) readAndPlay({ text, requestId: crypto.randomUUID() }, "context-menu")
    .catch((error) => console.error("Selection read failed:", error.message));
});

const queueHandlers = {
  [MESSAGE_TYPES.QUEUE_STATE_REQUEST]: () => queue.state(),
  [MESSAGE_TYPES.QUEUE_NEXT]: () => queue.next(),
  [MESSAGE_TYPES.QUEUE_PREVIOUS]: () => queue.previous(),
  [MESSAGE_TYPES.QUEUE_STOP]: () => queue.stop(),
  [MESSAGE_TYPES.QUEUE_CLEAR]: () => queue.clear(),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const isSelection = message?.type === MESSAGE_TYPES.SELECTION_READ_REQUEST;
  const isHover = message?.type === MESSAGE_TYPES.HOVER_PASSAGE_READ;
  const isArticle = message?.type === MESSAGE_TYPES.ARTICLE_READ_REQUEST;
  if (isSelection || isHover || isArticle) {
    if (isHover && !sender.tab?.id) {
      sendResponse({ ok: false, error: "Invalid hover request source." });
      return false;
    }
    const error = isHover
      ? validateHoverPassageReadMessage(message)
      : isArticle
        ? validateArticleReadMessage(message)
        : validateSelectionReadMessage(message);
    if (error) {
      sendResponse({ ok: false, error });
      return false;
    }
    const source = isArticle || (isHover && message.payload.source === "article")
      ? "article"
      : isHover ? "hover" : "selection";
    readAndPlay(message.payload, source)
      .then(({ usage }) => sendResponse({ ok: true, usage }))
      .catch((failure) => sendResponse({ ok: false, error: failure.message }));
    return true;
  }

  if (message?.type === MESSAGE_TYPES.ARTICLE_PREVIEW_ESTIMATE_REQUEST) {
    const text = message.payload?.text;
    if (typeof text !== "string" || !text.trim()) {
      sendResponse({ ok: false, error: "No article text is available." });
      return false;
    }
    storageState().then(async (local) => {
      const backend = await requestBackendMetadata({ backendUrl: local.settings.backendUrl });
      const inputBytes = byteLength(text);
      const price = priceForMode(local.settings, backend);
      sendResponse({
        ok: true,
        estimate: {
          inputBytes,
          chunks: chunkText(text, Math.min(backend.maxInputBytes, local.settings.chunkLimit)).length,
          estimatedCostMicrousd: estimateCostMicrousd(inputBytes, price),
          durationSeconds: Math.max(1, Math.round(text.trim().split(/\s+/u).length / 2.5)),
        },
      });
    }).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === MESSAGE_TYPES.APP_STATE_REQUEST) {
    storageState().then(async ({ records, settings }) => {
      let backend;
      try {
        const metadata = await requestBackendMetadata({ backendUrl: settings.backendUrl });
        backend = { ...metadata, status: "connected" };
      } catch (error) {
        backend = { status: "unavailable", error: error.message };
      }
      sendResponse({
        ok: true,
        state: {
          settings,
          aggregates: aggregateUsage(records),
          queue: queue.state(),
          backend,
        },
      });
    });
    return true;
  }

  if (message?.type === MESSAGE_TYPES.PLAYBACK_ENDED) {
    queue.next().catch(() => {});
    return false;
  }
  if (queueHandlers[message?.type]) {
    Promise.resolve(queueHandlers[message.type]())
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === MESSAGE_TYPES.USAGE_STATE_REQUEST) {
    usageSummary().then((state) => sendResponse({ ok: true, state }));
    return true;
  }
  if (message?.type === MESSAGE_TYPES.USAGE_SETTINGS_UPDATE) {
    saveSettings(message.payload).then(() => usageSummary())
      .then((state) => sendResponse({ ok: true, state }));
    return true;
  }
  if (message?.type === MESSAGE_TYPES.BUDGET_OVERRIDE_ONCE) {
    saveSettings({ oneTimeOverride: true }).then(() => usageSummary())
      .then((state) => sendResponse({ ok: true, state }));
    return true;
  }
  if (message?.type === MESSAGE_TYPES.USAGE_EXPORT_REQUEST) {
    storageState().then(({ records, settings }) =>
      sendResponse({ ok: true, data: exportUsage(records, settings) }));
    return true;
  }
  if (message?.type === MESSAGE_TYPES.USAGE_RESET) {
    mutateUsage(() => chrome.storage.local.set({ [USAGE_STORAGE_KEYS.records]: [] }))
      .then(() => usageSummary()).then((state) => sendResponse({ ok: true, state }));
    return true;
  }
  return false;
});
