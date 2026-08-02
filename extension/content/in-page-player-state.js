(() => {
  if (globalThis.__mochiAudioInPagePlayerState) return;

  function formatTime(seconds) {
    const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
  }

  function map(shared = {}) {
    const playback = shared.playback || {};
    const queue = shared.queue || {};
    const entries = Array.isArray(queue.entries) ? queue.entries : [];
    const duration = Number.isFinite(playback.duration) && playback.duration > 0
      ? playback.duration : 0;
    const currentTime = Math.min(
      Math.max(0, Number.isFinite(playback.currentTime) ? playback.currentTime : 0),
      duration || Infinity,
    );
    const currentIndex = Number.isInteger(queue.currentIndex) ? queue.currentIndex : -1;
    return {
      playback,
      visible: playback.status !== "idle" || entries.length > 0,
      duration,
      currentTime,
      determinate: duration > 0,
      elapsedLabel: formatTime(currentTime),
      durationLabel: duration ? formatTime(duration) : "Loading",
      queueLabel: entries.length ? `Chunk ${currentIndex + 1} of ${entries.length}` : "No queue",
    };
  }

  globalThis.__mochiAudioInPagePlayerState = Object.freeze({ formatTime, map });
})();
