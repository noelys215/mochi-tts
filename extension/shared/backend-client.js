export const DEFAULT_BACKEND_URL = "http://127.0.0.1:3000";

async function safeProviderError(response) {
  try {
    const payload = await response.json();
    if (payload?.error?.message && typeof payload.error.message === "string") {
      return payload.error.message;
    }
  } catch {
    // Fall through to a generic error without exposing the response body.
  }
  return "The local speech server rejected the request.";
}

export async function requestAudio({
  text,
  requestId,
  backendUrl = DEFAULT_BACKEND_URL,
  fetchImpl = fetch,
  signal,
}) {
  let response;
  try {
    response = await fetchImpl(`${backendUrl}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, requestId }),
      signal,
    });
  } catch {
    throw new Error("The local speech server is unavailable.");
  }

  if (!response.ok) {
    throw new Error(await safeProviderError(response));
  }
  if (!response.headers.get("content-type")?.startsWith("audio/")) {
    throw new Error("The local speech server returned an invalid audio response.");
  }

  return {
    audio: await response.arrayBuffer(),
    contentType: response.headers.get("content-type"),
    usage: {
      requestId: response.headers.get("x-request-id"),
      inputBytes: Number(response.headers.get("x-input-bytes")),
      estimatedCostMicrousd: Number(
        response.headers.get("x-estimated-cost-microusd"),
      ),
      pricingMode: response.headers.get("x-pricing-mode"),
      model: response.headers.get("x-model") || "unknown",
    },
  };
}

export async function requestBackendMetadata({
  backendUrl = DEFAULT_BACKEND_URL,
  fetchImpl = fetch,
} = {}) {
  let response;
  try {
    response = await fetchImpl(`${backendUrl}/api/health`);
  } catch {
    throw new Error("The local speech server is unavailable.");
  }
  if (!response.ok) throw new Error("The local speech server is unavailable.");
  const value = await response.json();
  if (!Number.isInteger(value.maxInputBytes) || value.maxInputBytes < 4) {
    throw new Error("The local speech server returned invalid configuration.");
  }
  return value;
}
