import { MESSAGE_TYPES } from "../shared/messages.js";

const fields = {
  backendUrl: "#backend-url", pricingMode: "#pricing-mode",
  customPricePerMillionBytes: "#custom-price", warningThresholdPercent: "#warning-threshold",
  defaultPlaybackSpeed: "#playback-speed", chunkLimit: "#chunk-limit",
  minimumHoverLength: "#hover-length", hardStop: "#hard-stop",
  skipCode: "#skip-code", dsaNormalization: "#normalize-dsa",
};

function render(settings) {
  for (const [key, selector] of Object.entries(fields)) {
    const input = document.querySelector(selector);
    input[input.type === "checkbox" ? "checked" : "value"] = settings[key];
  }
  document.querySelector("#monthly-limit").value = settings.monthlyLimitMicrousd / 1_000_000;
}

function status(text, error = false) {
  const output = document.querySelector("#status");
  output.textContent = text;
  output.dataset.kind = error ? "error" : "info";
  output.setAttribute("role", error ? "alert" : "status");
}

async function load() {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.USAGE_STATE_REQUEST });
  if (!response?.ok) throw new Error("Options could not be loaded.");
  render(response.state.settings);
  const app = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.APP_STATE_REQUEST });
  document.querySelector("#backend-status").textContent = `Backend status: ${app.state.backend.status}.`;
}

document.querySelector("#options-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = { monthlyLimitMicrousd: Math.round(Number(document.querySelector("#monthly-limit").value) * 1_000_000) };
  for (const [key, selector] of Object.entries(fields)) {
    const input = document.querySelector(selector);
    payload[key] = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value;
  }
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.USAGE_SETTINGS_UPDATE, payload });
  if (!response?.ok) return status("Options could not be saved.", true);
  render(response.state.settings);
  const app = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.APP_STATE_REQUEST });
  document.querySelector("#backend-status").textContent = `Backend status: ${app.state.backend.status}.`;
  status("Options saved.");
});

load().catch((error) => status(error.message, true));
