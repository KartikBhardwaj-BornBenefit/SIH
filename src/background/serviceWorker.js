/**
 * Background service worker (Manifest V3).
 *
 * Injects content scripts and relays messages. The snapshot it forwards is
 * already redacted by the content script, so this file never sees an
 * unredacted one. The session vault stays inside the tab's isolated content
 * world; nothing here can inspect or persist it.
 *
 * Vision and NER run in an offscreen document so neither screenshots nor page
 * text leave the device, and the service worker is not used as an inference
 * runtime. The NER relay carries text that the content script has already
 * rule-redacted; see runNer below.
 *
 * The agent loop is the one path that leaves the device: it POSTs the
 * leak-checked payload (goal + redacted context, never the vault) to the
 * model configured in llmConfig.js, then applies the returned actions in
 * the tab.
 */

importScripts("../agent/protocol.js", "../vision/hybrid/decisionLayer.js", "llmConfig.js");

var MSG = {
  PING: "PING",
  EXTRACT_DOM: "EXTRACT_DOM",
  FILL_FROM_VAULT: "FILL_FROM_VAULT",
  AGENT_TURN: "AGENT_TURN",
  APPLY_ACTIONS: "APPLY_ACTIONS",
  RUN_AGENT: "RUN_AGENT",
  STOP_AGENT: "STOP_AGENT",
  AGENT_STATUS: "AGENT_STATUS",
  ANALYZE_PAGE: "ANALYZE_PAGE",
  VISION_INIT: "VISION_INIT",
  VISION_STATUS: "VISION_STATUS",
  ANALYZE_SCREEN: "ANALYZE_SCREEN",
  OFFSCREEN_LOAD: "OFFSCREEN_LOAD",
  OFFSCREEN_ANALYZE: "OFFSCREEN_ANALYZE",
  OFFSCREEN_STATUS: "OFFSCREEN_STATUS",
  NER_INIT: "NER_INIT",
  NER_STATUS: "NER_STATUS",
  NER_ANALYZE: "NER_ANALYZE",
  OFFSCREEN_NER_LOAD: "OFFSCREEN_NER_LOAD",
  OFFSCREEN_NER_ANALYZE: "OFFSCREEN_NER_ANALYZE",
  OFFSCREEN_NER_STATUS: "OFFSCREEN_NER_STATUS"
};

var CONTENT_SCRIPT_FILES = [
  "src/models/messages.js",
  "src/utils/text.js",
  "src/utils/visibility.js",
  "src/utils/sensitivityCatalog.js",
  "src/utils/validators.js",
  "src/utils/sensitivity.js",
  "src/utils/identifiers.js",
  "src/content/domExtractor.js",
  "src/content/redaction.js",
  "src/agent/protocol.js",
  "src/agent/apply.js",
  "src/content/content.js"
];

var lastVisionStatus = {
  status: "idle",
  model: "OpenCV YuNet Face Detector",
  backend: null,
  error: null
};

var lastNerStatus = {
  status: "idle",
  model: "DistilBERT NER (English)",
  backend: null,
  error: null
};

var lastAgentRun = {
  status: "idle",
  log: [],
  error: null,
  snapshot: null,
  redaction: null,
  ner: null
};
var activeAgentAbort = null;
var stopAgentRequested = false;

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function heapEstimateBytes() {
  return performance && performance.memory && performance.memory.usedJSHeapSize
    ? Math.round(performance.memory.usedJSHeapSize)
    : null;
}

function llmConfig() {
  return globalThis.BrowserAgentLlm || {};
}

function pushAgentLog(entry) {
  lastAgentRun.log.push(entry);
  chrome.runtime.sendMessage({
    type: MSG.AGENT_STATUS,
    status: lastAgentRun.status,
    entry: entry
  }).catch(function () {});
}

async function settleTab(tabId) {
  await sleep(350);
  var deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    var tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (error) {
      return;
    }
    if (!tab || tab.status === "complete") {
      return;
    }
    await sleep(150);
  }
}

