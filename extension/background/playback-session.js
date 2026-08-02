const IDLE_PLAYBACK = Object.freeze({
  status: "idle", requestId: null, currentTime: 0, duration: 0, playbackRate: 1,
});

export function createPlaybackSession() {
  let current = null;

  function begin({ tabId, windowId, sourceUrl, sourceType, queueId, regionId = null }) {
    if (!Number.isInteger(tabId) || !Number.isInteger(windowId) ||
        typeof sourceUrl !== "string" || typeof queueId !== "string") {
      throw new TypeError("Invalid playback owner.");
    }
    const previous = current;
    current = {
      ownerTabId: tabId,
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

  function owns(tabId) {
    return Boolean(current && current.ownerTabId === tabId);
  }

  function viewFor(tabId, playback, queue) {
    const ownsPlayback = owns(tabId);
    return {
      session: {
        ownsPlayback,
        otherTabActive: Boolean(current && !ownsPlayback),
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
