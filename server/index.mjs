import express from "express";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import "../src/agent/protocol.js";
import { loadConfig } from "./config.mjs";
import { validateAgentRequest } from "./validate.mjs";
import { runMockProvider } from "./providers/mock.mjs";
import { runOpenAiProvider } from "./providers/openai.mjs";

export function createApp(config = loadConfig()) {
  const app = express();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  app.disable("x-powered-by");
  app.use(express.json({ limit: config.bodyLimit, strict: true }));

  app.use((request, response, next) => {
    const origin = request.headers.origin;
    const allowed =
      !origin ||
      config.allowedOrigins.includes(origin) ||
      (!config.allowedOrigins.length &&
        (origin.startsWith("chrome-extension://") ||
          origin === "http://127.0.0.1" ||
          origin === "http://localhost"));
    if (!allowed) {
      response.status(403).json({ ok: false, error: "Origin is not allowed." });
      return;
    }
    if (origin) response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
    response.setHeader("access-control-allow-headers", "content-type");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  });

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      service: "privacy-browser-agent",
      provider: config.provider,
      imageEnabled: config.imageEnabled
    });
  });
  app.use("/demo", express.static(path.join(root, "examples"), {
    fallthrough: false,
    index: false,
    maxAge: 0
  }));

  app.post("/agent", async (request, response) => {
    const checked = validateAgentRequest(request.body, {
      requireImage: request.body?.mode === "sanitized-image"
    });
    if (!checked.ok) {
      response.status(400).json({ ok: false, error: checked.error });
      return;
    }
    try {
      const providerResult =
        config.provider === "mock"
          ? await runMockProvider(checked.value)
          : await runOpenAiProvider(checked.value, config);
      const protocol = globalThis.BrowserAgent?.agent;
      const parsed = protocol.parseResponse(providerResult);
      if (!parsed.ok) throw new Error(parsed.error);
      const previous = (checked.value.history || []).slice(-1)[0];
      const stable = protocol.stabilizeActions(
        parsed.actions,
        checked.value.context,
        previous && previous.elements
      );
      const validated = protocol.validateActions(
        stable.actions,
        checked.value.context,
        checked.value.goal
      );
      if (!validated.ok) throw new Error(validated.error);
      response.json({
        ok: true,
        actions: validated.actions,
        done: parsed.done,
        provider: config.provider,
        requestId: String(checked.value.requestId || "").slice(0, 100)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent provider failed.";
      console.error("Agent provider failed:", message);
      response.status(502).json({
        ok: false,
        error: message
      });
    }
  });

  app.use((error, _request, response, _next) => {
    if (error?.type === "entity.too.large") {
      response.status(413).json({ ok: false, error: "Request body is too large." });
      return;
    }
    response.status(400).json({ ok: false, error: "Request body is invalid." });
  });
  return app;
}

export function startServer(config = loadConfig()) {
  const app = createApp(config);
  return app.listen(config.port, "127.0.0.1", () => {
    console.log(`Privacy agent server listening on http://127.0.0.1:${config.port}`);
    console.log(
      `Provider: ${config.provider}; model: ${config.model}` +
        (config.fallbackModels && config.fallbackModels.length
          ? `; fallback: ${config.fallbackModels.join(", ")}`
          : "") +
        `; sanitized images: ${config.imageEnabled}`
    );
    if (config.provider !== "mock" && !config.apiKey) {
      const keyHint = config.openRouter
        ? "OpenRouter key (sk-or-...)"
        : config.gemini
          ? "Google AI Studio key"
          : "provider API key";
      console.warn(
        `No AGENT_API_KEY in server/.env. Paste the ${keyHint} there and restart the server.`
      );
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  startServer();
}
