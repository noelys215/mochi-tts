import assert from "node:assert/strict";
import test from "node:test";

import { requestAudio } from "../../extension/shared/backend-client.js";

test("preserves cancellation semantics instead of reporting backend unavailability", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(requestAudio({
    text: "Readable text", requestId: "request_123", signal: controller.signal,
    fetchImpl: async () => { throw new DOMException("Aborted", "AbortError"); },
  }), (error) => error.name === "AbortError" && /cancelled/i.test(error.message));
});

test("uses a safe error when a rejected backend response is not JSON", async () => {
  await assert.rejects(requestAudio({
    text: "Readable text", requestId: "request_123",
    fetchImpl: async () => ({ ok: false, json: async () => { throw new Error("invalid"); } }),
  }), /local speech server rejected/);
});
