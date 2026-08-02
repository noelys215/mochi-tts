import assert from "node:assert/strict";
import test from "node:test";

import {
  createFishAudioClient,
  FishAudioClientError,
} from "../src/fish-audio-client.js";

function clientConfig(overrides = {}) {
  return {
    apiKey: "server-only-key",
    referenceId: "voice-reference",
    model: "s2.1-pro",
    outputFormat: "mp3",
    apiBaseUrl: "https://api.fish.audio",
    timeoutMs: 100,
    maxRetries: 2,
    ...overrides,
  };
}

test("sends the verified Fish Audio request and returns binary audio", async () => {
  const calls = [];
  const client = createFishAudioClient(clientConfig(), {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(Uint8Array.from([73, 68, 51]), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    },
  });

  const result = await client.synthesize({ text: "Study fish." });
  assert.equal(result.contentType, "audio/mpeg");
  assert.deepEqual(result.audio, Buffer.from([73, 68, 51]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.fish.audio/v1/tts");
  assert.equal(calls[0].options.headers.Authorization, "Bearer server-only-key");
  assert.equal(calls[0].options.headers.model, "s2.1-pro");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    text: "Study fish.",
    reference_id: "voice-reference",
    format: "mp3",
  });
});

test("retries 429 and 5xx with bounded exponential backoff", async () => {
  const statuses = [429, 503, 200];
  const delays = [];
  let attempts = 0;
  const client = createFishAudioClient(clientConfig(), {
    fetchImpl: async () => {
      const status = statuses[attempts];
      attempts += 1;
      return new Response(status === 200 ? Uint8Array.from([1]) : "upstream detail", {
        status,
        headers: status === 200 ? { "Content-Type": "application/octet-stream" } : {},
      });
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  const result = await client.synthesize({ text: "Retry safely." });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);
  assert.equal(result.contentType, "audio/mpeg");
});

test("does not retry or expose permanent provider failures", async () => {
  let attempts = 0;
  const client = createFishAudioClient(clientConfig(), {
    fetchImpl: async () => {
      attempts += 1;
      return new Response("upstream secret detail", { status: 401 });
    },
  });

  await assert.rejects(
    client.synthesize({ text: "Do not retry." }),
    (error) => {
      assert.ok(error instanceof FishAudioClientError);
      assert.equal(error.code, "PROVIDER_AUTHENTICATION_FAILURE");
      assert.equal(error.message.includes("upstream secret detail"), false);
      return true;
    },
  );
  assert.equal(attempts, 1);
});

test("aborts a provider request at the configured timeout", async () => {
  const client = createFishAudioClient(clientConfig({ timeoutMs: 5 }), {
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
  });

  await assert.rejects(client.synthesize({ text: "Time out." }), {
    code: "TIMEOUT",
  });
});

test("keeps the timeout active while reading the audio body", async () => {
  const client = createFishAudioClient(clientConfig({ timeoutMs: 5 }), {
    fetchImpl: async (_url, { signal }) => ({
      ok: true,
      headers: new Headers({ "Content-Type": "audio/mpeg" }),
      arrayBuffer: () =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    }),
  });

  await assert.rejects(client.synthesize({ text: "Slow body." }), {
    code: "TIMEOUT",
  });
});

test("honors caller cancellation without retrying", async () => {
  let attempts = 0;
  const controller = new AbortController();
  const client = createFishAudioClient(clientConfig(), {
    fetchImpl: (_url, { signal }) => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    },
  });

  const synthesis = client.synthesize({ text: "Cancel this.", signal: controller.signal });
  controller.abort();
  await assert.rejects(synthesis, { code: "REQUEST_CANCELLED" });
  assert.equal(attempts, 1);
});
