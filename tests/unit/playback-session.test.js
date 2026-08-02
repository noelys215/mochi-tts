import assert from "node:assert/strict";
import test from "node:test";

import { createPlaybackSession } from "../../extension/background/playback-session.js";

const playback = { status: "playing", requestId: "request_123", currentTime: 2, duration: 9, playbackRate: 1 };
const queue = { currentIndex: 0, entries: [{ id: "chunk" }] };

test("assigns and replaces one authoritative playback owner", () => {
  const session = createPlaybackSession();
  session.begin({ tabId: 1, windowId: 10, sourceUrl: "https://a.test", sourceType: "hover-passage", queueId: "a" });
  assert.equal(session.owns(1), true);
  const replaced = session.begin({ tabId: 2, windowId: 10, sourceUrl: "https://b.test", sourceType: "page", queueId: "b" });
  assert.equal(replaced.previous.ownerTabId, 1);
  assert.equal(session.owns(1), false);
  assert.equal(session.owns(2), true);
});

test("sanitizes queue and playback state for non-owner tabs", () => {
  const session = createPlaybackSession();
  session.begin({ tabId: 1, windowId: 10, sourceUrl: "https://a.test", sourceType: "selection", queueId: "a" });
  assert.equal(session.viewFor(1, playback, queue).playback.status, "playing");
  const other = session.viewFor(2, playback, queue);
  assert.equal(other.session.otherTabActive, true);
  assert.equal(other.playback.status, "idle");
  assert.deepEqual(other.queue.entries, []);
  assert.equal("ownerTabId" in other.session, false);
});

test("clearing an owner leaves isolated idle views", () => {
  const session = createPlaybackSession();
  session.begin({ tabId: 1, windowId: 10, sourceUrl: "https://a.test", sourceType: "selection", queueId: "a" });
  assert.equal(session.clear().ownerTabId, 1);
  assert.equal(session.snapshot(), null);
  assert.equal(session.viewFor(2, playback, queue).session.otherTabActive, false);
});
