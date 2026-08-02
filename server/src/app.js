import express from "express";

import { createMockWav } from "./mock-audio.js";
import { validateTtsRequest } from "./validation.js";

function sendError(response, status, code, message, requestId) {
  const error = { code, message };
  if (requestId) {
    error.requestId = requestId;
  }
  return response.status(status).json({ error });
}

function isAllowedOrigin(origin, configuredOrigin) {
  if (!origin) {
    return true;
  }
  if (configuredOrigin) {
    return origin === configuredOrigin;
  }
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

export function createApp({ maxTextBytes = 10_000, extensionOrigin = "" } = {}) {
  const app = express();

  app.disable("x-powered-by");
  app.use((request, response, next) => {
    const origin = request.get("origin");
    response.vary("Origin");

    if (origin && isAllowedOrigin(origin, extensionOrigin)) {
      response.set("Access-Control-Allow-Origin", origin);
      response.set("Access-Control-Allow-Headers", "Content-Type");
      response.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.set(
        "Access-Control-Expose-Headers",
        "X-Request-Id, X-Input-Bytes, X-Estimated-Cost-Microusd, X-Pricing-Mode",
      );
    }

    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(origin, extensionOrigin)) {
        return sendError(response, 403, "ORIGIN_NOT_ALLOWED", "Origin is not allowed.");
      }
      return response.sendStatus(204);
    }
    return next();
  });
  app.use(express.json({ limit: Math.max(maxTextBytes * 6 + 1_024, 16_384) }));

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok", mode: "mock" });
  });

  app.post("/api/tts", (request, response) => {
    if (!request.is("application/json")) {
      return sendError(
        response,
        415,
        "UNSUPPORTED_CONTENT_TYPE",
        "Content-Type must be application/json.",
      );
    }

    const validation = validateTtsRequest(request.body, maxTextBytes);
    if (!validation.value) {
      const status = validation.code === "REQUEST_TOO_LARGE" ? 413 : 400;
      return sendError(
        response,
        status,
        validation.code,
        validation.message,
        validation.requestId,
      );
    }

    const { inputBytes, requestId } = validation.value;
    const audio = createMockWav();
    response.set({
      "Content-Type": "audio/wav",
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
      "X-Input-Bytes": String(inputBytes),
      "X-Estimated-Cost-Microusd": "0",
      "X-Pricing-Mode": "mock",
    });
    return response.send(audio);
  });

  app.use((error, _request, response, _next) => {
    if (error?.type === "entity.too.large") {
      return sendError(response, 413, "REQUEST_TOO_LARGE", "Request body is too large.");
    }
    if (error instanceof SyntaxError) {
      return sendError(response, 400, "INVALID_JSON", "Request body must be valid JSON.");
    }
    return sendError(response, 500, "UNKNOWN_FAILURE", "The mock server could not complete the request.");
  });

  return app;
}
