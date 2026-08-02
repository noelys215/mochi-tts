import { MESSAGE_TYPES } from "../shared/messages.js";

function render(records) {
  const body = document.querySelector("#history-body");
  body.replaceChildren();
  if (!records.length) {
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = "No generated requests yet.";
    const row = document.createElement("tr"); row.append(cell); body.append(row); return;
  }
  for (const record of [...records].reverse()) {
    const row = document.createElement("tr");
    const values = [new Date(record.timestamp).toLocaleString(), record.source,
      record.inputBytes.toLocaleString(), `$${(record.estimatedCostMicrousd / 1_000_000).toFixed(6)}`,
      record.model, record.status];
    for (const value of values) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
    body.append(row);
  }
}

async function load() {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.USAGE_STATE_REQUEST });
  if (response?.ok) render(response.state.records);
}

document.querySelector("#export").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.USAGE_EXPORT_REQUEST });
  const url = URL.createObjectURL(new Blob([JSON.stringify(response.data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = "mochi-audio-usage.json"; link.click(); URL.revokeObjectURL(url);
  document.querySelector("#status").textContent = "History exported.";
});

document.querySelector("#reset").addEventListener("click", async () => {
  if (!window.confirm("Reset all local usage history?")) return;
  const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.USAGE_RESET });
  if (response?.ok) render(response.state.records);
  document.querySelector("#status").textContent = response?.ok ? "History reset." : "History reset failed.";
});

load();
