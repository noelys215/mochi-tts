import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { createTtsProvider } from "../src/tts-provider.js";
import { utf8ByteLength } from "../src/validation.js";

if (!process.argv.includes("--confirm")) {
  console.error("Manual Fish Audio synthesis was not run. Pass --confirm to opt in.");
  process.exitCode = 1;
} else {
  const config = loadConfig();
  if (config.mockMode) {
    throw new Error("Set FISH_AUDIO_MOCK_MODE=false before manual provider synthesis.");
  }

  const text = "Fish Study Reader manual integration test.";
  const result = await createTtsProvider(config).synthesize({
    text,
    inputBytes: utf8ByteLength(text),
  });
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const outputDirectory = path.resolve(scriptDirectory, "../../tmp");
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(
    outputDirectory,
    `fish-audio-manual-${Date.now()}.${config.fishAudio.outputFormat}`,
  );
  await writeFile(outputPath, result.audio);
  console.log(`Saved manual audio to ${outputPath}`);
}
