import { createFishAudioClient } from "./fish-audio-client.js";
import { createMockWav } from "./mock-audio.js";

export function estimatedCostMicrousd(inputBytes, pricePerMillionBytes) {
  return Math.round(inputBytes * pricePerMillionBytes);
}

export function createTtsProvider(config, dependencies = {}) {
  if (config.mockMode) {
    return {
      mode: "mock",
      model: "mock",
      pricePerMillionBytes: 0,
      async synthesize() {
        return {
          audio: createMockWav(),
          contentType: "audio/wav",
          estimatedCostMicrousd: 0,
          pricingMode: "mock",
        };
      },
    };
  }

  const client = createFishAudioClient(config.fishAudio, dependencies);
  return {
    mode: "fish",
    model: config.fishAudio.model,
    pricePerMillionBytes: config.fishAudio.pricePerMillionBytes,
    async synthesize({ text, inputBytes, signal }) {
      const result = await client.synthesize({ text, signal });
      return {
        ...result,
        estimatedCostMicrousd: estimatedCostMicrousd(
          inputBytes,
          config.fishAudio.pricePerMillionBytes,
        ),
        pricingMode: "fish-estimate",
      };
    },
  };
}
