import assert from "node:assert/strict";
import test from "node:test";

import { createMockWav } from "../src/mock-audio.js";

test("creates a playable PCM WAV payload", () => {
  const audio = createMockWav();
  assert.equal(audio.subarray(0, 4).toString(), "RIFF");
  assert.equal(audio.subarray(8, 12).toString(), "WAVE");
  assert.equal(audio.readUInt32LE(40), audio.length - 44);
  assert.ok(audio.length > 44);
});
