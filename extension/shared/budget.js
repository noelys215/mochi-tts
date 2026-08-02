import { estimateCostMicrousd, mergeUsageSettings } from "./usage.js";

export function priceForMode(settings, backend) {
  if (settings.pricingMode === "free") return 0;
  if (settings.pricingMode === "custom") return settings.customPricePerMillionBytes;
  return Math.max(0, Number(backend.pricePerMillionBytes) || 0);
}

export function evaluateBudget({ inputBytes, monthCostMicrousd, settings: raw, backend }) {
  const settings = mergeUsageSettings(raw);
  const backendPrice = Math.max(0, Number(backend.pricePerMillionBytes) || 0);
  if (settings.pricingMode === "free" && backendPrice > 0) {
    return { allowed: false, reason: "Paid generation requires explicit paid or custom pricing mode." };
  }
  const estimatedCostMicrousd = estimateCostMicrousd(
    inputBytes,
    priceForMode(settings, backend),
  );
  const projected = monthCostMicrousd + estimatedCostMicrousd;
  const limit = settings.monthlyLimitMicrousd;
  const exceedsLimit = limit > 0 && projected > limit;
  if (exceedsLimit && settings.hardStop && !settings.oneTimeOverride) {
    return { allowed: false, estimatedCostMicrousd, reason: "Monthly spending limit reached." };
  }
  const warning = limit > 0 && projected >= limit * (settings.warningThresholdPercent / 100);
  return {
    allowed: true,
    estimatedCostMicrousd,
    warning,
    consumeOverride: exceedsLimit && settings.oneTimeOverride,
  };
}
