import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createApp } from "../src/app.js";
import { FishAudioClientError } from "../src/fish-audio-client.js";

async function withServer(options, callback) {
  const server = createApp(options).listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("health endpoint reports mock mode", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", mode: "mock" });
  });
});

test("TTS endpoint returns mock audio and safe usage headers", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Study this.", requestId: "request_123" }),
    });
    const audio = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^audio\/wav/);
    assert.equal(response.headers.get("x-request-id"), "request_123");
    assert.equal(response.headers.get("x-input-bytes"), "11");
    assert.equal(response.headers.get("x-estimated-cost-microusd"), "0");
    assert.equal(response.headers.get("x-pricing-mode"), "mock");
    assert.equal(audio.subarray(0, 4).toString(), "RIFF");
  });
});

test("TTS endpoint safely rejects invalid input", async () => {
  await withServer({ maxTextBytes: 4 }, async (baseUrl) => {
    const cases = [
      {
        headers: {},
        body: "text",
        status: 415,
        code: "UNSUPPORTED_CONTENT_TYPE",
      },
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "", requestId: "request_123" }),
        status: 400,
        code: "EMPTY_TEXT",
      },
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "fish", requestId: "bad id" }),
        status: 400,
        code: "INVALID_REQUEST_ID",
      },
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "🐟🐟", requestId: "request_123" }),
        status: 413,
        code: "REQUEST_TOO_LARGE",
      },
    ];

    for (const testCase of cases) {
      const response = await fetch(`${baseUrl}/api/tts`, {
        method: "POST",
        headers: testCase.headers,
        body: testCase.body,
      });
      assert.equal(response.status, testCase.status);
      const payload = await response.json();
      assert.equal(payload.error.code, testCase.code);
      assert.equal(JSON.stringify(payload).includes("🐟🐟"), false);
    }
  });
});

test("TTS endpoint returns configured provider audio and usage", async () => {
  const ttsProvider = {
    mode: "fish",
    async synthesize({ inputBytes }) {
      return {
        audio: Buffer.from([73, 68, 51]),
        contentType: "audio/mpeg",
        estimatedCostMicrousd: inputBytes * 15,
        pricingMode: "fish-estimate",
      };
    },
  };

  await withServer({ ttsProvider }, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.deepEqual(await health.json(), { status: "ok", mode: "fish" });

    const response = await fetch(`${baseUrl}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Fish", requestId: "request_real_123" }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^audio\/mpeg/);
    assert.equal(response.headers.get("x-estimated-cost-microusd"), "60");
    assert.equal(response.headers.get("x-pricing-mode"), "fish-estimate");
  });
});

test("TTS endpoint maps provider failures to sanitized errors", async () => {
  const ttsProvider = {
    mode: "fish",
    async synthesize() {
      throw new FishAudioClientError("TIMEOUT", "Fish Audio timed out.");
    },
  };

  await withServer({ ttsProvider }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Fish", requestId: "request_timeout_123" }),
    });
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), {
      error: {
        code: "TIMEOUT",
        message: "Fish Audio timed out.",
        requestId: "request_timeout_123",
      },
    });
  });
});
