import assert from "node:assert/strict";
import test from "node:test";

import {
  addUsageRecord,
  aggregateUsage,
  byteLength,
  estimateCostMicrousd,
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
