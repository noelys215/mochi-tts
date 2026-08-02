export function senderFrame(sender) {
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId;
  if (!Number.isInteger(tabId) || tabId < 1 || !Number.isInteger(frameId) || frameId < 0) return null;
  try {
    const url = new URL(sender.url);
    if (!/^https?:$/.test(url.protocol)) return null;
  } catch { return null; }
  return { tabId, frameId, pageUrl: sender.url };
}

export function selectPrimaryFrame(results = []) {
  return results
    .filter((entry) => Number.isInteger(entry?.frameId) && entry?.hasReadableContent === true)
    .sort((left, right) => (right.confidence || 0) - (left.confidence || 0) || left.frameId - right.frameId)[0] || null;
}

export function createFrameRegistry() {
  const tabs = new Map();
  const entry = (tabId) => tabs.get(tabId);
  return {
    enable(tabId, options = {}) {
      tabs.set(tabId, { options: { ...options }, frames: new Map() });
    },
    disable(tabId) { return tabs.delete(tabId); },
    enabled(tabId) { return tabs.has(tabId); },
    options(tabId) { return entry(tabId)?.options || null; },
    register(tabId, frameId, metadata = null) {
      if (!tabs.has(tabId) || !Number.isInteger(frameId) || frameId < 0) return false;
      if (metadata !== null || !entry(tabId).frames.has(frameId)) {
        entry(tabId).frames.set(frameId, metadata);
      }
      return true;
    },
    remove(tabId, frameId) { return entry(tabId)?.frames.delete(frameId) || false; },
    frames(tabId) { return [...(entry(tabId)?.frames.keys() || [])]; },
    tabs() { return [...tabs.keys()]; },
  };
}
