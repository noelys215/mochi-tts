import "dotenv/config";

function positiveInteger(value, fallback, name) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value, fallback, name) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function nonNegativeNumber(value, fallback, name) {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function booleanValue(value, fallback, name) {
  if (value === undefined) {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

const OUTPUT_FORMATS = new Set(["mp3", "wav", "pcm", "opus"]);
const VERIFIED_MODELS = new Set(["s1", "s2-pro", "s2.1-pro", "s2.1-pro-free"]);

function requiredRealValue(value, name, mockMode) {
  if (!mockMode && !value) {
    throw new Error(`${name} is required when FISH_AUDIO_MOCK_MODE=false`);
  }
  return value || "";
}

export function loadConfig(environment = process.env) {
  const mockMode = booleanValue(
    environment.FISH_AUDIO_MOCK_MODE,
    true,
    "FISH_AUDIO_MOCK_MODE",
  );
  const outputFormat = environment.FISH_AUDIO_OUTPUT_FORMAT || "mp3";
  if (!OUTPUT_FORMATS.has(outputFormat)) {
    throw new Error("FISH_AUDIO_OUTPUT_FORMAT must be mp3, wav, pcm, or opus");
  }

  const model = requiredRealValue(environment.FISH_AUDIO_MODEL, "FISH_AUDIO_MODEL", mockMode);
  if (model && !VERIFIED_MODELS.has(model)) {
    throw new Error("FISH_AUDIO_MODEL is not in the verified model list");
  }

  const apiBaseUrl = environment.FISH_AUDIO_API_BASE_URL || "https://api.fish.audio";
  const parsedApiUrl = new URL(apiBaseUrl);
  if (!mockMode && parsedApiUrl.protocol !== "https:") {
    throw new Error("FISH_AUDIO_API_BASE_URL must use HTTPS in real mode");
  }

  const allowedExtensionId = environment.ALLOWED_EXTENSION_ID || "";
  if (allowedExtensionId && !/^[a-p]{32}$/.test(allowedExtensionId)) {
    throw new Error("ALLOWED_EXTENSION_ID must be a Chrome extension ID");
  }
  if (!mockMode && !allowedExtensionId) {
    throw new Error("ALLOWED_EXTENSION_ID is required when FISH_AUDIO_MOCK_MODE=false");
  }

  const pricePerMillionBytes = nonNegativeNumber(
    environment.FISH_AUDIO_PRICE_PER_MILLION_BYTES,
    mockMode ? 0 : undefined,
    "FISH_AUDIO_PRICE_PER_MILLION_BYTES",
  );
  if (!mockMode && pricePerMillionBytes === undefined) {
    throw new Error(
      "FISH_AUDIO_PRICE_PER_MILLION_BYTES is required when FISH_AUDIO_MOCK_MODE=false",
    );
  }

  const maxRetries = nonNegativeInteger(
    environment.FISH_AUDIO_MAX_RETRIES,
    2,
    "FISH_AUDIO_MAX_RETRIES",
  );
  if (maxRetries > 3) {
    throw new Error("FISH_AUDIO_MAX_RETRIES must be between 0 and 3");
  }

  return {
    host: environment.HOST || "127.0.0.1",
    port: positiveInteger(environment.PORT, 3000, "PORT"),
    maxTextBytes: positiveInteger(
      environment.FISH_AUDIO_MAX_INPUT_BYTES ?? environment.MAX_TEXT_BYTES,
      10_000,
      "FISH_AUDIO_MAX_INPUT_BYTES",
    ),
    extensionOrigin: allowedExtensionId
      ? `chrome-extension://${allowedExtensionId}`
      : "",
    mockMode,
    fishAudio: {
      apiKey: requiredRealValue(
        environment.FISH_AUDIO_API_KEY,
        "FISH_AUDIO_API_KEY",
        mockMode,
      ),
      referenceId: requiredRealValue(
        environment.FISH_AUDIO_REFERENCE_ID,
        "FISH_AUDIO_REFERENCE_ID",
        mockMode,
      ),
      model,
      pricePerMillionBytes,
      apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
      outputFormat,
      timeoutMs: positiveInteger(
        environment.FISH_AUDIO_TIMEOUT_MS,
        30_000,
        "FISH_AUDIO_TIMEOUT_MS",
      ),
      maxRetries,
    },
  };
}
