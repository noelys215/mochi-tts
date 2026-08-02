import { createQueueManager } from "./queue-manager.js";
import { createPlaybackSession } from "./playback-session.js";
import { createGenerationState } from "./generation-state.js";
import { createFrameRegistry, selectPrimaryFrame, senderFrame } from "./frame-registry.js";
import { requestAudio, requestBackendMetadata } from "../shared/backend-client.js";
import { evaluateBudget, priceForMode } from "../shared/budget.js";
import { chunkText } from "../shared/chunking.js";
import { speechText } from "../shared/dsa-normalizer.js";
import {
  MESSAGE_TYPES,
  validateArticleReadMessage,
  validateGenerationCancelMessage,
  validateGenerationTransitionMessage,
  validateFrameLifecycleMessage,
  validateInPageReadMessage,
  validatePassageHoverControlMessage,
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
const PASSAGE_HOVER_FILES = [
  "content/article-extractor.js", "content/content-region.js", "content/in-page-targets.js",
  "content/in-page-player-state.js", "content/in-page-controls.js",
];
let creatingOffscreenDocument;
let usageMutation = Promise.resolve();
const passageHoverTabs = new Set();
const passageHoverFrames = createFrameRegistry();
const frameRegions = new Map();
const playbackSession = createPlaybackSession();
const generation = createGenerationState();
const GENERATION_TIMEOUT_MS = 45_000;
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
  passageHoverFrames.disable(tabId);
  frameRegions.delete(tabId);
  if (playbackSession.owns(tabId)) stopPlaybackSession().catch(() => {});
  else if (generation.snapshot().ownerTabId === tabId) cancelGeneration(tabId).catch(() => {});
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (!passageHoverFrames.enabled(details.tabId)) return;
  const session = playbackSession.snapshot();
  const activeGeneration = generation.snapshot();
  const ownerNavigated = (session?.ownerTabId === details.tabId &&
      session.ownerFrameId === details.frameId) ||
    (activeGeneration.ownerTabId === details.tabId && activeGeneration.ownerFrameId === details.frameId);
  passageHoverFrames.remove(details.tabId, details.frameId);
  frameRegions.get(details.tabId)?.delete(details.frameId);
  if (ownerNavigated) stopPlaybackSession().catch(() => {});
  injectPassageHoverControls(details.tabId, { frameIds: [details.frameId] },
    passageHoverFrames.options(details.tabId)).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const session = playbackSession.snapshot();
  const activeGeneration = generation.snapshot();
  if (!changeInfo.url) return;
  if (session?.ownerTabId === tabId && comparablePageUrl(changeInfo.url) !== comparablePageUrl(session.sourceUrl)) {
    stopPlaybackSession().catch(() => {});
  } else if (activeGeneration.ownerTabId === tabId) {
    cancelGeneration(tabId).catch(() => {});
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

function sharedPlayerState(tabId, frameId) {
  return {
    ...playbackSession.viewFor(tabId, latestPlayback, queue.state(), frameId),
    generation: generation.viewFor(tabId, frameId),
  };
}

async function injectPassageHoverControls(tabId, target = { allFrames: true }, options = {}) {
  const injectionTarget = { tabId, ...target };
  await chrome.scripting.insertCSS({
    target: injectionTarget, files: ["content/in-page-controls.css"],
  }).catch(() => {});
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: injectionTarget, files: PASSAGE_HOVER_FILES,
    });
  } catch (error) {
    if (!target.allFrames) throw error;
    results = await chrome.scripting.executeScript({
      target: { tabId }, files: PASSAGE_HOVER_FILES,
    });
  }
  const frames = [];
  for (const frameId of [...new Set(results.map((result) => result.frameId))]) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        target: "content", type: MESSAGE_TYPES.PASSAGE_HOVER_CONTROLS_ENABLE, payload: options,
      }, { frameId });
      if (!response?.ok) continue;
      const metadata = response.region ? {
        frameId, hasReadableContent: true, ...response.region,
      } : { frameId, hasReadableContent: false, confidence: 0 };
      passageHoverFrames.register(tabId, frameId, metadata);
      frames.push(metadata);
    } catch { /* A frame can become unavailable during injection. */ }
  }
  return { frames, primaryFrame: selectPrimaryFrame(frames) };
}