async function callLlm(payload, previousTurns, mode) {
  var cfg = llmConfig();
  var endpoint = cfg.endpoint || "http://127.0.0.1:4317/agent";
  var agent = globalThis.BrowserAgent && globalThis.BrowserAgent.agent;
  if (!agent) {
    return { ok: false, error: "Agent protocol is not loaded." };
  }

  var body = Object.assign({}, payload, {
    mode: mode || "dom",
    history: (previousTurns || []).slice(-12),
    requestId: String(Date.now())
  });
  var gate = agent.verifyNetworkPayload(body, mode === "sanitized-image");
  if (!gate.ok) {
    return gate;
  }

  var controller = new AbortController();
  activeAgentAbort = controller;
  var timer = setTimeout(function () {
    controller.abort();
  }, Number(cfg.timeoutMs) || 45000);

  try {
    var response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(gate.payload),
      signal: controller.signal
    });
    var rawText = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        error:
          "The model endpoint returned HTTP " +
          response.status +
          "."
      };
    }
    var data;
    try {
      data = JSON.parse(rawText);
    } catch (error) {
      return { ok: false, error: "The model endpoint did not return JSON." };
    }
    if (!data || data.ok !== true || !Array.isArray(data.actions)) {
      return { ok: false, error: "The model reply was empty." };
    }
    return {
      ok: true,
      text: {
        actions: data.actions,
        done: Boolean(data.done)
      },
      provider: data.provider || "server",
      serializedBytes: gate.serializedBytes
    };
  } catch (error) {
    if (error && error.name === "AbortError") {
      return {
        ok: false,
        error: stopAgentRequested ? "Agent stopped by the user." : "The agent server request timed out."
      };
    }
    return {
      ok: false,
      error: error && error.message ? error.message : "The model request failed."
    };
  } finally {
    clearTimeout(timer);
    if (activeAgentAbort === controller) {
      activeAgentAbort = null;
    }
  }
}

async function applyPlan(tabId, actions) {
  var results = [];
  var batch = [];

  async function flush() {
    if (!batch.length) {
      return;
    }
    var applied = await chrome.tabs.sendMessage(tabId, {
      type: MSG.APPLY_ACTIONS,
      actions: batch
    });
    batch = [];
    if (!applied) {
      results.push({ ok: false, error: "The tab did not apply the actions." });
      return false;
    }
    (applied.results || [{ ok: applied.ok, error: applied.error }]).forEach(function (item) {
      results.push(item);
    });
    if (!applied.ok) {
      return false;
    }
    return true;
  }

  for (var i = 0; i < actions.length; i++) {
    var action = actions[i];
    if (action.type === "wait") {
      if ((await flush()) === false) {
        return { ok: false, results: results };
      }
      await sleep(action.ms);
      results.push({ ok: true, type: "wait", ms: action.ms });
      continue;
    }
    if (action.type === "done") {
      if ((await flush()) === false) {
        return { ok: false, results: results };
      }
      results.push({ ok: true, type: "done", reason: action.reason || "" });
      continue;
    }
    batch.push(action);
  }
  if ((await flush()) === false) {
    return { ok: false, results: results };
  }
  return { ok: true, results: results };
}

