import assert from "node:assert/strict";
import test from "node:test";

import { createGenerationState } from "../../extension/background/generation-state.js";

test("owns one generation and rejects duplicate or second-passage activation", () => {
  const generation = createGenerationState({ now: () => 123 });
  assert.equal(generation.begin({ requestId: "request_A", ownerTabId: 1, sourceType: "hover-passage" }).ok, true);
  generation.transition("request_A", "generating");
  const duplicate = generation.begin({ requestId: "request_B", ownerTabId: 1, sourceType: "hover-passage" });
  assert.deepEqual(duplicate, {
    ok: false, code: "GENERATION_ALREADY_ACTIVE", activeRequestId: "request_A",
  });
  assert.equal(generation.snapshot().requestId, "request_A");
});

test("isolates generation details by owner tab and ignores stale transitions", () => {
  const generation = createGenerationState();
  generation.begin({ requestId: "request_A", ownerTabId: 7, sourceType: "page", sourceLabel: "Lesson" });
  assert.equal(generation.viewFor(7).ownsGeneration, true);
  const other = generation.viewFor(8);
  assert.equal(other.otherTabGenerating, true);
  assert.equal(other.requestId, null);
  assert.equal(other.sourceLabel, null);
  assert.equal(generation.transition("stale_request", "failed"), false);
  assert.equal(generation.snapshot().status, "validating");
});

test("clearing cancellation restores idle state and rejects stale completion", () => {
  const generation = createGenerationState();
  generation.begin({ requestId: "request_A", ownerTabId: 1, sourceType: "selection" });
  generation.transition("request_A", "cancelled", { cancellable: false });
  assert.equal(generation.clear("request_A"), true);
  assert.equal(generation.snapshot().status, "idle");
  assert.equal(generation.transition("request_A", "ready"), false);
});
