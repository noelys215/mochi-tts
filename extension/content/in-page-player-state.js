(() => {
  if (globalThis.__mochiAudioInPagePlayerState) return;

  function formatTime(seconds) {
    const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
  }

  function map(shared = {}) {
    const playback = shared.playback || {};
    const generation = shared.generation || { status: "idle" };
    const queue = shared.queue || {};
    const entries = Array.isArray(queue.entries) ? queue.entries : [];
    const duration = Number.isFinite(playback.duration) && playback.duration > 0
      ? playback.duration : 0;
    const currentTime = Math.min(
      Math.max(0, Number.isFinite(playback.currentTime) ? playback.currentTime : 0),
      duration || Infinity,
    );
    const currentIndex = Number.isInteger(queue.currentIndex) ? queue.currentIndex : -1;
    const queueLength = entries.length;
    const hasPlayableAudio = ["playing", "paused", "ended"].includes(playback.status) || duration > 0;
    const generationActive = generation.ownsGeneration === true &&
      ["validating", "generating", "buffering"].includes(generation.status);
    const initialGeneration = generationActive && !hasPlayableAudio;
    let mode = "ready";
    let statusText = "Ready";
    if (initialGeneration) {
      mode = "generating";
      statusText = "Preparing audio…";
    } else if (generation.status === "failed") {
      mode = "failed";
      statusText = "Could not prepare audio";
    } else if (generation.status === "cancelled") {
      mode = "cancelled";
      statusText = "Audio preparation cancelled";
    } else if (playback.status === "playing") {
      mode = generation.status === "buffering" ? "buffering" : "playing";
      statusText = generation.status === "buffering" ? "Loading next part…" : "Playing";
    } else if (playback.status === "paused") {
      mode = "paused";
      statusText = "Paused";
    } else if (playback.status === "ended") {
      mode = "finished";
      statusText = "Playback finished";
    }
    const primary = mode === "playing" || mode === "buffering"
      ? { command: "PLAYBACK_PAUSE", label: "Pause audio", text: "Pause", icon: "❚❚" }
      : mode === "paused"
        ? { command: "PLAYBACK_RESUME", label: "Resume audio", text: "Play", icon: "▶" }
        : mode === "finished"
          ? { command: "PLAYBACK_PLAY", label: "Replay audio", text: "Replay", icon: "↻" }
          : { command: "PLAYBACK_PLAY", label: "Play audio", text: "Play", icon: "▶" };
    const showTransport = ["ready", "playing", "paused", "buffering", "finished"].includes(mode);
    return {
      playback,
      generation,
      mode,
      statusText,
      visible: generationActive || ["failed", "cancelled"].includes(generation.status) ||
        playback.status !== "idle" || queueLength > 0,
      duration,
      currentTime,
      determinate: duration > 0,
      elapsedLabel: formatTime(currentTime),
      durationLabel: duration ? formatTime(duration) : null,
      timingLabel: duration ? `${formatTime(currentTime)} / ${formatTime(duration)}` : null,
      queueLength,
      currentPart: currentIndex >= 0 ? currentIndex + 1 : 1,
      partLabel: queueLength > 1 ? `Part ${Math.max(1, currentIndex + 1)} of ${queueLength}` : null,
      primary,
      showTransport,
      showParts: showTransport && queueLength > 1,
      previousDisabled: currentIndex <= 0,
      nextDisabled: currentIndex < 0 || currentIndex >= queueLength - 1,
      showProgress: showTransport && duration > 0,
      showSpeed: ["ready", "playing", "paused"].includes(mode),
      showCancel: generationActive && generation.cancellable !== false,
      showRetry: mode === "failed",
      showSpinner: initialGeneration,
    };
  }

  globalThis.__mochiAudioInPagePlayerState = Object.freeze({ formatTime, map });
})();