async function captureForAgent(tab, turn, policy, forceOcr) {
  if (lastVisionStatus.status !== "ready") {
    await initVision();
  }
  if (lastVisionStatus.status !== "ready") {
    return { ok: false, error: lastVisionStatus.error || "Vision is unavailable." };
  }
  var captureStart = performance.now();
  var imageDataUrl;
  try {
    imageDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (error) {
    return {
      ok: false,
      error: "Could not capture this tab for local sanitization."
    };
  }
  var captureMs = Math.round(performance.now() - captureStart);
  var ocrPlan = BrowserAgent.hybrid.planOcr(turn.snapshot, Boolean(forceOcr));
  var analyzed = await sendToOffscreen({
    type: MSG.OFFSCREEN_ANALYZE,
    imageDataUrl: imageDataUrl,
    runOcr: ocrPlan.run,
    sanitize: true,
    faceMode: "black",
    snapshot: turn.snapshot,
    redaction: turn.redaction,
    sensitivityPolicy: policy
  });
  imageDataUrl = null;
  if (!analyzed || !analyzed.ok || !analyzed.sanitization) {
    return {
      ok: false,
      error: (analyzed && analyzed.error) || "Local screenshot sanitization failed."
    };
  }
  return {
    ok: true,
    screenshot: analyzed.sanitization.image,
    privacyManifest: analyzed.sanitization.privacyManifest,
    detections: analyzed.sanitization.detections,
    vision: analyzed.vision,
    ocr: analyzed.ocr,
    timings: Object.assign(
      {
        captureMs: captureMs,
        sanitizedImageBytes: analyzed.sanitization.image.byteLength,
        peakCanvasWidth: analyzed.sanitization.image.width,
        peakCanvasHeight: analyzed.sanitization.image.height
      },
      analyzed.timings || {}
    )
  };
}

async function runAgent(tab, options) {
  var agent = globalThis.BrowserAgent && globalThis.BrowserAgent.agent;
  var maxSteps = agent && agent.MAX_STEPS ? agent.MAX_STEPS : 6;
  var maxRuntime = agent && agent.MAX_RUNTIME_MS ? agent.MAX_RUNTIME_MS : 90000;
  var goal = String((options && options.goal) || "").trim();
  var analysisMode = (options && options.analysisMode) || "hybrid";
  var startedAt = Date.now();
  if (!goal) {
    return { ok: false, error: "Write what you want the agent to do first." };
  }
  if (!options || options.remoteConfirmed !== true) {
    return { ok: false, error: "Remote transmission was not confirmed." };
  }
  if (!tab || tab.id == null) {
    return { ok: false, error: "No active tab found." };
  }
  if (!isInjectableUrl(tab.url)) {
    return { ok: false, error: restrictedPageMessage(tab.url) };
  }

  lastAgentRun = {
    status: "running",
    log: [],
    error: null,
    snapshot: null,
    redaction: null,
    ner: null,
    sanitizedScreenshot: null,
    privacyManifest: null,
    timings: null
  };
  stopAgentRequested = false;

  var previousTurns = [];
  var finished = false;
  var lastPlanFingerprint = "";
  var repeatedPlanCount = 0;

  try {
    for (var step = 0; step < maxSteps; step++) {
      if (stopAgentRequested) {
        throw new Error("Agent stopped by the user.");
      }
      if (Date.now() - startedAt > maxRuntime) {
        throw new Error("Agent stopped at the total runtime limit.");
      }
      await ensureContentScript(tab.id);
      pushAgentLog({ step: step + 1, phase: "extract", detail: "Redacting the page." });

      var extractStart = performance.now();
      var turn = await chrome.tabs.sendMessage(tab.id, {
        type: MSG.AGENT_TURN,
        mode: (options && options.contextMode) || "visible",
        sensitivityPolicy: (options && options.sensitivityPolicy) || null,
        goal: goal,
        history: previousTurns,
        runNer: true
      });
      if (!turn || !turn.ok) {
        throw new Error((turn && turn.error) || "Could not build a redacted snapshot.");
      }

      lastAgentRun.snapshot = turn.snapshot || null;
      lastAgentRun.redaction = turn.redaction || null;
      lastAgentRun.ner = turn.ner || null;
      lastAgentRun.privacyManifest = turn.payload.privacyManifest || null;
      lastAgentRun.timings = Object.assign({}, turn.timings || {}, {
        domMs: Math.round(performance.now() - extractStart),
        nerMs: turn.ner && turn.ner.inferenceTimeMs ? turn.ner.inferenceTimeMs : 0
      });

      var networkPayload = Object.assign({}, turn.payload);
      if (analysisMode !== "dom") {
        pushAgentLog({
          step: step + 1,
          phase: "vision",
          detail: "Creating a sanitized local screenshot."
        });
        var pixels = await captureForAgent(
          tab,
          turn,
          (options && options.sensitivityPolicy) || null,
          analysisMode === "sanitized-image"
        );
        if (!pixels.ok) {
          throw new Error(pixels.error);
        }
        var combinedCategories = {};
        [
          networkPayload.privacyManifest && networkPayload.privacyManifest.categories,
          pixels.privacyManifest && pixels.privacyManifest.categories
        ].forEach(function (counts) {
          Object.keys(counts || {}).forEach(function (category) {
            combinedCategories[category] =
              (combinedCategories[category] || 0) + Number(counts[category] || 0);
          });
        });
        lastAgentRun.sanitizedScreenshot = pixels.screenshot;
        lastAgentRun.privacyManifest = Object.assign({}, pixels.privacyManifest, {
          categories: combinedCategories
        });
        lastAgentRun.timings = Object.assign({}, lastAgentRun.timings, pixels.timings);
        networkPayload.privacyManifest = Object.assign(
          {},
          networkPayload.privacyManifest || {},
          pixels.privacyManifest || {},
          { sanitized: true, categories: combinedCategories }
        );
        if (analysisMode === "sanitized-image") {
          networkPayload.screenshot = pixels.screenshot;
        }
      }

      pushAgentLog({
        step: step + 1,
        phase: "privacy",
        detail: "Mechanical leak gate passed; sending sanitized data only."
      });
      pushAgentLog({ step: step + 1, phase: "model", detail: "Waiting for the agent server." });
      var llmStart = performance.now();
      var llm = await callLlm(networkPayload, previousTurns, analysisMode);
      if (!llm.ok) {
        throw new Error(llm.error);
      }
      lastAgentRun.timings = Object.assign({}, lastAgentRun.timings || {}, {
        serverMs: Math.round(performance.now() - llmStart),
        payloadBytes: llm.serializedBytes || 0
      });

      var parsed = agent.parseResponse(llm.text);
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }
      var validated = agent.validateActions(parsed.actions, turn.payload.context);
      if (!validated.ok) {
        throw new Error(validated.error);
      }
      var destructive = validated.actions.filter(function (action) {
        return agent.isDestructiveAction(action, turn.payload.context);
      });
      if (destructive.length && options.allowDestructive !== true) {
        throw new Error("A submit, send, purchase, or destructive action requires user confirmation.");
      }
      var fingerprint = JSON.stringify(validated.actions);
      if (fingerprint === lastPlanFingerprint) {
        repeatedPlanCount += 1;
      } else {
        repeatedPlanCount = 0;
        lastPlanFingerprint = fingerprint;
      }
      if (repeatedPlanCount >= 2) {
        throw new Error("Agent stopped after receiving the same no-progress plan repeatedly.");
      }

      var summary = validated.actions
        .map(function (action) {
          if (action.type === "done") {
            return "done";
          }
          if (action.type === "wait") {
            return "wait " + action.ms + "ms";
          }
          return action.type + " " + (action.elementId || "");
        })
        .join(", ");
      pushAgentLog({
        step: step + 1,
        phase: "plan",
        detail: summary || "no actions",
        actions: validated.actions
      });

      if (!validated.actions.length || (validated.actions.length === 1 && validated.actions[0].type === "done")) {
        finished = true;
        pushAgentLog({
          step: step + 1,
          phase: "done",
          detail: (validated.actions[0] && validated.actions[0].reason) || "The model stopped."
        });
        break;
      }

      var applied = await applyPlan(tab.id, validated.actions);
      var failed = applied.results.filter(function (item) {
        return !item.ok;
      })[0];
      pushAgentLog({
        step: step + 1,
        phase: "apply",
        detail: failed ? failed.error : "Applied " + applied.results.length + " action(s).",
        results: applied.results.map(function (item) {
          return {
            ok: item.ok,
            type: item.type,
            elementId: item.elementId,
            error: item.error || null
          };
        })
      });
      if (!applied.ok || failed) {
        throw new Error((failed && failed.error) || "Applying actions failed.");
      }

      previousTurns.push({
        actions: validated.actions,
        results: applied.results.map(function (item) {
          return {
            ok: item.ok,
            type: item.type,
            elementId: item.elementId,
            error: item.error || null
          };
        })
      });

      if (parsed.done) {
        finished = true;
        pushAgentLog({ step: step + 1, phase: "done", detail: "The model marked the goal complete." });
        break;
      }

      await settleTab(tab.id);
    }

    if (!finished && lastAgentRun.status === "running") {
      pushAgentLog({
        step: maxSteps,
        phase: "done",
        detail: "Stopped after " + maxSteps + " turns."
      });
    }

    lastAgentRun.status = "done";
    return {
      ok: true,
      log: lastAgentRun.log,
      snapshot: lastAgentRun.snapshot,
      redaction: lastAgentRun.redaction,
      ner: lastAgentRun.ner,
      sanitizedScreenshot: lastAgentRun.sanitizedScreenshot,
      privacyManifest: lastAgentRun.privacyManifest,
      timings: Object.assign({}, lastAgentRun.timings || {}, {
        totalAgentMs: Date.now() - startedAt,
        heapEstimateBytes: heapEstimateBytes()
      })
    };
  } catch (error) {
    lastAgentRun.status = stopAgentRequested ? "stopped" : "error";
    lastAgentRun.error = error && error.message ? error.message : String(error);
    pushAgentLog({
      step: Math.min(maxSteps, previousTurns.length + 1),
      phase: lastAgentRun.status,
      detail: lastAgentRun.error
    });
    return {
      ok: false,
      error: lastAgentRun.error,
      log: lastAgentRun.log,
      snapshot: lastAgentRun.snapshot,
      redaction: lastAgentRun.redaction,
      ner: lastAgentRun.ner,
      sanitizedScreenshot: lastAgentRun.sanitizedScreenshot,
      privacyManifest: lastAgentRun.privacyManifest,
      timings: Object.assign({}, lastAgentRun.timings || {}, {
        totalAgentMs: Date.now() - startedAt,
        heapEstimateBytes: heapEstimateBytes()
      })
    };
  }
}

