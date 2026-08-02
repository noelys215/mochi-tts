import assert from "node:assert/strict";
import test from "node:test";

import { isValidRequestId, utf8ByteLength, validateTtsRequest } from "../src/validation.js";

test("counts UTF-8 bytes rather than JavaScript characters", () => {
  assert.equal(utf8ByteLength("fish"), 4);
  assert.equal(utf8ByteLength("🐟"), 4);
});

test("validates request IDs", () => {
  assert.equal(isValidRequestId("request_123"), true);
  assert.equal(isValidRequestId("short"), false);
  assert.equal(isValidRequestId("invalid request"), false);
});

test("rejects empty and oversized text", () => {
  assert.equal(
    validateTtsRequest({ text: "  ", requestId: "request_123" }, 10).code,
    "EMPTY_TEXT",
  );
  assert.equal(
    validateTtsRequest({ text: "🐟🐟", requestId: "request_123" }, 7).code,
    "REQUEST_TOO_LARGE",
  );
});
