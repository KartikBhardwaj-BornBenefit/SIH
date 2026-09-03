function integer(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

export function loadConfig() {
  return {
    port: integer("PORT", 4317, 1, 65535),
    provider: String(process.env.AGENT_PROVIDER || "mock").toLowerCase(),
    model: process.env.AGENT_MODEL || "gpt-4o-mini",
    apiKey: process.env.AGENT_API_KEY || "",
    endpoint:
      process.env.AGENT_ENDPOINT || "https://api.openai.com/v1/chat/completions",
    timeoutMs: integer("AGENT_TIMEOUT_MS", 45000, 1000, 120000),
    bodyLimit: process.env.AGENT_BODY_LIMIT || "6mb",
    imageEnabled: process.env.AGENT_IMAGE_ENABLED !== "false",
    allowedOrigins: String(process.env.AGENT_ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  };
}