async function enablePassageHoverTab(tabId, options = {}) {
  passageHoverTabs.add(tabId);
  passageHoverFrames.enable(tabId, options);
  let result;
  try {
    result = await injectPassageHoverControls(tabId, { allFrames: true }, options);
    if (!result.frames.length) throw new Error("No scriptable frames were found.");
  } catch (error) {
    passageHoverTabs.delete(tabId);
    passageHoverFrames.disable(tabId);
    await chrome.scripting.removeCSS({
      target: { tabId, allFrames: true }, files: ["content/in-page-controls.css"],
    }).catch(() => {});
    throw error;
  }
  chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.PASSAGE_HOVER_CONTROLS_STATUS_CHANGED,
    payload: { tabId, enabled: true },
  }).catch(() => {});
  return { ok: true, enabled: true, ...result };
}

async function disablePassageHoverTab(tabId) {
  const frameIds = passageHoverFrames.frames(tabId);
  passageHoverTabs.delete(tabId);
  passageHoverFrames.disable(tabId);
  frameRegions.delete(tabId);
  await Promise.allSettled(frameIds.map((frameId) => chrome.tabs.sendMessage(tabId, {
    target: "content", type: MESSAGE_TYPES.PASSAGE_HOVER_CONTROLS_DISABLE,
  }, { frameId })));
  await chrome.scripting.removeCSS({
    target: { tabId, allFrames: true }, files: ["content/in-page-controls.css"],
  }).catch(() => {});
  chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.PASSAGE_HOVER_CONTROLS_STATUS_CHANGED,
    payload: { tabId, enabled: false },
  }).catch(() => {});
  return { ok: true, enabled: false };
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
  await Promise.allSettled(passageHoverFrames.frames(tabId).map((frameId) =>
    chrome.tabs.sendMessage(tabId, {
      target: "content",
      type: MESSAGE_TYPES.TAB_PLAYBACK_STATE_CHANGED,
      payload: sharedPlayerState(tabId, frameId),
    }, { frameId })));
}