function isInjectableUrl(url) {
  if (!url) {
    return false;
  }
  return /^https?:/i.test(url) || /^file:/i.test(url);
}

function restrictedPageMessage(url) {
  return (
    "This page cannot be analyzed. Chrome does not allow extensions to " +
    "inspect chrome://, the Chrome Web Store, or other restricted pages." +
    (url ? " Current URL: " + url : "")
  );
}

/**
 * Toolbar popups are not tabs, so sender.tab is unset and the active tab is
 * the page behind the popup. If popup.html is itself a tab, skip that sender
 * tab and use a sibling http(s)/file page. chrome:// tabs still fail the
 * injectability check below.
 */
async function getActionTab(sender) {
  var senderTabId = sender && sender.tab && sender.tab.id;
  var tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs || !tabs.length) {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  var tab = tabs && tabs[0];
  if (tab && senderTabId != null && tab.id === senderTabId) {
    var siblings = await chrome.tabs.query({ windowId: tab.windowId });
    var injectable = (siblings || []).find(function (candidate) {
      return candidate.id !== senderTabId && isInjectableUrl(candidate.url);
    });
    if (injectable) {
      return injectable;
    }
  }
  return tab;
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: CONTENT_SCRIPT_FILES
  });
}

async function analyzeTab(tab, mode, sensitivityPolicy) {
  if (!tab || tab.id == null) {
    return { ok: false, error: "No active tab found." };
  }

  if (!isInjectableUrl(tab.url)) {
    return { ok: false, error: restrictedPageMessage(tab.url) };
  }

  try {
    await ensureContentScript(tab.id);
    var response = await chrome.tabs.sendMessage(tab.id, {
      type: MSG.EXTRACT_DOM,
      mode: mode || "visible",
      sensitivityPolicy: sensitivityPolicy || null
    });
    if (!response || !response.ok) {
      return {
        ok: false,
        error: (response && response.error) || "The content script did not return a snapshot."
      };
    }
    return response;
  } catch (error) {
    var message = error && error.message ? error.message : String(error);
    if (/Cannot access/i.test(message) || /Cannot access contents/i.test(message)) {
      return { ok: false, error: restrictedPageMessage(tab.url) };
    }
    if (/file/i.test(message) && /^file:/i.test(tab.url || "")) {
      return {
        ok: false,
        error:
          "Chrome blocked access to this local file. In chrome://extensions, " +
          "open this extension's details and enable \"Allow access to file URLs\"."
      };
    }
    return { ok: false, error: message };
  }
}

