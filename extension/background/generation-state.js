export const ACTIVE_GENERATION_STATUSES = new Set(["validating", "generating", "buffering"]);

const IDLE = Object.freeze({
  status: "idle", requestId: null, ownerTabId: null, sourceType: null,
  ownerFrameId: null, sourceLabel: null, startedAt: null, cancellable: false, errorCode: null,
});

export function createGenerationState({ now = Date.now } = {}) {
  let current = { ...IDLE };

  function snapshot() { return { ...current }; }
  function isCurrent(requestId) { return current.requestId === requestId; }
  function begin({ requestId, ownerTabId, ownerFrameId = 0, sourceType, sourceLabel = null }) {
    if (ACTIVE_GENERATION_STATUSES.has(current.status) || current.status === "awaiting-confirmation") {
      return { ok: false, code: "GENERATION_ALREADY_ACTIVE", activeRequestId: current.requestId };
    }
    current = {
      status: "validating", requestId, ownerTabId, ownerFrameId, sourceType, sourceLabel,
      startedAt: now(), cancellable: true, errorCode: null,
    };
    return { ok: true, state: snapshot() };
  }
  function transition(requestId, status, patch = {}) {
    if (!isCurrent(requestId)) return false;
    current = { ...current, ...patch, status };
    return true;
  }
  function clear(requestId) {
    if (requestId && !isCurrent(requestId)) return false;
    current = { ...IDLE };
    return true;
  }
  function viewFor(tabId, frameId) {
    const active = current.status !== "idle";
    const ownsGeneration = active && current.ownerTabId === tabId &&
      (frameId === undefined || current.ownerFrameId === frameId);
    return {
      status: current.status,
      requestId: ownsGeneration ? current.requestId : null,
      sourceType: current.sourceType,
      sourceLabel: ownsGeneration ? current.sourceLabel : null,
      startedAt: ownsGeneration ? current.startedAt : null,
      cancellable: active && current.cancellable,
      errorCode: ownsGeneration ? current.errorCode : null,
      ownsGeneration,
      otherTabGenerating: active && current.ownerTabId !== tabId,
      otherFrameGenerating: active && current.ownerTabId === tabId && !ownsGeneration,
    };
  }
  return { begin, clear, isCurrent, snapshot, transition, viewFor };
}
