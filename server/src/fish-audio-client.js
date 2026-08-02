const FORMAT_CONTENT_TYPES = Object.freeze({
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pcm: "audio/L16",
  opus: "audio/ogg; codecs=opus",
});

export class FishAudioClientError extends Error {
  constructor(code, message, { retryable = false, status } = {}) {
    super(message);
    this.name = "FishAudioClientError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function errorForStatus(status) {
  if (status === 401) {
    return new FishAudioClientError(
      "PROVIDER_AUTHENTICATION_FAILURE",
      "Fish Audio authentication failed.",
      { status },
    );
  }
  if (status === 402) {
    return new FishAudioClientError(
      "PROVIDER_PAYMENT_REQUIRED",
      "Fish Audio credits are unavailable.",
      { status },
    );
  }
  if (status === 403) {
    return new FishAudioClientError(
      "PROVIDER_FORBIDDEN",
      "Fish Audio denied this request.",
      { status },
    );
  }
  if (status === 404) {
    return new FishAudioClientError(
      "INVALID_VOICE_REFERENCE",
      "The configured Fish Audio voice reference was not found.",
      { status },
    );
  }
  if (status === 429) {
    return new FishAudioClientError(
      "RATE_LIMIT",
      "Fish Audio is rate limiting requests. Try again shortly.",
      { retryable: true, status },
    );
  }
  if (status >= 500) {
    return new FishAudioClientError(
      "PROVIDER_UNAVAILABLE",
      "Fish Audio is temporarily unavailable.",
      { retryable: true, status },
    );
  }
  return new FishAudioClientError(
    "PROVIDER_VALIDATION_FAILURE",
    "Fish Audio rejected the synthesis request.",
    { status },
  );
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new FishAudioClientError("REQUEST_CANCELLED", "Synthesis was cancelled."));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    const cancel = () => {
      clearTimeout(timeout);
      reject(new FishAudioClientError("REQUEST_CANCELLED", "Synthesis was cancelled."));
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

async function runWithTimeout(operation, timeoutMs, outerSignal) {
  if (outerSignal?.aborted) {
    throw new FishAudioClientError("REQUEST_CANCELLED", "Synthesis was cancelled.");
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const cancel = () => controller.abort();
  outerSignal?.addEventListener("abort", cancel, { once: true });

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (outerSignal?.aborted) {
      throw new FishAudioClientError("REQUEST_CANCELLED", "Synthesis was cancelled.");
    }
    if (timedOut) {
      throw new FishAudioClientError("TIMEOUT", "Fish Audio timed out.");
    }
    if (error instanceof FishAudioClientError) {
      throw error;
    }
    throw new FishAudioClientError(
      "PROVIDER_UNAVAILABLE",
      "Fish Audio is temporarily unavailable.",
      { retryable: true },
    );
  } finally {
    clearTimeout(timeout);
    outerSignal?.removeEventListener("abort", cancel);
  }
}

function normalizeContentType(responseType, outputFormat) {
  const type = responseType?.split(";", 1)[0].trim().toLowerCase();
  if (type && !type.startsWith("audio/") && type !== "application/octet-stream") {
    throw new FishAudioClientError(
      "INVALID_BACKEND_RESPONSE",
      "Fish Audio returned an invalid audio response.",
    );
  }
  return type?.startsWith("audio/")
    ? responseType
    : FORMAT_CONTENT_TYPES[outputFormat];
}

export function createFishAudioClient(
  {
    apiKey,
    referenceId,
    model,
    outputFormat,
    apiBaseUrl,
    timeoutMs,
    maxRetries,
  },
  { fetchImpl = fetch, sleep = wait } = {},
) {
  return {
    async synthesize({ text, signal }) {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (signal?.aborted) {
          throw new FishAudioClientError("REQUEST_CANCELLED", "Synthesis was cancelled.");
        }
        try {
          return await runWithTimeout(
            async (requestSignal) => {
              const response = await fetchImpl(`${apiBaseUrl}/v1/tts`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  "Content-Type": "application/json",
                  model,
                },
                body: JSON.stringify({
                  text,
                  reference_id: referenceId,
                  format: outputFormat,
                }),
                signal: requestSignal,
              });

              if (!response.ok) {
                await response.body?.cancel().catch(() => undefined);
                throw errorForStatus(response.status);
              }

              const contentType = normalizeContentType(
                response.headers.get("content-type"),
                outputFormat,
              );
              const audio = Buffer.from(await response.arrayBuffer());
              if (audio.length === 0) {
                throw new FishAudioClientError(
                  "INVALID_BACKEND_RESPONSE",
                  "Fish Audio returned an empty audio response.",
                );
              }
              return { audio, contentType };
            },
            timeoutMs,
            signal,
          );
        } catch (error) {
          const providerError =
            error instanceof FishAudioClientError
              ? error
              : new FishAudioClientError(
                  "PROVIDER_UNAVAILABLE",
                  "Fish Audio is temporarily unavailable.",
                  { retryable: true },
                );
          if (!providerError.retryable || attempt === maxRetries || signal?.aborted) {
            throw providerError;
          }
          await sleep(100 * 2 ** attempt, signal);
          if (signal?.aborted) {
            throw new FishAudioClientError(
              "REQUEST_CANCELLED",
              "Synthesis was cancelled.",
            );
          }
        }
      }
      throw new FishAudioClientError(
        "PROVIDER_UNAVAILABLE",
        "Fish Audio is temporarily unavailable.",
      );
    },
  };
}
