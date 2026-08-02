import { MESSAGE_TYPES } from "../shared/messages.js";

const player = document.querySelector("#player");

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message?.target !== "offscreen" ||
    message.type !== MESSAGE_TYPES.PLAYBACK_LOAD ||
    typeof message.payload?.audioUrl !== "string"
  ) {
    return false;
  }

  player.src = message.payload.audioUrl;
  player
    .play()
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false, error: "Audio playback failed." }));
  return true;
});
