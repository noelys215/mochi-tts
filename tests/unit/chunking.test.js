import assert from "node:assert/strict";
import test from "node:test";

import { chunkText } from "../../extension/shared/chunking.js";

const bytes = (value) => new TextEncoder().encode(value).byteLength;

test("chunks paragraphs, sentences, and words within UTF-8 limits", () => {
  const chunks = chunkText("First paragraph. Another sentence.\n\n🐟🐟🐟🐟 words after fish.", 20);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => bytes(chunk) <= 20));
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), "First paragraph. Another sentence. 🐟🐟🐟🐟 words after fish.");
});

test("falls back to Unicode code points without corrupting multibyte text", () => {
  assert.deepEqual(chunkText("🐟🐟🐟", 4), ["🐟", "🐟", "🐟"]);
});
