export const DSA_NORMALIZATION_RULES = Object.freeze([
  [/(?:Θ|theta)\s*\(\s*([^)]*)\)/gi, "theta of $1"],
  [/(?:Ω|omega)\s*\(\s*([^)]*)\)/gi, "omega of $1"],
  [/\bO\s*\(\s*([^)]*)\)/g, "big O of $1"],
  [/\bn\s*log\s*n\b/gi, "n log n"],
  [/([A-Za-z_$][\w$]*)\s*\[\s*([^\]]+)\s*\]/g, "$1 at index $2"],
  [/=>/g, " maps to "],
  [/->/g, " points to "],
  [/<=/g, " less than or equal to "],
  [/>=/g, " greater than or equal to "],
  [/!==|!=/g, " does not equal "],
  [/===|==/g, " equals "],
  [/\+\+/g, " increment "],
  [/--/g, " decrement "],
]);

export function normalizeDsaText(originalText) {
  return DSA_NORMALIZATION_RULES.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    originalText,
  ).replace(/\s+/g, " ").trim();
}

export function speechText(originalText, normalize = false) {
  return normalize ? normalizeDsaText(originalText) : originalText;
}
