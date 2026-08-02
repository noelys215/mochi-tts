const IDLE_PLAYBACK = Object.freeze({
  status: "idle", requestId: null, currentTime: 0, duration: 0, playbackRate: 1,
});

export function createPlaybackSession() {
  let current = null;

  function begin({ tabId, frameId = 0, windowId, sourceUrl, sourceType, queueId, regionId = null }) {
    if (!Number.isInteger(tabId) || !Number.isInteger(windowId) ||
        !Number.isInteger(frameId) || frameId < 0 ||
        typeof sourceUrl !== "string" || typeof queueId !== "string") {
      throw new TypeError("Invalid playback owner.");
    }
    const previous = current;
    current = {
      ownerTabId: tabId,
      ownerFrameId: frameId,
      ownerWindowId: windowId,
      sourceUrl,
      sourceType,
      queueId,
      regionId,
    };
    return { previous, current: { ...current } };
  }

  function clear() {
    const previous = current;
    current = null;
    return previous;
  }

  function owns(tabId, frameId) {
    return Boolean(current && current.ownerTabId === tabId &&
      (frameId === undefined || current.ownerFrameId === frameId));
  }

  function viewFor(tabId, playback, queue, frameId) {
    const ownsPlayback = owns(tabId, frameId);
    return {
      session: {
        ownsPlayback,
        otherTabActive: Boolean(current && current.ownerTabId !== tabId),
        otherFrameActive: Boolean(current && current.ownerTabId === tabId && !ownsPlayback),
        ...(ownsPlayback ? { ...current } : {}),
      },
      playback: ownsPlayback ? playback : { ...IDLE_PLAYBACK },
      queue: ownsPlayback ? queue : { currentIndex: -1, entries: [] },
    };
  }

  return {
    begin,
    clear,
    owns,
    snapshot: () => current ? { ...current } : null,
    viewFor,
  };
}
