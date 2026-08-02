export const MESSAGE_TYPES = Object.freeze({
  SELECTION_READ_REQUEST: "SELECTION_READ_REQUEST",
  HOVER_MODE_ENABLE: "HOVER_MODE_ENABLE",
  HOVER_MODE_DISABLE: "HOVER_MODE_DISABLE",
  HOVER_MODE_STATUS_REQUEST: "HOVER_MODE_STATUS_REQUEST",
  HOVER_PASSAGE_READ: "HOVER_PASSAGE_READ",
  IN_PAGE_CONTROLS_ENABLE: "IN_PAGE_CONTROLS_ENABLE",
  IN_PAGE_CONTROLS_DISABLE: "IN_PAGE_CONTROLS_DISABLE",
  IN_PAGE_CONTROLS_STATUS_REQUEST: "IN_PAGE_CONTROLS_STATUS_REQUEST",
  IN_PAGE_CONTROLS_STATUS_CHANGED: "IN_PAGE_CONTROLS_STATUS_CHANGED",
  IN_PAGE_PASSAGE_READ: "IN_PAGE_PASSAGE_READ",
  IN_PAGE_ARTICLE_READ: "IN_PAGE_ARTICLE_READ",
  IN_PAGE_PLAYER_STATE_REQUEST: "IN_PAGE_PLAYER_STATE_REQUEST",
  IN_PAGE_PLAYER_STATE_CHANGED: "IN_PAGE_PLAYER_STATE_CHANGED",
  ARTICLE_READ_REQUEST: "ARTICLE_READ_REQUEST",
  ARTICLE_PREVIEW_ESTIMATE_REQUEST: "ARTICLE_PREVIEW_ESTIMATE_REQUEST",
  PLAYBACK_LOAD: "PLAYBACK_LOAD",
  PLAYBACK_PLAY: "PLAYBACK_PLAY",
  PLAYBACK_PAUSE: "PLAYBACK_PAUSE",
  PLAYBACK_RESUME: "PLAYBACK_RESUME",
  PLAYBACK_STOP: "PLAYBACK_STOP",
  PLAYBACK_SEEK: "PLAYBACK_SEEK",
  PLAYBACK_RATE_SET: "PLAYBACK_RATE_SET",
  PLAYBACK_STATE_REQUEST: "PLAYBACK_STATE_REQUEST",
  PLAYBACK_STATE_CHANGED: "PLAYBACK_STATE_CHANGED",
  PLAYBACK_ENDED: "PLAYBACK_ENDED",
  QUEUE_STATE_REQUEST: "QUEUE_STATE_REQUEST",
  QUEUE_NEXT: "QUEUE_NEXT",
  QUEUE_PREVIOUS: "QUEUE_PREVIOUS",
  QUEUE_STOP: "QUEUE_STOP",
  QUEUE_CLEAR: "QUEUE_CLEAR",
  USAGE_STATE_REQUEST: "USAGE_STATE_REQUEST",
  USAGE_SETTINGS_UPDATE: "USAGE_SETTINGS_UPDATE",
  USAGE_EXPORT_REQUEST: "USAGE_EXPORT_REQUEST",
  USAGE_RESET: "USAGE_RESET",
  BUDGET_OVERRIDE_ONCE: "BUDGET_OVERRIDE_ONCE",
  APP_STATE_REQUEST: "APP_STATE_REQUEST",
});

const MAX_TEXT_BYTES = 500_000;

function validateReadMessage(message, expectedType) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return "Invalid message.";
  }
  if (message.type !== expectedType) {
    return "Unsupported message type.";
  }
  if (!message.payload || typeof message.payload !== "object") {
    return "Invalid message payload.";
  }
  if (typeof message.payload.text !== "string" || !message.payload.text.trim()) {
    return "Select some text to read first.";
  }
  if (new TextEncoder().encode(message.payload.text).byteLength > MAX_TEXT_BYTES) {
    return `Text exceeds the ${MAX_TEXT_BYTES}-byte limit.`;
  }
  if (
    typeof message.payload.requestId !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(message.payload.requestId)
  ) {
    return "Invalid request ID.";
  }
  return null;
}

export function validateSelectionReadMessage(message) {
  return validateReadMessage(message, MESSAGE_TYPES.SELECTION_READ_REQUEST);
}

export function validateHoverPassageReadMessage(message) {
  return validateReadMessage(message, MESSAGE_TYPES.HOVER_PASSAGE_READ);
}

export function validateArticleReadMessage(message) {
  return validateReadMessage(message, MESSAGE_TYPES.ARTICLE_READ_REQUEST);
}

const IN_PAGE_SOURCES = new Set(["passage", "article"]);
const IN_PAGE_ELEMENTS = new Set(["p", "article", "section", "div", "main"]);

export function validateInPageReadMessage(message) {
  const expectedType = message?.type === MESSAGE_TYPES.IN_PAGE_ARTICLE_READ
    ? MESSAGE_TYPES.IN_PAGE_ARTICLE_READ
    : MESSAGE_TYPES.IN_PAGE_PASSAGE_READ;
  const error = validateReadMessage(message, expectedType);
  if (error) return error;
  if (!IN_PAGE_SOURCES.has(message.payload.source)) return "Invalid in-page source type.";
  if (!IN_PAGE_ELEMENTS.has(message.payload.elementType)) return "Invalid readable element type.";
  try {
    const url = new URL(message.payload.pageUrl);
    if (!/^https?:$/.test(url.protocol)) return "Invalid page URL.";
  } catch {
    return "Invalid page URL.";
  }
  return null;
}

export function validatePlaybackCommand(message) {
  const noPayload = new Set([
    MESSAGE_TYPES.PLAYBACK_PLAY,
    MESSAGE_TYPES.PLAYBACK_PAUSE,
    MESSAGE_TYPES.PLAYBACK_RESUME,
    MESSAGE_TYPES.PLAYBACK_STOP,
  ]);
  if (noPayload.has(message?.type)) return null;
  if (message?.type === MESSAGE_TYPES.PLAYBACK_SEEK) {
    const delta = message.payload?.deltaSeconds;
    return Number.isFinite(delta) && Math.abs(delta) <= 86_400 ? null : "Invalid seek value.";
  }
  if (message?.type === MESSAGE_TYPES.PLAYBACK_RATE_SET) {
    const rate = message.payload?.rate;
    return Number.isFinite(rate) && rate >= 0.5 && rate <= 2
      ? null : "Playback speed must be between 0.5 and 2.";
  }
  return "Unsupported playback command.";
}

export function validatePlaybackState(payload) {
  if (!payload || !["idle", "paused", "playing", "ended"].includes(payload.status)) {
    return "Invalid playback status.";
  }
  if (payload.requestId !== null &&
      (typeof payload.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(payload.requestId))) {
    return "Invalid playback request ID.";
  }
  if (!Number.isFinite(payload.currentTime) || payload.currentTime < 0 ||
      !Number.isFinite(payload.duration) || payload.duration < 0) {
    return "Invalid playback timing.";
  }
  if (!Number.isFinite(payload.playbackRate) || payload.playbackRate < 0.5 || payload.playbackRate > 2) {
    return "Invalid playback rate.";
  }
  return null;
}
