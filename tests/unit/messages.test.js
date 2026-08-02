import assert from "node:assert/strict";
import test from "node:test";

import {
  MESSAGE_TYPES,
  validateInPageReadMessage,
  validatePlaybackCommand,
  validatePlaybackState,
  validateRegionChangedMessage,
} from "../../extension/shared/messages.js";

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
