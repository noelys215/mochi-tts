import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBudget } from "../../extension/shared/budget.js";

const backend = { pricePerMillionBytes: 10 };

test("free mode is free only against a free backend", () => {
  assert.equal(evaluateBudget({ inputBytes: 100, monthCostMicrousd: 0, settings: {}, backend: { pricePerMillionBytes: 0 } }).estimatedCostMicrousd, 0);
  assert.equal(evaluateBudget({ inputBytes: 100, monthCostMicrousd: 0, settings: {}, backend }).allowed, false);
});

test("warns at threshold and allows exactly the monthly limit", () => {
  const settings = { pricingMode: "paid", monthlyLimitMicrousd: 1_000, warningThresholdPercent: 80 };
  assert.deepEqual(
    evaluateBudget({ inputBytes: 30, monthCostMicrousd: 500, settings, backend }),
    { allowed: true, estimatedCostMicrousd: 300, warning: true, consumeOverride: false },
  );
  assert.equal(evaluateBudget({ inputBytes: 50, monthCostMicrousd: 500, settings, backend }).allowed, true);
});

test("hard-stops above the limit and consumes a one-time override", () => {
  const base = { pricingMode: "paid", monthlyLimitMicrousd: 1_000, hardStop: true };
  assert.equal(evaluateBudget({ inputBytes: 51, monthCostMicrousd: 500, settings: base, backend }).allowed, false);
  const override = evaluateBudget({ inputBytes: 51, monthCostMicrousd: 500, settings: { ...base, oneTimeOverride: true }, backend });
  assert.equal(override.allowed, true);
  assert.equal(override.consumeOverride, true);
});

test("custom mode uses its explicit price", () => {
  const result = evaluateBudget({ inputBytes: 10, monthCostMicrousd: 0, settings: { pricingMode: "custom", customPricePerMillionBytes: 7 }, backend });
  assert.equal(result.estimatedCostMicrousd, 70);
});
