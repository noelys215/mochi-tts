import assert from "node:assert/strict";
import test from "node:test";

import { createQueueManager } from "../../extension/background/queue-manager.js";

test("generates only current and one upcoming chunk, then replays without generation", async () => {
  const generated = [];
  const played = [];
  const queue = createQueueManager({
    async generate(entry) {
      generated.push(entry.requestId);
      return { audioUrl: `data:audio/wav;base64,${entry.requestId}`, usage: { requestId: entry.requestId } };
    },
    async play(entry) { played.push(entry.requestId); },
    async stop() {},
  });
  await queue.load({ text: "one two three four five six", maxBytes: 7, requestId: "request_123", source: "selection" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(generated.length, 2);
  await queue.next();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(generated.length, 3);
  await queue.previous();
  assert.equal(generated.length, 3);
  assert.equal(played.length, 3);
  assert.equal(queue.state().entries[0].status, "playing");
});

test("clear aborts in-flight generation and empties the queue", async () => {
  let aborted = false;
  const queue = createQueueManager({
    generate(_entry, signal) {
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("cancelled"));
      }));
    },
    async play() {},
    async stop() {},
  });
  const loading = queue.load({ text: "long text", maxBytes: 20, requestId: "request_123", source: "selection" });
  await new Promise((resolve) => setImmediate(resolve));
  await queue.clear();
  await assert.rejects(loading, /cancelled/);
  assert.equal(aborted, true);
  assert.deepEqual(queue.state(), { currentIndex: -1, entries: [] });
});