async function hasOffscreenDocument() {
  if (chrome.offscreen.hasDocument) {
    return chrome.offscreen.hasDocument();
  }
  var contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  return contexts && contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: "src/offscreen/offscreen.html",
    reasons: ["WORKERS"],
    justification:
      "Run local face detection, ONNX named-entity recognition, and OCR. " +
      "Screenshots and page text are not uploaded."
  });
}

async function sendToOffscreen(payload) {
  await ensureOffscreen();
  var lastError = null;
  for (var i = 0; i < 12; i++) {
    try {
      var response = await chrome.runtime.sendMessage(payload);
      if (response) {
        return response;
      }
    } catch (error) {
      lastError = error;
      await new Promise(function (resolve) {
        setTimeout(resolve, 250);
      });
    }
  }
  throw lastError || new Error("The local vision host did not respond. Reload the extension and try again.");
}

async function initVision() {
  lastVisionStatus.status = "loading";
  lastVisionStatus.error = null;
  var response = await sendToOffscreen({ type: MSG.OFFSCREEN_LOAD });
  if (response && response.status) {
    lastVisionStatus = response.status;
  }
  if (response && response.ok === false) {
    lastVisionStatus.status = "error";
    lastVisionStatus.error = response.error || "Vision model failed to load.";
  }
  return lastVisionStatus;
}

