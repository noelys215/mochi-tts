import { MESSAGE_TYPES } from "../shared/messages.js";

const player = document.querySelector("#player");
let requestId = null;

function isValidRequestId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function isValidAudioUrl(value) {
  return typeof value === "string" && /^data:audio\//.test(value);
}

function playbackState() {
  const hasAudio = Boolean(player.getAttribute("src"));
  return {
    status: !hasAudio
      ? "idle"
      : player.ended
        ? "ended"
        : player.paused
          ? "paused"
          : "playing",
    requestId,
    currentTime: Number.isFinite(player.currentTime) ? player.currentTime : 0,
    duration: Number.isFinite(player.duration) ? player.duration : 0,
    playbackRate: player.playbackRate,
  };
}

function releaseSource() {
  const source = player.getAttribute("src");
  player.pause();
  player.removeAttribute("src");
  player.load();
  if (source?.startsWith("blob:")) {
    URL.revokeObjectURL(source);
  }
  requestId = null;
}

function respondToPlay(sendResponse) {
  if (!player.getAttribute("src")) {
    sendResponse({ ok: false, error: "No audio is loaded." });
    return false;
  }
  player
    .play()
    .then(() => sendResponse({ ok: true, state: playbackState() }))
    .catch(() => sendResponse({ ok: false, error: "Audio playback failed." }));
  return true;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  if (message.type === MESSAGE_TYPES.PLAYBACK_LOAD) {
    if (
      !isValidAudioUrl(message.payload?.audioUrl) ||
      !isValidRequestId(message.payload?.requestId)
    ) {
      sendResponse({ ok: false, error: "Invalid playback request." });
      return false;
    }
    releaseSource();
    requestId = message.payload.requestId;
    player.src = message.payload.audioUrl;
    return respondToPlay(sendResponse);
  }
  if (
    message.type === MESSAGE_TYPES.PLAYBACK_PLAY ||
    message.type === MESSAGE_TYPES.PLAYBACK_RESUME
  ) {
    return respondToPlay(sendResponse);
  }
  if (message.type === MESSAGE_TYPES.PLAYBACK_PAUSE) {
    player.pause();
    sendResponse({ ok: true, state: playbackState() });
    return false;
  }
  if (message.type === MESSAGE_TYPES.PLAYBACK_STOP) {
    releaseSource();
    sendResponse({ ok: true, state: playbackState() });
    return false;
  }
  if (message.type === MESSAGE_TYPES.PLAYBACK_SEEK) {
    const delta = message.payload?.deltaSeconds;
    if (!Number.isFinite(delta) || !player.getAttribute("src")) {
      sendResponse({ ok: false, error: "Invalid seek request." });
      return false;
    }
    const duration = Number.isFinite(player.duration) ? player.duration : Infinity;
    player.currentTime = Math.min(Math.max(0, player.currentTime + delta), duration);
    sendResponse({ ok: true, state: playbackState() });
    return false;
  }
  if (message.type === MESSAGE_TYPES.PLAYBACK_RATE_SET) {
    const rate = message.payload?.rate;
    if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) {
      sendResponse({ ok: false, error: "Playback speed must be between 0.5 and 2." });
      return false;
    }
    player.playbackRate = rate;
    sendResponse({ ok: true, state: playbackState() });
    return false;
  }
  if (message.type === MESSAGE_TYPES.PLAYBACK_STATE_REQUEST) {
    sendResponse({ ok: true, state: playbackState() });
    return false;
  }
  return false;
});
