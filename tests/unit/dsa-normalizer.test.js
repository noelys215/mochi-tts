import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDsaText, speechText } from "../../extension/shared/dsa-normalizer.js";

test("applies ordered common DSA notation rules", () => {
  assert.equal(
    normalizeDsaText("O(n log n), arr[i] <= max && next->value !== 0"),
    "big O of n log n, arr at index i less than or equal to max && next points to value does not equal 0",
  );
});

test("normalization is optional and preserves the original", () => {
  const original = "count++ maps x => x == 2";
  assert.equal(speechText(original, false), original);
  assert.equal(
    speechText(original, true),
    "count increment maps x maps to x equals 2",
  );
  assert.equal(original, "count++ maps x => x == 2");
});
