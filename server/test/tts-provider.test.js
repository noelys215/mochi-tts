import assert from "node:assert/strict";
import test from "node:test";

import { createTtsProvider, estimatedCostMicrousd } from "../src/tts-provider.js";

test("calculates integer microdollar estimates from UTF-8 bytes", () => {
  assert.equal(estimatedCostMicrousd(11, 15), 165);
  assert.equal(estimatedCostMicrousd(10, 0), 0);
});

test("mock provider remains credential-free and playable", async () => {
  const provider = createTtsProvider({ mockMode: true });
  const result = await provider.synthesize({ text: "Mock text.", inputBytes: 10 });
  assert.equal(provider.mode, "mock");
  assert.equal(provider.model, "mock");
  assert.equal(provider.pricePerMillionBytes, 0);
  assert.equal(result.contentType, "audio/wav");
  assert.equal(result.audio.subarray(0, 4).toString(), "RIFF");
  assert.equal(result.estimatedCostMicrousd, 0);
});
