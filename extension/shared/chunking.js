const encoder = new TextEncoder();

function bytes(value) {
  return encoder.encode(value).byteLength;
}

function splitUnits(text, pattern) {
  return text.split(pattern).map((part) => part.trim()).filter(Boolean);
}

function appendUnit(chunks, unit, maxBytes) {
  const previous = chunks.at(-1);
  const joined = previous ? `${previous} ${unit}` : unit;
  if (previous && bytes(joined) <= maxBytes) {
    chunks[chunks.length - 1] = joined;
  } else if (bytes(unit) <= maxBytes) {
    chunks.push(unit);
  } else {
    let current = "";
    for (const character of unit) {
      if (current && bytes(current + character) > maxBytes) {
        chunks.push(current);
        current = character;
      } else {
        current += character;
      }
    }
    if (current) chunks.push(current);
  }
}

export function chunkText(text, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new Error("Invalid chunk limit.");
  const chunks = [];
  for (const paragraph of splitUnits(text, /\n\s*\n+/u)) {
    if (bytes(paragraph) <= maxBytes) {
      appendUnit(chunks, paragraph, maxBytes);
      continue;
    }
    for (const sentence of splitUnits(paragraph, /(?<=[.!?])\s+/u)) {
      if (bytes(sentence) <= maxBytes) {
        appendUnit(chunks, sentence, maxBytes);
      } else {
        for (const word of splitUnits(sentence, /\s+/u)) appendUnit(chunks, word, maxBytes);
      }
    }
  }
  return chunks;
}
