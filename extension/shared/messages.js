export const MESSAGE_TYPES = Object.freeze({
  SELECTION_READ_REQUEST: "SELECTION_READ_REQUEST",
  HOVER_MODE_ENABLE: "HOVER_MODE_ENABLE",
  HOVER_MODE_DISABLE: "HOVER_MODE_DISABLE",
  HOVER_MODE_STATUS_REQUEST: "HOVER_MODE_STATUS_REQUEST",
  HOVER_PASSAGE_READ: "HOVER_PASSAGE_READ",
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