function broadcastPlayerState(additionalTabIds = []) {
  const session = playbackSession.snapshot();
  const activeGeneration = generation.snapshot();
  const recipients = new Set([...passageHoverTabs, ...additionalTabIds]);
  if (session) recipients.add(session.ownerTabId);
  if (activeGeneration.ownerTabId) recipients.add(activeGeneration.ownerTabId);
  for (const tabId of recipients) {
    sendTabPlayerState(tabId).catch(() => {});
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
    if (signal.aborted) throw new DOMException("Generation was cancelled.", "AbortError");
    const estimate = {
      estimatedCostMicrousd: local.settings.pricingMode === "custom"
        ? decision.estimatedCostMicrousd
        : result.usage.estimatedCostMicrousd,
      pricingMode: local.settings.pricingMode === "custom"
        ? "custom-estimate"
        : result.usage.pricingMode,
    };
    await recordSuccess(entry, result.usage, estimate);
    if (signal.aborted) throw new DOMException("Generation was cancelled.", "AbortError");
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

async function readAndPlay(payload, source, isActive = () => true) {
  const local = await storageState();
  const backend = await requestBackendMetadata({ backendUrl: local.settings.backendUrl });
  if (!isActive()) throw new DOMException("Generation was cancelled.", "AbortError");
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

async function readingTabForExtension(sender, payload) {
  const isExtensionPage = sender.url?.startsWith(chrome.runtime.getURL(""));
  if (isExtensionPage && payload?.tabId) return chrome.tabs.get(payload.tabId);
  return activeTabForExtension(sender);
}

async function startOwnedPlayback(payload, sourceType, tab, frameId = 0) {
  const existingGeneration = generation.snapshot();
  const continuingConfirmation = existingGeneration.requestId === payload.requestId &&
    existingGeneration.ownerTabId === tab.id && existingGeneration.ownerFrameId === frameId &&
    existingGeneration.status === "awaiting-confirmation";
  const accepted = continuingConfirmation ? { ok: true } : generation.begin({
      requestId: payload.requestId, ownerTabId: tab.id, ownerFrameId: frameId, sourceType,
      sourceLabel: sourceType === "page" ? "Page" : sourceType === "selection" ? "Selected text" : "Passage",
    });
  if (!accepted.ok) {
    const error = new Error("Audio is still being prepared. Cancel it before starting another passage.");
    error.code = accepted.code;
    error.activeRequestId = accepted.activeRequestId;
    throw error;
  }
  generation.transition(payload.requestId, "generating");
  const previous = playbackSession.snapshot();
  playbackSession.begin({
    tabId: tab.id,
    frameId,
    windowId: tab.windowId,
    sourceUrl: payload.pageUrl || tab.url,
    sourceType,
    queueId: payload.requestId,
    regionId: payload.regionId || null,
  });
  broadcastPlayerState(previous ? [previous.ownerTabId] : []);
  let timeout;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(async () => {
        if (!generation.isCurrent(payload.requestId)) return;
        generation.transition(payload.requestId, "failed", { cancellable: false, errorCode: "GENERATION_TIMEOUT" });
        await queue.clear();
        reject(new Error("Audio generation timed out. Try again."));
      }, GENERATION_TIMEOUT_MS);
    });
    const result = await Promise.race([
      readAndPlay(payload, sourceType, () => generation.isCurrent(payload.requestId)),
      timeoutPromise,
    ]);
    if (!generation.isCurrent(payload.requestId)) {
      throw new DOMException("Generation was cancelled.", "AbortError");
    }
    generation.transition(payload.requestId, "ready", { cancellable: false });
    generation.clear(payload.requestId);
    broadcastPlayerState(previous ? [previous.ownerTabId] : []);
    return result;
  } catch (error) {
    if (generation.isCurrent(payload.requestId)) {
      generation.transition(payload.requestId, error.name === "AbortError" ? "cancelled" : "failed", {
        cancellable: false, errorCode: error.name === "AbortError" ? "GENERATION_CANCELLED" : "GENERATION_FAILED",
      });
      generation.clear(payload.requestId);
      if (playbackSession.snapshot()?.queueId === payload.requestId) playbackSession.clear();
    }
    broadcastPlayerState(previous ? [previous.ownerTabId] : []);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function cancelGeneration(requesterTabId, { global = false } = {}) {
  const active = generation.snapshot();
  if (active.status === "idle") return { cancelled: false };
  if (!global && active.ownerTabId !== requesterTabId) throw new Error("Generation belongs to another tab.");
  generation.transition(active.requestId, "cancelled", { cancellable: false, errorCode: null });
  generation.clear(active.requestId);
  if (playbackSession.snapshot()?.queueId === active.requestId) playbackSession.clear();
  await queue.clear();
  broadcastPlayerState([active.ownerTabId]);
  return { cancelled: true };
}

async function stopPlaybackSession() {
  const active = generation.snapshot();
  if (active.status !== "idle") generation.clear(active.requestId);
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
    text, requestId: crypto.randomUUID(), pageUrl: info.frameUrl || tab.url,
  }, "context-menu", tab, Number.isInteger(info.frameId) ? info.frameId : 0)
    .catch((error) => console.error("Selection read failed:", error.message));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === MESSAGE_TYPES.PLAYBACK_STATE_CHANGED) {
    if (sender.url !== chrome.runtime.getURL(OFFSCREEN_PATH) || validatePlaybackState(message.payload)) return false;
    latestPlayback = message.payload;
    broadcastPlayerState();
    return false;
  }

  const isExtensionPage = sender.url?.startsWith(chrome.runtime.getURL(""));
  if (isExtensionPage && [
    MESSAGE_TYPES.PASSAGE_HOVER_CONTROLS_ENABLE,
    MESSAGE_TYPES.PASSAGE_HOVER_CONTROLS_DISABLE,
    MESSAGE_TYPES.PASSAGE_HOVER_CONTROLS_STATUS_REQUEST,
  ].includes(message?.type)) {
    const error = validatePassageHoverControlMessage(message);
    if (error) {
      sendResponse({ ok: false, error });
      return false;
    }
    const tabId = message.payload.tabId;
    if (message.type === MESSAGE_TYPES.PASSAGE_HOVER_CONTROLS_STATUS_REQUEST) {
      sendResponse({ ok: true, enabled: passageHoverFrames.enabled(tabId) });
      return false;
    }
    const operation = message.type === MESSAGE_TYPES.PASSAGE_HOVER_CONTROLS_ENABLE
      ? enablePassageHoverTab(tabId, message.payload.options || {})
      : disablePassageHoverTab(tabId);
    operation.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === MESSAGE_TYPES.PASSAGE_HOVER_CONTROLS_DISABLE && sender.tab?.id) {
    disablePassageHoverTab(sender.tab.id)
      .then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === MESSAGE_TYPES.PASSAGE_HOVER_CONTROLS_STATUS_CHANGED) {
    const frame = senderFrame(sender);
    if (!frame || comparablePageUrl(message.payload?.pageUrl) !== comparablePageUrl(frame.pageUrl)) {
      sendResponse({ ok: false, error: "Invalid passage-hover controls source." });
      return false;
    }
    if (message.payload.enabled === true) {
      passageHoverTabs.add(frame.tabId);
      passageHoverFrames.register(frame.tabId, frame.frameId, null);
    } else passageHoverFrames.remove(frame.tabId, frame.frameId);
    sendResponse({ ok: true, enabled: passageHoverFrames.enabled(frame.tabId) });
    return false;
  }

  if (message?.type === MESSAGE_TYPES.PRIMARY_CONTENT_REGION_CHANGED) {
    const frame = senderFrame(sender);
    const error = !frame ? "Invalid content-region source." :
      validateRegionChangedMessage(message) ||
      (comparablePageUrl(message.payload.pageUrl) !== comparablePageUrl(frame.pageUrl)
        ? "Page URL does not match the sender tab." : null);
    if (error) {
      sendResponse({ ok: false, error });
      return false;
    }
    const regions = frameRegions.get(frame.tabId) || new Map();
    const previous = regions.get(frame.frameId);
    regions.set(frame.frameId, {
      regionId: message.payload.regionId,
      pageUrl: message.payload.pageUrl,
    });
    frameRegions.set(frame.tabId, regions);
    passageHoverFrames.register(frame.tabId, frame.frameId, message.payload.region);
    const session = playbackSession.snapshot();
    if (session?.ownerTabId === frame.tabId && session.ownerFrameId === frame.frameId && previous &&
        session.regionId && session.regionId !== message.payload.regionId) {
      stopPlaybackSession().catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === MESSAGE_TYPES.TAB_PLAYBACK_STATE_REQUEST) {
    const frame = senderFrame(sender);
    if (!frame) {
      sendResponse({ ok: false, error: "Invalid player state source." });
      return false;
    }
    passageHoverTabs.add(frame.tabId);
    passageHoverFrames.register(frame.tabId, frame.frameId, null);
    restorePlaybackState()
      .then(() => sendResponse({ ok: true, state: sharedPlayerState(frame.tabId, frame.frameId) }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === MESSAGE_TYPES.FRAME_LIFECYCLE_ENDED) {
    const frame = senderFrame(sender);
    const error = !frame ? "Invalid frame lifecycle source." :
      validateFrameLifecycleMessage(message) ||
      (comparablePageUrl(message.payload.pageUrl) !== comparablePageUrl(frame.pageUrl)
        ? "Frame URL does not match the sender." : null);
    if (error) return void sendResponse({ ok: false, error });
    passageHoverFrames.remove(frame.tabId, frame.frameId);
    frameRegions.get(frame.tabId)?.delete(frame.frameId);
    const session = playbackSession.snapshot();
    const active = generation.snapshot();
    const ownsSession = session?.ownerTabId === frame.tabId && session.ownerFrameId === frame.frameId;
    const ownsGeneration = active.ownerTabId === frame.tabId && active.ownerFrameId === frame.frameId;
    const cleanup = ownsSession ? stopPlaybackSession() : ownsGeneration ? cancelGeneration(frame.tabId) : Promise.resolve();
    cleanup.then(() => sendResponse({ ok: true })).catch((failure) =>
      sendResponse({ ok: false, error: failure.message }));
    return true;
  }

  if (message?.type === MESSAGE_TYPES.GENERATION_CANCEL) {
    const error = validateGenerationCancelMessage(message);
    if (error) return void sendResponse({ ok: false, error });
    readingTabForExtension(sender, message.payload).then((tab) => {
      const global = message.payload?.global === true && isExtensionPage;
      if (!tab && !global) throw new Error("Invalid generation cancellation source.");
      const active = generation.snapshot();
      if (message.payload?.requestId && message.payload.requestId !== active.requestId) {
        throw new Error("That generation request is no longer active.");
      }
      if (!global && sender.tab?.id && !generation.viewFor(sender.tab.id, sender.frameId).ownsGeneration) {
        throw new Error("Generation belongs to another frame.");
      }
      return cancelGeneration(tab?.id, { global });
    }).then((result) => sendResponse({ ok: true, ...result }))
      .catch((failure) => sendResponse({
        ok: false, error: failure.message, code: typeof failure.code === "string" ? failure.code :
          (failure.name === "AbortError" ? "GENERATION_CANCELLED" : "GENERATION_FAILED"),
        activeRequestId: failure.activeRequestId,
      }));
    return true;
  }

  if ([MESSAGE_TYPES.GENERATION_PREPARE_REQUEST, MESSAGE_TYPES.GENERATION_AWAIT_CONFIRMATION]
    .includes(message?.type)) {
    const error = validateGenerationTransitionMessage(message, message.type);
    if (error) return void sendResponse({ ok: false, error });
    Promise.resolve().then(async () => {
      const tab = isExtensionPage && message.payload.tabId ? await chrome.tabs.get(message.payload.tabId)
        : sender.tab?.id ? sender.tab
          : await activeTabForExtension(sender);
      if (!tab) throw new Error("No active page is available.");
      const sourceUrl = sender.tab?.id ? sender.url : tab.url;
      const ownerFrameId = sender.tab?.id && Number.isInteger(sender.frameId) ? sender.frameId : 0;
      if (message.payload.pageUrl && comparablePageUrl(message.payload.pageUrl) !== comparablePageUrl(sourceUrl)) {
        throw new Error("Page URL does not match the active tab.");
      }
      if (message.type === MESSAGE_TYPES.GENERATION_PREPARE_REQUEST) {
        const result = generation.begin({
          requestId: message.payload.requestId, ownerTabId: tab.id,
          ownerFrameId,
          sourceType: "page", sourceLabel: "Page",
        });
        if (!result.ok) {
          const failure = new Error("Audio is still being prepared. Cancel it before starting another passage.");
          failure.code = result.code;
          throw failure;
        }
      } else if (!generation.transition(message.payload.requestId, "awaiting-confirmation")) {
        throw new Error("That page request is no longer active.");
      }
      broadcastPlayerState();
      return { ok: true, state: sharedPlayerState(tab.id, sender.tab?.id ? ownerFrameId : undefined) };
    }).then(sendResponse).catch((failure) => sendResponse({ ok: false, error: failure.message, code: failure.code }));
    return true;
  }

  const isInPageRead = message?.type === MESSAGE_TYPES.PASSAGE_HOVER_READ ||
    message?.type === MESSAGE_TYPES.PAGE_HOVER_READ;
  if (isInPageRead) {
    const frame = senderFrame(sender);
    const error = !frame
      ? "Invalid in-page request source."
      : validateInPageReadMessage(message) ||
        (comparablePageUrl(message.payload.pageUrl) !== comparablePageUrl(frame.pageUrl)
          ? "Page URL does not match the sender tab." : null);
    const expectedSource = message.type === MESSAGE_TYPES.PAGE_HOVER_READ ? "page" : "hover-passage";
    if (error || message.payload?.source !== expectedSource) {
      sendResponse({ ok: false, error: error || "Invalid in-page source type." });
      return false;
    }
    passageHoverTabs.add(frame.tabId);
    passageHoverFrames.register(frame.tabId, frame.frameId, null);
    storageState().then(({ settings }) => startOwnedPlayback({
      ...message.payload,
      text: speechText(message.payload.text, settings.dsaNormalization),
    }, expectedSource, sender.tab, frame.frameId))
      .then(({ usage }) => sendResponse({ ok: true, usage }))
      .catch((failure) => sendResponse({
        ok: false, error: failure.message, code: typeof failure.code === "string"
          ? failure.code : failure.name === "AbortError" ? "GENERATION_CANCELLED" : "GENERATION_FAILED",
        activeRequestId: failure.activeRequestId,
      }));
    return true;
  }

  const isTrustedPlaybackSurface = Boolean(sender.tab?.id) || sender.url?.startsWith(chrome.runtime.getURL(""));
  if (isTrustedPlaybackSurface && !message?.target && message?.type === MESSAGE_TYPES.PLAYBACK_STATE_REQUEST) {
    Promise.all([restorePlaybackState(), activeTabForExtension(sender)])
      .then(([, tab]) => sendResponse({
        ok: true,
        state: sharedPlayerState(tab?.id, sender.tab?.id ? sender.frameId : undefined),
      }))
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
      const authorized = sender.tab?.id
        ? playbackSession.owns(tab?.id, sender.frameId)
        : playbackSession.owns(tab?.id);
      if (!tab || !authorized) throw new Error("Playback belongs to another tab or frame.");
      if (message.type === MESSAGE_TYPES.PLAYBACK_STOP) await stopPlaybackSession();
      else if (message.type === MESSAGE_TYPES.QUEUE_NEXT) await queue.next();
      else if (message.type === MESSAGE_TYPES.QUEUE_PREVIOUS) await queue.previous();
      else await sendPlayback(message.type, message.payload);
      broadcastPlayerState();
      return { ok: true, state: sharedPlayerState(tab.id, sender.tab?.id ? sender.frameId : undefined) };
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
    readingTabForExtension(sender, message.payload).then((tab) => {
      if (!tab) throw new Error("No active page is available for playback.");
      return startOwnedPlayback({ ...message.payload, pageUrl: tab.url }, source, tab, 0);
    })
      .then(({ usage }) => sendResponse({ ok: true, usage }))
      .catch((failure) => sendResponse({
        ok: false, error: failure.message, code: typeof failure.code === "string"
          ? failure.code : failure.name === "AbortError" ? "GENERATION_CANCELLED" : "GENERATION_FAILED",
        activeRequestId: failure.activeRequestId,
      }));
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
