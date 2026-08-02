import { createQueueManager } from "./queue-manager.js";
import { createPlaybackSession } from "./playback-session.js";
import { requestAudio, requestBackendMetadata } from "../shared/backend-client.js";
import { evaluateBudget, priceForMode } from "../shared/budget.js";
import { chunkText } from "../shared/chunking.js";
import { speechText } from "../shared/dsa-normalizer.js";
import {
  MESSAGE_TYPES,
  validateArticleReadMessage,
  validateInPageReadMessage,
  validatePlaybackCommand,
  validatePlaybackState,
  validateRegionChangedMessage,
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
const passageHoverTabs = new Set();
const tabRegions = new Map();
const playbackSession = createPlaybackSession();
let latestPlayback = {
  status: "idle", requestId: null, currentTime: 0, duration: 0, playbackRate: 1,
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "Read with Mochi Audio",
    contexts: ["selection"],
  }));
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  passageHoverTabs.delete(tabId);
  tabRegions.delete(tabId);
  if (playbackSession.owns(tabId)) stopPlaybackSession().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const session = playbackSession.snapshot();
  if (!session || session.ownerTabId !== tabId || !changeInfo.url) return;
  if (comparablePageUrl(changeInfo.url) !== comparablePageUrl(session.sourceUrl)) {
    stopPlaybackSession().catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  sendTabPlayerState(tabId).catch(() => {});
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
  if (response.state) latestPlayback = response.state;
  return response;
}

function sharedPlayerState(tabId) {
  return playbackSession.viewFor(tabId, latestPlayback, queue.state());
}

async function restorePlaybackState() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url],
  });
  if (existing.length) {
    const response = await chrome.runtime.sendMessage({
      target: "offscreen", type: MESSAGE_TYPES.PLAYBACK_STATE_REQUEST,
    });
    if (response?.ok) latestPlayback = response.state;
  }
  return { playback: latestPlayback, queue: queue.state() };
}

async function sendTabPlayerState(tabId) {
  if (!passageHoverTabs.has(tabId)) return;
  await chrome.tabs.sendMessage(tabId, {
    target: "content",
    type: MESSAGE_TYPES.TAB_PLAYBACK_STATE_CHANGED,
    payload: sharedPlayerState(tabId),
  });
}

function broadcastPlayerState(additionalTabIds = []) {
  const session = playbackSession.snapshot();
  const recipients = new Set([...passageHoverTabs, ...additionalTabIds]);
  if (session) recipients.add(session.ownerTabId);
  for (const tabId of recipients) {
    chrome.tabs.sendMessage(tabId, {
      target: "content",
      type: MESSAGE_TYPES.TAB_PLAYBACK_STATE_CHANGED,
      payload: sharedPlayerState(tabId),
    }).catch(() => passageHoverTabs.delete(tabId));
  }
  chrome.runtime.sendMessage({ type: MESSAGE_TYPES.TAB_PLAYBACK_STATE_CHANGED }).catch(() => {});
}

