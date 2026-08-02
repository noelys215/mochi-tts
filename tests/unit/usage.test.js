import assert from "node:assert/strict";
import test from "node:test";

import {
  addUsageRecord,
  aggregateUsage,
  byteLength,
  estimateCostMicrousd,
  mergeUsageSettings,
  normalizeBackendUrl,
} from "../../extension/shared/usage.js";

function record(requestId, timestamp, inputBytes, cost) {
  return { requestId, timestamp, inputBytes, estimatedCostMicrousd: cost };
}

test("counts UTF-8 bytes and rounds cost to integer microdollars", () => {
  assert.equal(byteLength("A🐟"), 5);
  assert.equal(estimateCostMicrousd(11, 15.5), 171);
  assert.equal(estimateCostMicrousd(10, 0), 0);
});

test("aggregates local day and month with month rollover", () => {
  const now = new Date(2026, 7, 1, 12).getTime();
  const records = [
    record("old", new Date(2026, 6, 31, 23).getTime(), 10, 20),
    record("today", new Date(2026, 7, 1, 8).getTime(), 30, 40),
  ];
  assert.deepEqual(aggregateUsage(records, now), {
    current: records[1],
    today: { inputBytes: 30, estimatedCostMicrousd: 40 },
    month: { inputBytes: 30, estimatedCostMicrousd: 40 },
  });
});

test("deduplicates successful usage by request ID", () => {
  const first = record("same", Date.now(), 10, 0);
  const records = addUsageRecord([], first);
  assert.equal(addUsageRecord(records, { ...first, inputBytes: 99 }), records);
});

test("normalizes reader options and rejects non-loopback backends", () => {
  assert.equal(normalizeBackendUrl("http://localhost:4400/path"), "http://localhost:4400");
  assert.equal(normalizeBackendUrl("https://example.com"), "http://127.0.0.1:3000");
  assert.deepEqual(
    mergeUsageSettings({ defaultPlaybackSpeed: 9, chunkLimit: 20, minimumHoverLength: 2 }),
    {
      backendUrl: "http://127.0.0.1:3000", pricingMode: "free",
      customPricePerMillionBytes: 0, monthlyLimitMicrousd: 0,
      warningThresholdPercent: 80, hardStop: true, oneTimeOverride: false,
      defaultPlaybackSpeed: 2, chunkLimit: 100, minimumHoverLength: 10,
      skipCode: true, dsaNormalization: false,
    },
  );
});
