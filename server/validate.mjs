const ALLOWED_TOP_LEVEL = new Set([
  "sanitized",
  "mode",
  "goal",
  "context",
  "privacyManifest",
  "screenshot",
  "history",
  "requestId"
]);

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function containsForbiddenKey(value) {
  if (!plainObject(value) && !Array.isArray(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    if (/^(?:vault|original|rawScreenshot|rawOcr|imageDataUrl)$/i.test(key)) return true;
    return containsForbiddenKey(child);
  });
}

function validCountMap(value) {
  return plainObject(value) && Object.values(value).every(
    (count) => Number.isInteger(count) && count >= 0 && count <= 100000
  );
}

export function validateAgentRequest(body, options = {}) {
  if (!plainObject(body)) return { ok: false, error: "Request body must be an object." };
  const extras = Object.keys(body).filter((key) => !ALLOWED_TOP_LEVEL.has(key));
  if (extras.length) return { ok: false, error: "Request contains unsupported fields." };
  if (body.sanitized !== true || !plainObject(body.context) || body.context.redacted !== true) {
    return { ok: false, error: "Only sanitizer-marked context is accepted." };
  }
  if (containsForbiddenKey(body)) {
    return { ok: false, error: "Request contains a forbidden raw-data field." };
  }
  if (typeof body.goal !== "string" || body.goal.length < 1 || body.goal.length > 2000) {
    return { ok: false, error: "Goal must contain 1 to 2000 characters." };
  }
  if (!Array.isArray(body.context.elements) || body.context.elements.length > 2000) {
    return { ok: false, error: "Context elements are missing or excessive." };
  }
  if (!plainObject(body.privacyManifest) || body.privacyManifest.sanitized !== true) {
    return { ok: false, error: "Privacy manifest is required." };
  }
  if (
    body.privacyManifest.categories &&
    !validCountMap(body.privacyManifest.categories)
  ) {
    return { ok: false, error: "Privacy manifest counts are invalid." };
  }
  if (body.screenshot) {
    if (
      !plainObject(body.screenshot) ||
      body.screenshot.sanitized !== true ||
      body.screenshot.kind !== "sanitized-screenshot-v1" ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(String(body.screenshot.dataUrl || ""))
    ) {
      return { ok: false, error: "Screenshot is not a valid sanitized image." };
    }
  }
  if (options.requireImage && !body.screenshot) {
    return { ok: false, error: "This mode requires a sanitized screenshot." };
  }
  if (body.history && (!Array.isArray(body.history) || body.history.length > 12)) {
    return { ok: false, error: "Action history is invalid." };
  }
  return { ok: true, value: body };
}
