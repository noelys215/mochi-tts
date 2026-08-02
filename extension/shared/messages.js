export const MESSAGE_TYPES = Object.freeze({
  SELECTION_READ_REQUEST: "SELECTION_READ_REQUEST",
  PLAYBACK_LOAD: "PLAYBACK_LOAD",
});

const MAX_TEXT_BYTES = 10_000;

export function validateSelectionReadMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return "Invalid message.";
  }
  if (message.type !== MESSAGE_TYPES.SELECTION_READ_REQUEST) {
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