async function initNer() {
  lastNerStatus.status = "loading";
  lastNerStatus.error = null;
  var response = await sendToOffscreen({ type: MSG.OFFSCREEN_NER_LOAD });
  if (response && response.status) {
    lastNerStatus = response.status;
  }
  if (response && response.ok === false) {
    lastNerStatus.status = "error";
    lastNerStatus.error = response.error || "NER model failed to load.";
  }
  return lastNerStatus;
}

/**
 * Run NER over strings the content script has already rule-redacted.
 *
 * The payload here is the one place page text passes through this file, and
 * it is worth being precise about what it contains: every checksum-verified
 * identifier has already been replaced by a placeholder in the tab, so what
 * crosses is prose plus tokens like `<AADHAAR_1>`. Nothing is retained, and
 * only entity spans go back.
 */
async function runNer(texts) {
  await ensureOffscreen();
  if (lastNerStatus.status !== "ready") {
    await initNer();
  }
  if (lastNerStatus.status !== "ready") {
    return {
      ok: false,
      error: lastNerStatus.error || "NER model is not available.",
      status: lastNerStatus
    };
  }
  var response = await sendToOffscreen({
    type: MSG.OFFSCREEN_NER_ANALYZE,
    texts: texts || []
  });
  if (!response || !response.ok) {
    return {
      ok: false,
      error: (response && response.error) || "Local NER inference failed.",
      status: lastNerStatus
    };
  }
  return { ok: true, ner: response.ner, status: lastNerStatus };
}

