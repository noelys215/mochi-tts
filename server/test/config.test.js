import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";

test("defaults to credential-free mock mode", () => {
  const config = loadConfig({});
  assert.equal(config.mockMode, true);
  assert.equal(config.fishAudio.apiKey, "");
  assert.equal(config.fishAudio.pricePerMillionBytes, 0);
});

test("loads explicit real provider configuration", () => {
  const config = loadConfig({
    FISH_AUDIO_MOCK_MODE: "false",
    FISH_AUDIO_API_KEY: "server-only-key",
    FISH_AUDIO_REFERENCE_ID: "voice-reference",
    FISH_AUDIO_MODEL: "s2.1-pro",
    FISH_AUDIO_PRICE_PER_MILLION_BYTES: "15",
    FISH_AUDIO_OUTPUT_FORMAT: "opus",
    ALLOWED_EXTENSION_ID: "abcdefghijklmnopabcdefghijklmnop",
  });

  assert.equal(config.mockMode, false);
  assert.equal(config.fishAudio.model, "s2.1-pro");
  assert.equal(config.fishAudio.pricePerMillionBytes, 15);
  assert.equal(config.extensionOrigin, "chrome-extension://abcdefghijklmnopabcdefghijklmnop");
});

test("rejects incomplete real provider configuration", () => {
  assert.throws(
    () =>
      loadConfig({
        FISH_AUDIO_MOCK_MODE: "false",
        FISH_AUDIO_REFERENCE_ID: "voice-reference",
        FISH_AUDIO_MODEL: "s2.1-pro",
        FISH_AUDIO_PRICE_PER_MILLION_BYTES: "15",
        ALLOWED_EXTENSION_ID: "abcdefghijklmnopabcdefghijklmnop",
      }),
    /FISH_AUDIO_API_KEY is required/,
  );

  assert.throws(
    () =>
      loadConfig({
        FISH_AUDIO_MOCK_MODE: "false",
        FISH_AUDIO_API_KEY: "server-only-key",
        FISH_AUDIO_REFERENCE_ID: "voice-reference",
        FISH_AUDIO_MODEL: "s2.1-pro",
        FISH_AUDIO_PRICE_PER_MILLION_BYTES: "15",
      }),
    /ALLOWED_EXTENSION_ID is required/,
  );
});
