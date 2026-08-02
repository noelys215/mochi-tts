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

export function loadConfig(environment = process.env) {
  return {
    host: environment.HOST || "127.0.0.1",
    port: positiveInteger(environment.PORT, 3000, "PORT"),
    maxTextBytes: positiveInteger(
      environment.MAX_TEXT_BYTES,
      10_000,
      "MAX_TEXT_BYTES",
    ),
    extensionOrigin: environment.EXTENSION_ORIGIN || "",
    mode: "mock",
  };
}