async function analyzeScreen(options, sender) {
  var totalStart = performance.now();
  var tab = await getActionTab(sender);
  if (!tab || tab.id == null) {
    return { ok: false, error: "No active tab found." };
  }
  if (!isInjectableUrl(tab.url)) {
    return { ok: false, error: restrictedPageMessage(tab.url) };
  }

  await ensureOffscreen();
  if (lastVisionStatus.status !== "ready") {
    await initVision();
  }

  var policy = options && options.sensitivityPolicy;
  var domStart = performance.now();
  var domResult = await analyzeTab(tab, "viewport", policy);
  var domMs = Math.round(performance.now() - domStart);
  var snapshot = domResult && domResult.ok ? domResult.snapshot : null;
  // Records only: the canvas needs element ids and placeholders to draw masks,
  // never the values. The vault is deliberately not forwarded on this path.
  var redaction = domResult && domResult.ok ? domResult.redaction : null;
  var ner = domResult && domResult.ok ? domResult.ner : null;
  var ocrPlan = BrowserAgent.hybrid.planOcr(
    snapshot,
    Boolean(options && options.runOcr)
  );

  var imageDataUrl;
  var captureStart = performance.now();
  try {
    imageDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (error) {
    return {
      ok: false,
      error:
        "Could not capture this tab. " +
        (error && error.message ? error.message : String(error)),
      snapshot: snapshot,
      redaction: redaction
    };
  }
  var captureMs = Math.round(performance.now() - captureStart);

  var visionResponse = await sendToOffscreen({
    type: MSG.OFFSCREEN_ANALYZE,
    imageDataUrl: imageDataUrl,
    runOcr: ocrPlan.run,
    sanitize: true,
    faceMode: "black",
    snapshot: snapshot,
    redaction: redaction,
    sensitivityPolicy: policy
  });

  if (!visionResponse || !visionResponse.ok) {
    return {
      ok: false,
      error: (visionResponse && visionResponse.error) || "Local vision inference failed.",
      snapshot: snapshot,
      redaction: redaction
    };
  }

  var sanitization = visionResponse.sanitization || null;
  return {
    ok: true,
    imageDataUrl: options && options.includeOriginal === false ? null : imageDataUrl,
    sanitizedImageDataUrl:
      sanitization && sanitization.image ? sanitization.image.dataUrl : null,
    sanitizedScreenshot: sanitization && sanitization.image,
    privacyManifest: sanitization && sanitization.privacyManifest,
    normalizedDetections: sanitization && sanitization.detections,
    snapshot: snapshot,
    redaction: redaction,
    ner: ner,
    vision: visionResponse.vision,
    ocr: visionResponse.ocr || null,
    ocrPlan: ocrPlan,
    wallTimeMs: visionResponse.wallTimeMs,
    timings: Object.assign(
      {
        captureMs: captureMs,
        domMs: domMs,
        totalClientMs: Math.round(performance.now() - totalStart),
        heapEstimateBytes: heapEstimateBytes()
      },
      (domResult && domResult.timings) || {},
      visionResponse.timings || {}
    ),
    screenshotLeftDevice: false
  };
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) {
    return;
  }

  if (message.type === MSG.OFFSCREEN_STATUS) {
    lastVisionStatus = {
      status: message.status,
      error: message.error,
      backend: message.backend,
      model: message.model,
      modelId: message.modelId,
      loadTimeMs: message.loadTimeMs,
      note: message.note
    };
    return;
  }

  if (message.type === MSG.OFFSCREEN_NER_STATUS) {
    lastNerStatus = Object.assign({}, lastNerStatus, {
      status: message.status || lastNerStatus.status,
      error: message.error,
      backend: message.backend || lastNerStatus.backend,
      model: message.model || lastNerStatus.model,
      modelId: message.modelId || lastNerStatus.modelId,
      progress: message.progress,
      file: message.file,
      loaded: message.loaded,
      total: message.total
    });
    return;
  }

  if (message.type === MSG.ANALYZE_PAGE) {
    (async function () {
      var tab = await getActionTab(sender);
      var result = await analyzeTab(tab, message.mode, message.sensitivityPolicy);
      sendResponse(result);
    })();
    return true;
  }

  if (message.type === MSG.AGENT_STATUS) {
    sendResponse({
      ok: true,
      status: lastAgentRun.status,
      log: lastAgentRun.log,
      error: lastAgentRun.error,
      snapshot: lastAgentRun.snapshot,
      redaction: lastAgentRun.redaction,
      ner: lastAgentRun.ner,
      sanitizedScreenshot: lastAgentRun.sanitizedScreenshot,
      privacyManifest: lastAgentRun.privacyManifest,
      timings: lastAgentRun.timings
    });
    return;
  }

  if (message.type === MSG.STOP_AGENT) {
    stopAgentRequested = true;
    if (activeAgentAbort) {
      activeAgentAbort.abort();
    }
    lastAgentRun.status = "stopped";
    sendResponse({ ok: true, status: "stopped" });
    return;
  }

  if (message.type === MSG.RUN_AGENT) {
    (async function () {
      try {
        if (lastAgentRun.status === "running") {
          sendResponse({ ok: false, error: "An agent run is already in progress." });
          return;
        }
        var tab = await getActionTab(sender);
        sendResponse(await runAgent(tab, message));
      } catch (error) {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error),
          log: lastAgentRun.log
        });
      }
    })();
    return true;
  }

  // De-referencing relay. Carries a placeholder and an element id, never a
  // value, so the payload is safe even though it passes through here.
  if (message.type === MSG.FILL_FROM_VAULT) {
    (async function () {
      try {
        var tab = await getActionTab(sender);
        if (!tab || tab.id == null) {
          sendResponse({ ok: false, error: "No active tab found." });
          return;
        }
        sendResponse(
          await chrome.tabs.sendMessage(tab.id, {
            type: MSG.FILL_FROM_VAULT,
            elementId: message.elementId,
            placeholder: message.placeholder
          })
        );
      } catch (error) {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error)
        });
      }
    })();
    return true;
  }

  if (message.type === MSG.VISION_INIT || message.type === MSG.VISION_STATUS) {
    (async function () {
      try {
        var status =
          message.type === MSG.VISION_STATUS && lastVisionStatus.status === "ready"
            ? lastVisionStatus
            : await initVision();
        sendResponse({ ok: status.status !== "error", status: status });
      } catch (error) {
        lastVisionStatus.status = "error";
        lastVisionStatus.error = error && error.message ? error.message : String(error);
        sendResponse({ ok: false, status: lastVisionStatus });
      }
    })();
    return true;
  }

  // Sent by the content script mid-extraction, so this is the one relay that
  // runs tab -> worker -> offscreen and back into the same tab.
  if (message.type === MSG.NER_ANALYZE) {
    (async function () {
      try {
        sendResponse(await runNer(message.texts));
      } catch (error) {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error)
        });
      }
    })();
    return true;
  }

  if (message.type === MSG.NER_INIT || message.type === MSG.NER_STATUS) {
    (async function () {
      try {
        var status =
          message.type === MSG.NER_STATUS && lastNerStatus.status === "ready"
            ? lastNerStatus
            : await initNer();
        sendResponse({ ok: status.status !== "error", status: status });
      } catch (error) {
        lastNerStatus.status = "error";
        lastNerStatus.error = error && error.message ? error.message : String(error);
        sendResponse({ ok: false, status: lastNerStatus });
      }
    })();
    return true;
  }

  if (message.type === MSG.ANALYZE_SCREEN) {
    (async function () {
      try {
        var result = await analyzeScreen(message, sender);
        sendResponse(result);
      } catch (error) {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error)
        });
      }
    })();
    return true;
  }
});
