import assert from "node:assert/strict";
import test from "node:test";

import { createFrameRegistry, selectPrimaryFrame, senderFrame } from "../../extension/background/frame-registry.js";

test("tracks independent frame instances and removes only the replaced frame", () => {
  const registry = createFrameRegistry();
  registry.enable(7, { minimumLength: 40 });
  registry.register(7, 0, { strategy: null });
  registry.register(7, 3, { strategy: "site-adapter" });
  registry.register(7, 5, { strategy: "prose-fallback" });
  assert.deepEqual(registry.frames(7), [0, 3, 5]);
  assert.equal(registry.remove(7, 3), true);
  assert.deepEqual(registry.frames(7), [0, 5]);
  assert.equal(registry.enabled(7), true);
  assert.equal(registry.options(7).minimumLength, 40);
});

test("derives frame identity from sender metadata and rejects unsafe contexts", () => {
  const sender = { tab: { id: 9 }, frameId: 4, url: "https://leetcode.com/explore/lesson" };
  assert.deepEqual(senderFrame(sender), {
    tabId: 9, frameId: 4, pageUrl: "https://leetcode.com/explore/lesson",
  });
  assert.equal(senderFrame({ ...sender, frameId: undefined }), null);
  assert.equal(senderFrame({ ...sender, url: "javascript:alert(1)" }), null);
});

test("selects the highest-confidence readable frame instead of the first result", () => {
  const selected = selectPrimaryFrame([
    { frameId: 0, hasReadableContent: false, confidence: 0 },
    { frameId: 8, hasReadableContent: true, confidence: 0.65 },
    { frameId: 3, hasReadableContent: true, confidence: 0.95 },
  ]);
  assert.equal(selected.frameId, 3);
  assert.equal(selectPrimaryFrame([{ frameId: 0, hasReadableContent: false }]), null);
});
