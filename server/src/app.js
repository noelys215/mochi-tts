import express from "express";

import { FishAudioClientError } from "./fish-audio-client.js";
import { createTtsProvider } from "./tts-provider.js";
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

const PROVIDER_ERROR_STATUS = Object.freeze({
  INVALID_BACKEND_RESPONSE: 502,
  INVALID_VOICE_REFERENCE: 422,
  PROVIDER_AUTHENTICATION_FAILURE: 502,
  PROVIDER_FORBIDDEN: 502,
  PROVIDER_PAYMENT_REQUIRED: 402,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_VALIDATION_FAILURE: 502,
  RATE_LIMIT: 429,
  REQUEST_CANCELLED: 499,
  TIMEOUT: 504,
});

export function createApp(options = {}) {
  const {
    maxTextBytes = 10_000,
    extensionOrigin = "",
    ttsProvider = createTtsProvider({ mockMode: true }),
  } = options;
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
        "X-Request-Id, X-Input-Bytes, X-Estimated-Cost-Microusd, X-Pricing-Mode, X-Model",
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
    response.json({
      status: "ok",
      mode: ttsProvider.mode,
      model: ttsProvider.model || "unknown",
      pricePerMillionBytes: Number(ttsProvider.pricePerMillionBytes) || 0,
      maxInputBytes: maxTextBytes,
    });
  });

  app.post("/api/tts", async (request, response, next) => {
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

    const { inputBytes, requestId, text } = validation.value;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.once("aborted", cancel);
    response.once("close", () => {
      if (!response.writableEnded) {
        cancel();
      }
    });

    try {
      const result = await ttsProvider.synthesize({
        text,
        inputBytes,
        requestId,
        signal: controller.signal,
      });
      response.set({
        "Content-Type": result.contentType,
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
        "X-Input-Bytes": String(inputBytes),
        "X-Estimated-Cost-Microusd": String(result.estimatedCostMicrousd),
        "X-Pricing-Mode": result.pricingMode,
        "X-Model": ttsProvider.model || "unknown",
      });
      return response.send(result.audio);
    } catch (error) {
      if (error instanceof FishAudioClientError) {
        if (error.code === "REQUEST_CANCELLED" && response.destroyed) {
          return undefined;
        }
        return sendError(
          response,
          PROVIDER_ERROR_STATUS[error.code] || 502,
          error.code,
          error.message,
          requestId,
        );
      }
      return next(error);
    } finally {
      request.removeListener("aborted", cancel);
    }
  });

  app.use((error, _request, response, _next) => {
    if (error?.type === "entity.too.large") {
      return sendError(response, 413, "REQUEST_TOO_LARGE", "Request body is too large.");
    }
    if (error instanceof SyntaxError) {
      return sendError(response, 400, "INVALID_JSON", "Request body must be valid JSON.");
    }
    return sendError(
      response,
      500,
      "UNKNOWN_FAILURE",
      "The local speech server could not complete the request.",
    );
  });

  return app;
}
