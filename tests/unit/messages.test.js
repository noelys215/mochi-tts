import assert from "node:assert/strict";
import test from "node:test";

import {
  MESSAGE_TYPES,
  validateGenerationCancelMessage,
  validateGenerationTransitionMessage,
  validateFrameLifecycleMessage,
  validateInPageReadMessage,
  validatePassageHoverControlMessage,
  validatePlaybackCommand,
  validatePlaybackState,
  validateRegionChangedMessage,
} from "../../extension/shared/messages.js";

test("validates frame lifecycle URLs", () => {
  assert.equal(validateFrameLifecycleMessage({
    type: MESSAGE_TYPES.FRAME_LIFECYCLE_ENDED,
    payload: { pageUrl: "https://leetcode.com/explore/lesson" },
  }), null);
  assert.match(validateFrameLifecycleMessage({
    type: MESSAGE_TYPES.FRAME_LIFECYCLE_ENDED,
    payload: { pageUrl: "chrome-extension://spoof" },
  }), /URL/);
});

test("validates tab-scoped hover orchestration without accepting frame IDs", () => {
  const message = {
    type: MESSAGE_TYPES.PASSAGE_HOVER_CONTROLS_ENABLE,
    payload: { tabId: 7, options: { minimumLength: 40, skipCode: true }, frameId: 99 },
  };
  assert.equal(validatePassageHoverControlMessage(message), null);
  assert.match(validatePassageHoverControlMessage({
    ...message, payload: { ...message.payload, tabId: -1 },
  }), /tab/);
  assert.match(validatePassageHoverControlMessage({
    ...message, payload: { tabId: 7, options: { minimumLength: 4, skipCode: true } },
  }), /options/);
});

test("validates generation cancellation request IDs and global intent", () => {
  assert.equal(validateGenerationCancelMessage({
    type: MESSAGE_TYPES.GENERATION_CANCEL, payload: { requestId: "request_123" },
  }), null);
  assert.equal(validateGenerationCancelMessage({
    type: MESSAGE_TYPES.GENERATION_CANCEL, payload: { global: true },
  }), null);
  assert.match(validateGenerationCancelMessage({
    type: MESSAGE_TYPES.GENERATION_CANCEL, payload: { requestId: "bad" },
  }), /request ID/);
  assert.match(validateGenerationCancelMessage({
    type: MESSAGE_TYPES.GENERATION_CANCEL, payload: { global: "yes" },
  }), /global/);
});

test("validates page preparation state transitions", () => {
  const message = {
    type: MESSAGE_TYPES.GENERATION_PREPARE_REQUEST,
    payload: { requestId: "request_123", sourceType: "page", pageUrl: "https://example.com/lesson", tabId: 7 },
  };
  assert.equal(validateGenerationTransitionMessage(message, message.type), null);
  assert.match(validateGenerationTransitionMessage({
    ...message, payload: { ...message.payload, sourceType: "selection" },
  }, message.type), /source/);
  assert.match(validateGenerationTransitionMessage({
    ...message, payload: { ...message.payload, tabId: -1 },
  }, message.type), /tab ID/);
});

function passage(overrides = {}) {
  return {
    type: MESSAGE_TYPES.PASSAGE_HOVER_READ,
    payload: {
      text: "Readable passage text.", requestId: "request_123", source: "hover-passage",
      elementType: "p", pageUrl: "https://example.com/lesson", regionId: "region_123", ...overrides,
    },
  };
}

test("validates in-page request identity, source, element, URL, and UTF-8 size", () => {
  assert.equal(validateInPageReadMessage(passage()), null);
  assert.equal(validateInPageReadMessage(passage({ elementType: "li" })), null);
  assert.equal(validateInPageReadMessage(passage({ elementType: "blockquote" })), null);
  assert.match(validateInPageReadMessage(passage({ source: "page-owned" })), /source/);
  assert.match(validateInPageReadMessage(passage({ elementType: "button" })), /element/);
  assert.match(validateInPageReadMessage(passage({ pageUrl: "javascript:alert(1)" })), /URL/);
  assert.match(validateInPageReadMessage(passage({ requestId: "bad" })), /request ID/);
  assert.match(validateInPageReadMessage(passage({ text: "🐟".repeat(125_001) })), /byte limit/);
});

test("rejects obsolete hover messages and validates region changes", () => {
  assert.match(validateInPageReadMessage({
    ...passage(), type: "HOVER_PASSAGE_READ",
  }), /Unsupported/);
  assert.equal(validateRegionChangedMessage({
    type: MESSAGE_TYPES.PRIMARY_CONTENT_REGION_CHANGED,
    payload: {
      pageUrl: "https://leetcode.com/learn/window", regionId: "region_123",
      region: { strategy: "site-adapter", confidence: 0.95, title: "Sliding window", siteId: "leetcode" },
    },
  }), null);
  assert.match(validateRegionChangedMessage({
    type: MESSAGE_TYPES.PRIMARY_CONTENT_REGION_CHANGED,
    payload: { pageUrl: "javascript:alert(1)", regionId: null, region: null },
  }), /URL/);
});

test("validates seek and playback-rate ranges", () => {
  assert.equal(validatePlaybackCommand({ type: MESSAGE_TYPES.PLAYBACK_SEEK, payload: { deltaSeconds: 4 } }), null);
  assert.match(validatePlaybackCommand({ type: MESSAGE_TYPES.PLAYBACK_SEEK, payload: { deltaSeconds: Infinity } }), /seek/);
  assert.equal(validatePlaybackCommand({ type: MESSAGE_TYPES.PLAYBACK_RATE_SET, payload: { rate: 1.5 } }), null);
  assert.match(validatePlaybackCommand({ type: MESSAGE_TYPES.PLAYBACK_RATE_SET, payload: { rate: 4 } }), /between/);
});

test("validates synchronized playback state values", () => {
  assert.equal(validatePlaybackState({
    status: "playing", requestId: "request_123", currentTime: 2, duration: 10, playbackRate: 1,
  }), null);
  assert.match(validatePlaybackState({
    status: "playing", requestId: "request_123", currentTime: -1, duration: 10, playbackRate: 1,
  }), /timing/);
  assert.match(validatePlaybackState({
    status: "unknown", requestId: null, currentTime: 0, duration: 0, playbackRate: 1,
  }), /status/);
});
