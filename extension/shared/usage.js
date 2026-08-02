export const USAGE_STORAGE_KEYS = Object.freeze({
  records: "usageRecords",
  settings: "usageSettings",
});

export const DEFAULT_USAGE_SETTINGS = Object.freeze({
  pricingMode: "free",
  customPricePerMillionBytes: 0,
  monthlyLimitMicrousd: 0,
  warningThresholdPercent: 80,
  hardStop: true,
  oneTimeOverride: false,
});

export function byteLength(text) {
  return new TextEncoder().encode(text).byteLength;
}

export function estimateCostMicrousd(inputBytes, pricePerMillionBytes) {
  return Math.round(inputBytes * pricePerMillionBytes);
}

export function mergeUsageSettings(value = {}) {
  const mode = ["free", "paid", "custom"].includes(value.pricingMode)
    ? value.pricingMode
    : DEFAULT_USAGE_SETTINGS.pricingMode;
  return {
    pricingMode: mode,
    customPricePerMillionBytes: Math.max(0, Number(value.customPricePerMillionBytes) || 0),
    monthlyLimitMicrousd: Math.max(0, Math.round(Number(value.monthlyLimitMicrousd) || 0)),
    warningThresholdPercent: Math.min(100, Math.max(1, Number(value.warningThresholdPercent) || 80)),
    hardStop: value.hardStop !== false,
    oneTimeOverride: value.oneTimeOverride === true,
  };
}

export function addUsageRecord(records, record) {
  if (records.some((item) => item.requestId === record.requestId)) {
    return records;
  }
  return [...records, record];
}

function localDay(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localMonth(timestamp) {
  return localDay(timestamp).slice(0, 7);
}

function totals(records) {
  return records.reduce(
    (sum, record) => ({
      inputBytes: sum.inputBytes + record.inputBytes,
      estimatedCostMicrousd: sum.estimatedCostMicrousd + record.estimatedCostMicrousd,
    }),
    { inputBytes: 0, estimatedCostMicrousd: 0 },
  );
}

export function aggregateUsage(records, now = Date.now()) {
  const todayKey = localDay(now);
  const monthKey = localMonth(now);
  return {
    current: records.at(-1) || null,
    today: totals(records.filter((record) => localDay(record.timestamp) === todayKey)),
    month: totals(records.filter((record) => localMonth(record.timestamp) === monthKey)),
  };
}

export function exportUsage(records, settings, exportedAt = new Date().toISOString()) {
  return { schemaVersion: 1, exportedAt, settings: mergeUsageSettings(settings), records };
}
