import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const text = fs.readFileSync(filePath, "utf8");
  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }
    const cut = trimmed.indexOf("=");
    if (cut <= 0) {
      return;
    }
    const name = trimmed.slice(0, cut).trim();
    let value = trimmed.slice(cut + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[name] == null || process.env[name] === "") {
      process.env[name] = value;
    }
  });
}

loadDotEnvFile(path.join(SERVER_DIR, ".env"));

function integer(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function csv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "qwen/qwen3.7-flash";

function isGeminiEndpoint(endpoint) {
  return /generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com/i.test(
    String(endpoint || "")
  );
}

export function loadConfig() {
  const providerName = String(process.env.AGENT_PROVIDER || "mock").toLowerCase();
  let endpoint = String(process.env.AGENT_ENDPOINT || "").trim();
  const modelHint = String(process.env.AGENT_MODEL || "").trim();
  const looksGemini = isGeminiEndpoint(endpoint);
  const openRouter =
    providerName !== "mock" &&
    (providerName === "openrouter" ||
      /openrouter\.ai/i.test(endpoint) ||
      ((looksGemini || !endpoint) && /^qwen\//i.test(modelHint)));

  if (openRouter && (!endpoint || looksGemini)) {
    endpoint = OPENROUTER_ENDPOINT;
  }
  if (!endpoint) {
    endpoint = "https://api.openai.com/v1/chat/completions";
  }

  const gemini = !openRouter && isGeminiEndpoint(endpoint);
  const provider =
    providerName === "mock" ? "mock" : openRouter ? "openrouter" : providerName;

  return {
    port: integer("PORT", 4317, 1, 65535),
    provider,
    model: process.env.AGENT_MODEL || (openRouter ? OPENROUTER_MODEL : "gpt-4o-mini"),
    fallbackModels: csv("AGENT_FALLBACK_MODELS").length
      ? csv("AGENT_FALLBACK_MODELS")
      : openRouter
        ? ["openai/gpt-4o-mini"]
        : [],
    apiKey: process.env.AGENT_API_KEY || "",
    endpoint,
    openRouter,
    gemini,
    timeoutMs: integer("AGENT_TIMEOUT_MS", 60000, 1000, 120000),
    maxTokens: integer("AGENT_MAX_TOKENS", 2048, 256, 8192),
    bodyLimit: process.env.AGENT_BODY_LIMIT || "6mb",
    imageEnabled: process.env.AGENT_IMAGE_ENABLED !== "false",
    allowedOrigins: String(process.env.AGENT_ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  };
}
