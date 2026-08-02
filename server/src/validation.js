const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function utf8ByteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

export function isValidRequestId(value) {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 128 &&
    REQUEST_ID_PATTERN.test(value)
  );
}

export function validateTtsRequest(body, maxTextBytes) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { code: "INVALID_REQUEST", message: "Request body must be an object." };
  }

  if (!isValidRequestId(body.requestId)) {
    return {
      code: "INVALID_REQUEST_ID",
      message: "Request ID must contain 8–128 letters, numbers, underscores, or hyphens.",
    };
  }

  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    return { code: "EMPTY_TEXT", message: "Select some text to read first." };
  }

  const inputBytes = utf8ByteLength(body.text);
  if (inputBytes > maxTextBytes) {
    return {
      code: "REQUEST_TOO_LARGE",
      message: `Text exceeds the ${maxTextBytes}-byte limit.`,
      requestId: body.requestId,
    };
  }

  return {
    value: {
      text: body.text,
      requestId: body.requestId,
      inputBytes,
    },
  };
}