const queue = createQueueManager({
  onStateChange: () => broadcastPlayerState(),
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

async function activeTabForExtension(sender) {
  if (sender.tab?.id && Number.isInteger(sender.tab.id)) return sender.tab;
  if (!sender.url?.startsWith(chrome.runtime.getURL(""))) return null;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ? tab : null;
}

async function startOwnedPlayback(payload, sourceType, tab) {
  const previous = playbackSession.snapshot();
  playbackSession.begin({
    tabId: tab.id,
    windowId: tab.windowId,
    sourceUrl: payload.pageUrl || tab.url,
    sourceType,
    queueId: payload.requestId,
    regionId: payload.regionId || null,
  });
  broadcastPlayerState(previous ? [previous.ownerTabId] : []);
  try {
    const result = await readAndPlay(payload, sourceType);
    broadcastPlayerState(previous ? [previous.ownerTabId] : []);
    return result;
  } catch (error) {
    if (playbackSession.owns(tab.id)) playbackSession.clear();
    broadcastPlayerState(previous ? [previous.ownerTabId] : []);
    throw error;
  }
}

async function stopPlaybackSession() {
  const previous = playbackSession.clear();
  await queue.clear();
  broadcastPlayerState(previous ? [previous.ownerTabId] : []);
  return latestPlayback;
}

function comparablePageUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  const text = typeof info.selectionText === "string" ? info.selectionText.trim() : "";
  if (text && tab?.id) startOwnedPlayback({
    text, requestId: crypto.randomUUID(), pageUrl: tab.url,
  }, "context-menu", tab)
    .catch((error) => console.error("Selection read failed:", error.message));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === MESSAGE_TYPES.PLAYBACK_STATE_CHANGED) {
    if (sender.url !== chrome.runtime.getURL(OFFSCREEN_PATH) || validatePlaybackState(message.payload)) return false;
    latestPlayback = message.payload;
    broadcastPlayerState();
    return false;
  }

  if (message?.type === MESSAGE_TYPES.PASSAGE_HOVER_CONTROLS_STATUS_CHANGED) {
    if (!sender.tab?.id || comparablePageUrl(message.payload?.pageUrl) !== comparablePageUrl(sender.tab.url)) {
      sendResponse({ ok: false, error: "Invalid passage-hover controls source." });
      return false;
    }
    if (message.payload.enabled === true) passageHoverTabs.add(sender.tab.id);
    else passageHoverTabs.delete(sender.tab.id);
    sendResponse({ ok: true, enabled: passageHoverTabs.has(sender.tab.id) });
    return false;
  }

  if (message?.type === MESSAGE_TYPES.PRIMARY_CONTENT_REGION_CHANGED) {
    const error = !sender.tab?.id ? "Invalid content-region source." :
      validateRegionChangedMessage(message) ||
      (comparablePageUrl(message.payload.pageUrl) !== comparablePageUrl(sender.tab.url)
        ? "Page URL does not match the sender tab." : null);
    if (error) {
      sendResponse({ ok: false, error });
      return false;
    }
    const previous = tabRegions.get(sender.tab.id);
    tabRegions.set(sender.tab.id, {
      regionId: message.payload.regionId,
      pageUrl: message.payload.pageUrl,
    });
    const session = playbackSession.snapshot();
    if (session?.ownerTabId === sender.tab.id && previous &&
        session.regionId && session.regionId !== message.payload.regionId) {
      stopPlaybackSession().catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === MESSAGE_TYPES.TAB_PLAYBACK_STATE_REQUEST) {
    if (!sender.tab?.id) {
      sendResponse({ ok: false, error: "Invalid player state source." });
      return false;
    }
    passageHoverTabs.add(sender.tab.id);
    restorePlaybackState()
      .then(() => sendResponse({ ok: true, state: sharedPlayerState(sender.tab.id) }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  const isInPageRead = message?.type === MESSAGE_TYPES.PASSAGE_HOVER_READ ||
    message?.type === MESSAGE_TYPES.PAGE_HOVER_READ;
  if (isInPageRead) {
    const error = !sender.tab?.id
      ? "Invalid in-page request source."
      : validateInPageReadMessage(message) ||
        (comparablePageUrl(message.payload.pageUrl) !== comparablePageUrl(sender.tab.url)
          ? "Page URL does not match the sender tab." : null);
    const expectedSource = message.type === MESSAGE_TYPES.PAGE_HOVER_READ ? "page" : "hover-passage";
    if (error || message.payload?.source !== expectedSource) {
      sendResponse({ ok: false, error: error || "Invalid in-page source type." });
      return false;
    }
    passageHoverTabs.add(sender.tab.id);
    storageState().then(({ settings }) => startOwnedPlayback({
      ...message.payload,
      text: speechText(message.payload.text, settings.dsaNormalization),
    }, expectedSource, sender.tab))
      .then(({ usage }) => sendResponse({ ok: true, usage }))
      .catch((failure) => sendResponse({ ok: false, error: failure.message }));
    return true;
  }

  const isTrustedPlaybackSurface = Boolean(sender.tab?.id) || sender.url?.startsWith(chrome.runtime.getURL(""));
  if (isTrustedPlaybackSurface && !message?.target && message?.type === MESSAGE_TYPES.PLAYBACK_STATE_REQUEST) {
    Promise.all([restorePlaybackState(), activeTabForExtension(sender)])
      .then(([, tab]) => sendResponse({ ok: true, state: sharedPlayerState(tab?.id) }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  const isTabPlaybackCommand = isTrustedPlaybackSurface && !message?.target && [
    MESSAGE_TYPES.PLAYBACK_PLAY,
    MESSAGE_TYPES.PLAYBACK_PAUSE,
    MESSAGE_TYPES.PLAYBACK_RESUME,
    MESSAGE_TYPES.PLAYBACK_STOP,
    MESSAGE_TYPES.PLAYBACK_SEEK,
    MESSAGE_TYPES.PLAYBACK_RATE_SET,
    MESSAGE_TYPES.QUEUE_NEXT,
    MESSAGE_TYPES.QUEUE_PREVIOUS,
  ].includes(message?.type);
  if (isTabPlaybackCommand) {
    const isQueueCommand = [MESSAGE_TYPES.QUEUE_NEXT, MESSAGE_TYPES.QUEUE_PREVIOUS].includes(message.type);
    const error = isQueueCommand ? null : validatePlaybackCommand(message);
    if (error) return void sendResponse({ ok: false, error });
    activeTabForExtension(sender).then(async (tab) => {
      if (!tab || !playbackSession.owns(tab.id)) throw new Error("Playback belongs to another tab.");
      if (message.type === MESSAGE_TYPES.PLAYBACK_STOP) await stopPlaybackSession();
      else if (message.type === MESSAGE_TYPES.QUEUE_NEXT) await queue.next();
      else if (message.type === MESSAGE_TYPES.QUEUE_PREVIOUS) await queue.previous();
      else await sendPlayback(message.type, message.payload);
      broadcastPlayerState();
      return { ok: true, state: sharedPlayerState(tab.id) };
    }).then(sendResponse)
      .catch((failure) => sendResponse({ ok: false, error: failure.message }));
    return true;
  }

  if (message?.type === MESSAGE_TYPES.PLAYBACK_SESSION_STOP &&
      sender.url?.startsWith(chrome.runtime.getURL(""))) {
    stopPlaybackSession()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  const isSelection = message?.type === MESSAGE_TYPES.SELECTION_READ_REQUEST;
  const isArticle = message?.type === MESSAGE_TYPES.ARTICLE_READ_REQUEST;
  if (isSelection || isArticle) {
    const error = isArticle ? validateArticleReadMessage(message) : validateSelectionReadMessage(message);
    if (error) {
      sendResponse({ ok: false, error });
      return false;
    }
    const source = isArticle ? "page" : "selection";
    activeTabForExtension(sender).then((tab) => {
      if (!tab) throw new Error("No active page is available for playback.");
      return startOwnedPlayback({ ...message.payload, pageUrl: tab.url }, source, tab);
    })
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
      const decision = evaluateBudget({
        inputBytes,
        monthCostMicrousd: aggregateUsage(local.records).month.estimatedCostMicrousd,
        settings: local.settings,
        backend,
      });
      sendResponse({
        ok: true,
        estimate: {
          inputBytes,
          chunks: chunkText(text, Math.min(backend.maxInputBytes, local.settings.chunkLimit)).length,
          estimatedCostMicrousd: estimateCostMicrousd(inputBytes, price),
          durationSeconds: Math.max(1, Math.round(text.trim().split(/\s+/u).length / 2.5)),
          allowed: decision.allowed,
          warning: Boolean(decision.warning),
          reason: decision.reason || null,
        },
      });
    }).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === MESSAGE_TYPES.APP_STATE_REQUEST) {
    Promise.all([storageState(), activeTabForExtension(sender)]).then(async ([{ records, settings }, tab]) => {
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
          queue: sharedPlayerState(tab?.id).queue,
          backend,
        },
      });
    });
    return true;
  }

  if (message?.type === MESSAGE_TYPES.PLAYBACK_ENDED && sender.url === chrome.runtime.getURL(OFFSCREEN_PATH)) {
    queue.next().catch(() => {});
    return false;
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
