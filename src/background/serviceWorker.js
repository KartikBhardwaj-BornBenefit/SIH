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

importScripts(
  "../agent/protocol.js",
  "../privacy/profileVault.js",
  "../vision/hybrid/decisionLayer.js",
  "llmConfig.js"
);

var MSG = {
  PING: "PING",
  EXTRACT_DOM: "EXTRACT_DOM",
  FILL_FROM_VAULT: "FILL_FROM_VAULT",
  AGENT_TURN: "AGENT_TURN",
  APPLY_ACTIONS: "APPLY_ACTIONS",
  RUN_AGENT: "RUN_AGENT",
  STOP_AGENT: "STOP_AGENT",
  CONTINUE_AGENT: "CONTINUE_AGENT",
  TOGGLE_AGENT_PAUSE: "TOGGLE_AGENT_PAUSE",
  AGENT_STATUS: "AGENT_STATUS",
  AGENT_PAUSE_BANNER: "AGENT_PAUSE_BANNER",
  AUTH_GATE_PROBE: "AUTH_GATE_PROBE",
  AUTH_GATE_WATCH_START: "AUTH_GATE_WATCH_START",
  AUTH_GATE_WATCH_STOP: "AUTH_GATE_WATCH_STOP",
  AUTH_GATE_UPDATE: "AUTH_GATE_UPDATE",
  AGENT_KEEPALIVE_START: "AGENT_KEEPALIVE_START",
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
  "src/privacy/profileVault.js",
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
  ner: null,
  sanitizedScreenshot: null,
  sanitizedScreenshots: [],
  analysisMode: null,
  goal: "",
  authGate: null,
  tabId: null
};
var activeAgentAbort = null;
var stopAgentRequested = false;
var continueAgentRequested = false;
var pauseAgentRequested = false;
var agentLoopActive = false;
var loopState = null;
var syncLoopState = function () {};
var persistTimer = null;
var AGENT_SESSION_KEY = "agentSession";

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

function isAgentBusy() {
  return lastAgentRun.status === "running" || lastAgentRun.status === "waiting_for_user";
}

function syncAgentBadge() {
  if (!chrome.action || !chrome.action.setBadgeText) {
    return;
  }
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setTitle({ title: "Analyze current page" });
  var tabId = lastAgentRun.tabId;
  if (tabId == null) {
    return;
  }
  if (lastAgentRun.status === "waiting_for_user") {
    chrome.action.setBadgeText({ text: "||", tabId: tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#d4a843", tabId: tabId });
    chrome.action.setTitle({
      title: "Agent paused for your input. Press Ctrl+Shift+U to resume.",
      tabId: tabId
    });
    return;
  }
  if (lastAgentRun.status === "running") {
    chrome.action.setBadgeText({ text: "ON", tabId: tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#34c484", tabId: tabId });
    chrome.action.setTitle({
      title: "Agent running. Press Ctrl+Shift+U to pause so you can type.",
      tabId: tabId
    });
    return;
  }
  chrome.action.setBadgeText({ text: "", tabId: tabId });
  chrome.action.setTitle({ title: "Analyze current page", tabId: tabId });
}

function requestAgentContinue() {
  if (lastAgentRun.status !== "waiting_for_user") {
    return { ok: false, error: "The agent is not waiting for you." };
  }
  continueAgentRequested = true;
  pauseAgentRequested = false;
  if (!agentLoopActive) {
    if (loopState) {
      loopState.forceContinueOnce = true;
    }
    resumePersistedRun();
  }
  return { ok: true, action: "resume", status: "waiting_for_user" };
}

function toggleAgentPause() {
  if (lastAgentRun.status === "waiting_for_user") {
    return requestAgentContinue();
  }
  if (lastAgentRun.status === "running" || agentLoopActive) {
    pauseAgentRequested = true;
    if (activeAgentAbort) {
      activeAgentAbort.abort();
    }
    return { ok: true, action: "pause", status: "running" };
  }
  return { ok: false, error: "Start the agent first, then pause when you need to type." };
}

function persistAgentSession() {
  if (typeof syncLoopState === "function") {
    syncLoopState();
  }
  if (!chrome.storage || !chrome.storage.session) {
    syncAgentBadge();
    return;
  }
  var payload = {
    status: lastAgentRun.status,
    goal: lastAgentRun.goal || "",
    error: lastAgentRun.error,
    log: (lastAgentRun.log || []).slice(-80),
    authGate: lastAgentRun.authGate || null,
    analysisMode: lastAgentRun.analysisMode || null,
    tabId: lastAgentRun.tabId,
    loopState: loopState
  };
  chrome.storage.session.set({ agentSession: payload }).catch(function () {});
  syncAgentBadge();
}

function schedulePersistAgentSession() {
  if (persistTimer) {
    return;
  }
  persistTimer = setTimeout(function () {
    persistTimer = null;
    persistAgentSession();
  }, 150);
}

function broadcastAgentStatus(extra) {
  chrome.runtime
    .sendMessage(
      Object.assign(
        {
          type: MSG.AGENT_STATUS,
          status: lastAgentRun.status,
          authGate: lastAgentRun.authGate || null,
          goal: lastAgentRun.goal || "",
          tabId: lastAgentRun.tabId
        },
        extra || {}
      )
    )
    .catch(function () {});
}

function pushAgentLog(entry) {
  lastAgentRun.log.push(entry);
  schedulePersistAgentSession();
  broadcastAgentStatus({ entry: entry });
}

function idleAgentPublicState(extra) {
  return Object.assign(
    {
      ok: true,
      status: "idle",
      log: [],
      error: null,
      snapshot: null,
      redaction: null,
      ner: null,
      sanitizedScreenshot: null,
      sanitizedScreenshots: [],
      captureErrors: [],
      privacyManifest: null,
      timings: null,
      analysisMode: null,
      goal: "",
      authGate: null,
      tabId: lastAgentRun.tabId,
      busyElsewhere: isAgentBusy()
    },
    extra || {}
  );
}

function agentStatusForView(viewTabId, extra) {
  var agent = globalThis.BrowserAgent && globalThis.BrowserAgent.agent;
  var belongs =
    agent && agent.agentSessionBelongsToTab
      ? agent.agentSessionBelongsToTab(lastAgentRun, viewTabId)
      : lastAgentRun.tabId == null ||
        (viewTabId != null && Number(viewTabId) === Number(lastAgentRun.tabId));
  if (!belongs) {
    return idleAgentPublicState(extra);
  }
  return agentRunPublicState(Object.assign({ ok: true }, extra || {}));
}

function agentRunPublicState(extra) {
  return Object.assign(
    {
      status: lastAgentRun.status,
      log: lastAgentRun.log,
      error: lastAgentRun.error,
      snapshot: lastAgentRun.snapshot,
      redaction: lastAgentRun.redaction,
      ner: lastAgentRun.ner,
      sanitizedScreenshot: lastAgentRun.sanitizedScreenshot,
      sanitizedScreenshots: lastAgentRun.sanitizedScreenshots || [],
      captureErrors: lastAgentRun.captureErrors || [],
      privacyManifest: lastAgentRun.privacyManifest,
      timings: lastAgentRun.timings,
      analysisMode: lastAgentRun.analysisMode || null,
      goal: lastAgentRun.goal || "",
      authGate: lastAgentRun.authGate || null,
      tabId: lastAgentRun.tabId
    },
    extra || {}
  );
}

function clearAgentRun(status) {
  lastAgentRun.status = status || "idle";
  lastAgentRun.log = [];
  lastAgentRun.error = null;
  lastAgentRun.snapshot = null;
  lastAgentRun.redaction = null;
  lastAgentRun.ner = null;
  lastAgentRun.sanitizedScreenshot = null;
  lastAgentRun.sanitizedScreenshots = [];
  lastAgentRun.captureErrors = [];
  lastAgentRun.privacyManifest = null;
  lastAgentRun.timings = null;
  lastAgentRun.analysisMode = null;
  lastAgentRun.goal = "";
  lastAgentRun.authGate = null;
  lastAgentRun.tabId = null;
  lastAgentRun.nextScreen = 0;
  lastAgentRun.lastCapturedIdentity = null;
  loopState = null;
  syncLoopState = function () {};
}

function pageIdentity(tab) {
  if (!tab) {
    return "";
  }
  return String(tab.id) + "|" + String(tab.url || "").split("#")[0];
}

function recordSanitizedScreenshot(step, turn, screenshot, transmitted, phase, tab) {
  if (
    !screenshot ||
    screenshot.sanitized !== true ||
    screenshot.kind !== "sanitized-screenshot-v1" ||
    typeof screenshot.dataUrl !== "string" ||
    !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(screenshot.dataUrl)
  ) {
    return null;
  }
  var page = (turn && turn.payload && turn.payload.context && turn.payload.context.page) || {};
  lastAgentRun.nextScreen = (lastAgentRun.nextScreen || 0) + 1;
  var frame = {
    screen: lastAgentRun.nextScreen,
    step: step,
    phase: phase || "observe",
    title: String(page.title || "Step " + step),
    url: String(page.url || ""),
    transmitted: Boolean(transmitted),
    capturedAt: Date.now(),
    screenshot: screenshot
  };
  var frames = lastAgentRun.sanitizedScreenshots || [];
  frames.push(frame);
  lastAgentRun.sanitizedScreenshots = frames;
  lastAgentRun.sanitizedScreenshot = screenshot;
  if (tab) {
    lastAgentRun.lastCapturedIdentity = pageIdentity(tab);
  }
  chrome.runtime.sendMessage({
    type: MSG.AGENT_STATUS,
    status: lastAgentRun.status,
    screenshotCount: frames.length,
    authGate: lastAgentRun.authGate || null
  }).catch(function () {});
  return frame;
}

function rememberCaptureError(detail) {
  lastAgentRun.captureErrors = lastAgentRun.captureErrors || [];
  lastAgentRun.captureErrors.push(String(detail || "Screenshot capture failed."));
}

async function settleTab(tabId) {
  await sleep(350);
  var deadline = Date.now() + 8000;
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

async function activateTab(tab) {
  if (!tab || tab.id == null) {
    return tab;
  }
  if (tab.active === true) {
    return tab;
  }
  try {
    var current = await chrome.tabs.get(tab.id);
    if (current && current.active === true) {
      return current;
    }
    await chrome.tabs.update(tab.id, { active: true });
    return await chrome.tabs.get(tab.id);
  } catch (error) {
    return tab;
  }
}

function errorFromAgentHttp(status, rawText) {
  try {
    var data = JSON.parse(rawText);
    if (data && data.error) {
      return String(data.error);
    }
  } catch (error) {
    /* Use the HTTP status below. */
  }
  return "The agent server returned HTTP " + status + ".";
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
  }, Number(cfg.timeoutMs) || 60000);

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
        error: errorFromAgentHttp(response.status, rawText)
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
        error: stopAgentRequested
          ? "Agent stopped by the user."
          : pauseAgentRequested
            ? "paused"
            : "The agent server request timed out.",
        paused: Boolean(pauseAgentRequested)
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

async function applyPlan(tabId, actions, options) {
  var results = [];
  var batch = [];

  async function flush() {
    if (!batch.length) {
      return;
    }
    var applied = await chrome.tabs.sendMessage(tabId, {
      type: MSG.APPLY_ACTIONS,
      actions: batch,
      allowHighRiskProfile: Boolean(options && options.allowHighRiskProfile),
      goal: String((options && options.goal) || "")
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

async function captureVisibleImage(tab) {
  var lastError = null;
  var attempt;
  for (attempt = 0; attempt < 6; attempt++) {
    if (attempt) {
      await sleep(220 * attempt);
    }
    try {
      if (tab && tab.id != null) {
        try {
          tab = await chrome.tabs.get(tab.id);
        } catch (getError) {
          /* Use the tab object we already have. */
        }
      }
      if (tab && tab.active !== true) {
        tab = await activateTab(tab);
        await sleep(80);
      }
      var windowId = tab && tab.windowId;
      if (windowId == null) {
        lastError = new Error("The tab has no window to capture.");
        continue;
      }
      var imageDataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: "jpeg",
        quality: 72
      });
      if (imageDataUrl && /^data:image\/jpeg;base64,/i.test(imageDataUrl)) {
        return { ok: true, imageDataUrl: imageDataUrl };
      }
      imageDataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      if (imageDataUrl && /^data:image\/png;base64,/i.test(imageDataUrl)) {
        return { ok: true, imageDataUrl: imageDataUrl };
      }
      lastError = new Error("The captured image was empty.");
    } catch (error) {
      lastError = error;
    }
  }
  var detail = lastError && lastError.message ? lastError.message : String(lastError || "unknown capture error");
  return {
    ok: false,
    error: "Could not capture this tab for local sanitization. " + detail
  };
}

async function captureForAgent(tab, turn, policy, forceOcr, skipOcr) {
  if (lastVisionStatus.status !== "ready") {
    await initVision();
  }
  if (lastVisionStatus.status !== "ready") {
    return { ok: false, error: lastVisionStatus.error || "Vision is unavailable." };
  }
  var captureStart = performance.now();
  var captured = await captureVisibleImage(tab);
  if (!captured.ok) {
    return captured;
  }
  var imageDataUrl = captured.imageDataUrl;
  var captureMs = Math.round(performance.now() - captureStart);
  var ocrPlan = skipOcr
    ? { run: false, mode: "skipped" }
    : BrowserAgent.hybrid.planOcr(turn.snapshot, Boolean(forceOcr));
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

async function captureAndKeep(tab, turn, options, analysisMode, step, phase, skipOcr) {
  var pixels = await captureForAgent(
    tab,
    turn,
    (options && options.sensitivityPolicy) || null,
    analysisMode === "sanitized-image" && !skipOcr,
    Boolean(skipOcr)
  );
  if (!pixels.ok) {
    rememberCaptureError(pixels.error);
    pushAgentLog({
      step: step,
      phase: "vision",
      detail: "Screenshot capture failed; continuing with DOM only. " + pixels.error
    });
    return { ok: false, error: pixels.error, pixels: pixels };
  }
  recordSanitizedScreenshot(
    step,
    turn,
    pixels.screenshot,
    analysisMode === "sanitized-image",
    phase,
    tab
  );
  return { ok: true, pixels: pixels };
}

async function applyPlanAndFollowTab(tab, actions, options) {
  var openedId = null;
  function onCreated(created) {
    if (created && created.openerTabId === tab.id) {
      openedId = created.id;
    }
  }
  chrome.tabs.onCreated.addListener(onCreated);
  var applied;
  try {
    applied = await applyPlan(tab.id, actions, options);
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
  }
  if (openedId == null) {
    try {
      var activeTabs = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (activeTabs && activeTabs[0] && activeTabs[0].id !== tab.id) {
        openedId = activeTabs[0].id;
      }
    } catch (error) {
      openedId = null;
    }
  }
  if (openedId == null) {
    return { applied: applied, tab: tab };
  }
  try {
    var next = await chrome.tabs.get(openedId);
    try {
      if (next.active !== true) {
        await chrome.tabs.update(next.id, { active: true });
      }
    } catch (activateError) {
      /* Capture can still use this tab if it is already visible. */
    }
    return { applied: applied, tab: next };
  } catch (error) {
    return { applied: applied, tab: tab };
  }
}

async function probeAuthGate(tab, options) {
  try {
    tab = await prepareTabForAgent(tab.id);
    var response = await chrome.tabs.sendMessage(tab.id, {
      type: MSG.AUTH_GATE_PROBE,
      mode: (options && options.contextMode) || "visible",
      sensitivityPolicy: (options && options.sensitivityPolicy) || null
    });
    if (!response || !response.ok) {
      return {
        ok: false,
        tab: tab,
        error: (response && response.error) || "Could not inspect the verification step."
      };
    }
    return {
      ok: true,
      tab: tab,
      gate: response.gate || { present: false, blocking: false, kind: "", emptyCount: 0, filledCount: 0 },
      url: response.url || ""
    };
  } catch (error) {
    return {
      ok: false,
      tab: tab,
      error: error && error.message ? error.message : String(error)
    };
  }
}

async function waitForAuthGateClear(tab, options, agent, authGate, step, parkedIdentity, waitOptions) {
  waitOptions = waitOptions || {};
  var autoResume = waitOptions.autoResume !== false;
  var notice = waitOptions.notice || agent.authGateNotice(authGate);
  lastAgentRun.status = "waiting_for_user";
  lastAgentRun.authGate = Object.assign({}, notice, { since: Date.now() });
  continueAgentRequested = false;
  persistAgentSession();
  pushAgentLog({
    step: step,
    phase: "await_user",
    detail: notice.title + " — " + notice.detail
  });
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: MSG.AUTH_GATE_WATCH_START,
      mode: (options && options.contextMode) || "visible",
      sensitivityPolicy: (options && options.sensitivityPolicy) || null
    });
  } catch (watchError) {
    /* Polling below still works if the watcher did not attach. */
  }
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: MSG.AGENT_PAUSE_BANNER,
      show: true,
      title: notice.title,
      shortcut: "Ctrl+Shift+U"
    });
  } catch (bannerError) {
    /* Banner is best-effort. */
  }

  var maxWait = waitOptions.maxWaitMs || agent.MAX_GATE_WAIT_MS || 600000;
  var deadline = Date.now() + maxWait;
  var lastSig =
    String(authGate.blocking) + ":" + String(authGate.kind) + ":" + authGate.emptyCount + ":" + authGate.filledCount;

  try {
  while (true) {
    if (stopAgentRequested) {
      throw new Error("Agent stopped by the user.");
    }
    if (Date.now() > deadline) {
      throw new Error(
        notice.kind === "manual"
          ? "Timed out waiting for you to resume the agent."
          : "Timed out waiting for you to complete the " +
            agent.authGateLabel(notice.kind) +
            " step."
      );
    }
    await sleep(800);

    try {
      tab = await chrome.tabs.get(tab.id);
    } catch (error) {
      throw new Error("The tab closed while waiting for verification.");
    }

    var currentIdentity = pageIdentity(tab);
    var probe = await probeAuthGate(tab, options);
    if (probe.tab) {
      tab = probe.tab;
      currentIdentity = pageIdentity(tab);
    }
    var identityChanged = currentIdentity !== parkedIdentity;

    if (continueAgentRequested) {
      var continued = agent.shouldResumeAuthGate({
        gate: probe.ok ? probe.gate : authGate,
        probeOk: probe.ok,
        continueRequested: true,
        identityChanged: identityChanged,
        gateKey: agent.authGateKey(currentIdentity, probe.ok ? probe.gate : authGate)
      });
      continueAgentRequested = false;
      lastAgentRun.status = "running";
      lastAgentRun.authGate = null;
      pushAgentLog({
        step: step,
        phase: "await_user",
        detail: agent.authGateResumeDetail(continued.reason, probe.ok ? probe.gate : authGate)
      });
      return {
        tab: tab,
        reason: continued.reason,
        ignoreKey: autoResume ? continued.ignoreKey || "" : ""
      };
    }

    if (!autoResume) {
      persistAgentSession();
      continue;
    }

    if (probe.ok && identityChanged) {
      parkedIdentity = currentIdentity;
      if (!probe.gate || !probe.gate.present) {
        lastAgentRun.status = "running";
        lastAgentRun.authGate = null;
        pushAgentLog({
          step: step,
          phase: "await_user",
          detail: agent.authGateResumeDetail("navigation", probe.gate)
        });
        return { tab: tab, reason: "navigation", ignoreKey: "" };
      }
      notice = agent.authGateNotice(probe.gate);
      lastAgentRun.status = "waiting_for_user";
      lastAgentRun.authGate = Object.assign({}, notice, {
        since: (lastAgentRun.authGate && lastAgentRun.authGate.since) || Date.now()
      });
      lastSig =
        String(probe.gate.blocking) +
        ":" +
        String(probe.gate.kind) +
        ":" +
        probe.gate.emptyCount +
        ":" +
        probe.gate.filledCount;
      pushAgentLog({
        step: step,
        phase: "await_user",
        detail: notice.title + " — still a verification step after the page changed."
      });
      continue;
    }

    var decision = agent.shouldResumeAuthGate({
      gate: probe.ok ? probe.gate : null,
      probeOk: probe.ok,
      continueRequested: false,
      identityChanged: false,
      gateKey: agent.authGateKey(currentIdentity, probe.ok ? probe.gate : authGate)
    });

    if (decision.resume) {
      lastAgentRun.status = "running";
      lastAgentRun.authGate = null;
      pushAgentLog({
        step: step,
        phase: "await_user",
        detail: agent.authGateResumeDetail(decision.reason, probe.ok ? probe.gate : authGate)
      });
      return { tab: tab, reason: decision.reason, ignoreKey: decision.ignoreKey || "" };
    }

    if (probe.ok && probe.gate) {
      var sig =
        String(probe.gate.blocking) +
        ":" +
        String(probe.gate.kind) +
        ":" +
        probe.gate.emptyCount +
        ":" +
        probe.gate.filledCount;
      if (sig !== lastSig) {
        lastSig = sig;
        notice = agent.authGateNotice(probe.gate);
        lastAgentRun.status = "waiting_for_user";
        lastAgentRun.authGate = Object.assign({}, notice, {
          since: (lastAgentRun.authGate && lastAgentRun.authGate.since) || Date.now()
        });
        pushAgentLog({
          step: step,
          phase: "await_user",
          detail: probe.gate.blocking ? notice.title + " — still waiting." : notice.detail
        });
      }
    }
  }
  } finally {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: MSG.AGENT_PAUSE_BANNER, show: false });
    } catch (bannerError) {
      /* The tab may have navigated. */
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: MSG.AUTH_GATE_WATCH_STOP });
    } catch (stopError) {
      /* The tab may have navigated. */
    }
  }
}
async function runAgent(tab, options, resumeState) {
  var agent = globalThis.BrowserAgent && globalThis.BrowserAgent.agent;
  var maxSteps = agent && agent.MAX_STEPS ? agent.MAX_STEPS : 6;
  var maxRuntime = agent && agent.MAX_RUNTIME_MS ? agent.MAX_RUNTIME_MS : 90000;
  var goal = String((options && options.goal) || "").trim();
  var analysisMode = (options && options.analysisMode) || "hybrid";
  if (!goal) {
    return { ok: false, error: "Write what you want the agent to do first." };
  }
  if (!options || options.remoteConfirmed !== true) {
    return { ok: false, error: "Remote transmission was not confirmed." };
  }
  if (!tab || tab.id == null) {
    return { ok: false, error: "No active tab found." };
  }
  if (isInjectableUrl(tab.url) === false) {
    return { ok: false, error: restrictedPageMessage(tab.url) };
  }

  var previousTurns = (resumeState && resumeState.previousTurns) || [];
  var finished = false;
  var lastPlanFingerprint = (resumeState && resumeState.lastPlanFingerprint) || "";
  var repeatedPlanCount = (resumeState && resumeState.repeatedPlanCount) || 0;
  var lastElementHints = (resumeState && resumeState.lastElementHints) || [];
  var modelTurnsUsed = (resumeState && resumeState.modelTurnsUsed) || 0;
  var parkedMs = (resumeState && resumeState.parkedMs) || 0;
  var ignoredAuthGateKey = (resumeState && resumeState.ignoredAuthGateKey) || "";
  var authGatePasses = (resumeState && resumeState.authGatePasses) || 0;
  var forceContinueOnce = Boolean(resumeState && resumeState.forceContinueOnce);
  var maxAuthGates = agent && agent.MAX_AUTH_GATES ? agent.MAX_AUTH_GATES : 5;
  var logStep = (resumeState && resumeState.logStep) || 0;
  var startedAt = (resumeState && resumeState.startedAt) || Date.now();
  var parkedIdentity = (resumeState && resumeState.parkedIdentity) || "";

  if (!resumeState) {
    lastAgentRun = {
      status: "running",
      log: [],
      error: null,
      snapshot: null,
      redaction: null,
      ner: null,
      sanitizedScreenshot: null,
      sanitizedScreenshots: [],
      lastCapturedIdentity: null,
      nextScreen: 0,
      captureErrors: [],
      privacyManifest: null,
      timings: null,
      analysisMode: analysisMode,
      goal: goal,
      authGate: null,
      tabId: tab.id
    };
  } else {
    lastAgentRun.error = null;
    lastAgentRun.analysisMode = analysisMode;
    lastAgentRun.goal = goal;
    lastAgentRun.tabId = tab.id;
    if (lastAgentRun.status !== "waiting_for_user") {
      lastAgentRun.status = "running";
    }
  }
  stopAgentRequested = false;
  continueAgentRequested = false;
  pauseAgentRequested = false;
  agentLoopActive = true;
  syncLoopState = function () {
    loopState = {
      tabId: tab && tab.id,
      options: options,
      previousTurns: previousTurns,
      lastPlanFingerprint: lastPlanFingerprint,
      repeatedPlanCount: repeatedPlanCount,
      lastElementHints: lastElementHints,
      modelTurnsUsed: modelTurnsUsed,
      parkedMs: parkedMs,
      ignoredAuthGateKey: ignoredAuthGateKey,
      authGatePasses: authGatePasses,
      forceContinueOnce: forceContinueOnce,
      logStep: logStep,
      startedAt: startedAt,
      parkedIdentity: parkedIdentity
    };
  };
  persistAgentSession();

  try {
    while (true) {
      if (stopAgentRequested) {
        throw new Error("Agent stopped by the user.");
      }
      if (Date.now() - startedAt - parkedMs > maxRuntime) {
        throw new Error("Agent stopped at the total runtime limit.");
      }
      tab = await prepareTabForAgent(tab.id);

      var skipGateThisTurn = false;
      if (forceContinueOnce) {
        forceContinueOnce = false;
        skipGateThisTurn = true;
        lastAgentRun.status = "running";
        lastAgentRun.authGate = null;
        persistAgentSession();
      }

      var waitingManual =
        lastAgentRun.status === "waiting_for_user" &&
        lastAgentRun.authGate &&
        lastAgentRun.authGate.kind === "manual";
      if (!skipGateThisTurn && (pauseAgentRequested || waitingManual)) {
        pauseAgentRequested = false;
        modelTurnsUsed = 0;
        lastPlanFingerprint = "";
        repeatedPlanCount = 0;
        parkedIdentity = pageIdentity(tab);
        var manualGate = {
          kind: "manual",
          present: true,
          blocking: true,
          emptyCount: 1,
          filledCount: 0
        };
        var manualParkStarted = Date.now();
        var manualParked;
        try {
          manualParked = await waitForAuthGateClear(
            tab,
            options,
            agent,
            manualGate,
            Math.max(logStep, previousTurns.length, 1),
            parkedIdentity,
            { autoResume: false, maxWaitMs: agent.MAX_MANUAL_PAUSE_MS || 20 * 60 * 1000 }
          );
        } finally {
          parkedMs += Date.now() - manualParkStarted;
        }
        tab = manualParked.tab;
        ignoredAuthGateKey = "";
        await settleTab(tab.id);
        await sleep(400);
        continue;
      }

      if (modelTurnsUsed >= maxSteps) {
        break;
      }
      logStep += 1;
      var step = logStep - 1;
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
      if (turn.filledSecurityPin) {
        pushAgentLog({
          step: step + 1,
          phase: "apply",
          detail: "Filled the saved DigiLocker security PIN on the page."
        });
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
        var alreadyCaptured = pageIdentity(tab) === lastAgentRun.lastCapturedIdentity;
        if (!alreadyCaptured) {
          pushAgentLog({
            step: step + 1,
            phase: "vision",
            detail: "Creating a sanitized local screenshot."
          });
          var pixels = await captureAndKeep(
            tab,
            turn,
            options,
            analysisMode,
            step + 1,
            "observe",
            false
          );
          if (!pixels.ok) {
            if (analysisMode === "sanitized-image") {
              throw new Error(pixels.error);
            }
          } else {
            var combinedCategories = {};
            [
              networkPayload.privacyManifest && networkPayload.privacyManifest.categories,
              pixels.pixels.privacyManifest && pixels.pixels.privacyManifest.categories
            ].forEach(function (counts) {
              Object.keys(counts || {}).forEach(function (category) {
                combinedCategories[category] =
                  (combinedCategories[category] || 0) + Number(counts[category] || 0);
              });
            });
            lastAgentRun.privacyManifest = Object.assign({}, pixels.pixels.privacyManifest, {
              categories: combinedCategories
            });
            lastAgentRun.timings = Object.assign({}, lastAgentRun.timings, pixels.pixels.timings);
            networkPayload.privacyManifest = Object.assign(
              {},
              networkPayload.privacyManifest || {},
              pixels.pixels.privacyManifest || {},
              { sanitized: true, categories: combinedCategories }
            );
            if (analysisMode === "sanitized-image") {
              networkPayload.screenshot = pixels.pixels.screenshot;
            }
          }
        } else if (analysisMode === "sanitized-image" && lastAgentRun.sanitizedScreenshot) {
          networkPayload.screenshot = lastAgentRun.sanitizedScreenshot;
        }
      }

      var authGate = agent.findAuthGate(turn.payload.context);
      var gateIdentity = pageIdentity(tab);
      var thisGateKey = agent.authGateKey(gateIdentity, authGate);
      if (!skipGateThisTurn && pauseAgentRequested) {
        pauseAgentRequested = false;
        modelTurnsUsed = 0;
        lastPlanFingerprint = "";
        repeatedPlanCount = 0;
        parkedIdentity = gateIdentity;
        var midTurnGate = {
          kind: "manual",
          present: true,
          blocking: true,
          emptyCount: 1,
          filledCount: 0
        };
        var midParkStarted = Date.now();
        var midParked;
        try {
          midParked = await waitForAuthGateClear(
            tab,
            options,
            agent,
            midTurnGate,
            Math.max(step + 1, previousTurns.length, 1),
            gateIdentity,
            { autoResume: false, maxWaitMs: agent.MAX_MANUAL_PAUSE_MS || 20 * 60 * 1000 }
          );
        } finally {
          parkedMs += Date.now() - midParkStarted;
        }
        tab = midParked.tab;
        ignoredAuthGateKey = "";
        await settleTab(tab.id);
        await sleep(400);
        continue;
      }
      if (!skipGateThisTurn && authGate.blocking && thisGateKey !== ignoredAuthGateKey) {
        parkedIdentity = gateIdentity;
        modelTurnsUsed = 0;
        lastPlanFingerprint = "";
        repeatedPlanCount = 0;
        var parkStarted = Date.now();
        var parked;
        try {
          parked = await waitForAuthGateClear(
            tab,
            options,
            agent,
            authGate,
            Math.max(step + 1, previousTurns.length, 1),
            gateIdentity
          );
        } finally {
          parkedMs += Date.now() - parkStarted;
        }
        tab = parked.tab;
        ignoredAuthGateKey = parked.ignoreKey || "";
        authGatePasses += 1;
        if (authGatePasses > maxAuthGates) {
          throw new Error("Too many verification steps in one task.");
        }
        await settleTab(tab.id);
        await sleep(500);
        continue;
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
        if (llm.paused && !stopAgentRequested) {
          pauseAgentRequested = true;
          continue;
        }
        throw new Error(llm.error);
      }
      modelTurnsUsed += 1;
      lastAgentRun.timings = Object.assign({}, lastAgentRun.timings || {}, {
        serverMs: Math.round(performance.now() - llmStart),
        payloadBytes: llm.serializedBytes || 0
      });

      var parsed = agent.parseResponse(llm.text);
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }
      var stable = agent.stabilizeActions(
        parsed.actions,
        turn.payload.context,
        lastElementHints
      );
      if (stable.injectedPin) {
        parsed.done = false;
        pushAgentLog({
          step: step + 1,
          phase: "plan",
          detail: "Filling the saved DigiLocker security PIN."
        });
      }
      if (stable.dropped.length) {
        pushAgentLog({
          step: step + 1,
          phase: "plan",
          detail:
            "Page updated; remapped or dropped stale id(s): " + stable.dropped.join(", ") + "."
        });
      }
      var validated = agent.validateActions(
        stable.actions,
        turn.payload.context,
        networkPayload.goal || turn.payload.goal
      );
      if (!validated.ok) {
        throw new Error(validated.error);
      }
      if (validated.clampedWaits && validated.clampedWaits.length) {
        pushAgentLog({
          step: step + 1,
          phase: "plan",
          detail:
            "Shortened a wait to " +
            (agent.MAX_WAIT_MS || 5000) / 1000 +
            "s (page settle only). OTP still waits for you in the tab."
        });
      }
      var searchSplit = agent.splitSearchTurn(validated.actions, turn.payload.context);
      if (searchSplit.deferred) {
        parsed.done = false;
        if (searchSplit.actions.length !== validated.actions.length) {
          validated = { ok: true, actions: searchSplit.actions, errors: [] };
          pushAgentLog({
            step: step + 1,
            phase: "plan",
            detail: "Search first; waiting to open the named chat before typing a message."
          });
        }
      }
      var mismatched = agent.dropMismatchedChatClicks(
        validated.actions,
        turn.payload.context,
        goal
      );
      if (mismatched.dropped.length) {
        parsed.done = false;
        validated = { ok: true, actions: mismatched.actions, errors: [] };
        pushAgentLog({
          step: step + 1,
          phase: "plan",
          detail: "Ignored a row that was not the named chat: " + mismatched.dropped.join(", ") + "."
        });
      }
      var reduced = agent.dropRedundantActions(
        validated.actions,
        turn.payload.context,
        previousTurns,
        goal
      );
      if (reduced.dropped.length) {
        validated = { ok: true, actions: reduced.actions, errors: [] };
        pushAgentLog({
          step: step + 1,
          phase: "plan",
          detail: "Skipped a chat already opened: " + reduced.dropped.join(", ") + "."
        });
      }
      var premature = agent.dropPrematureComposer(
        validated.actions,
        turn.payload.context,
        previousTurns,
        goal
      );
      if (premature.dropped.length) {
        parsed.done = false;
        validated = { ok: true, actions: premature.actions, errors: [] };
        pushAgentLog({
          step: step + 1,
          phase: "plan",
          detail: "The open chat is not the named contact; not typing a message yet."
        });
      }
      var unfinished = agent.unfinishedGoalReason
        ? agent.unfinishedGoalReason(turn.payload.context, goal)
        : "";
      if (parsed.done && unfinished) {
        parsed.done = false;
        pushAgentLog({
          step: step + 1,
          phase: "plan",
          detail: "Ignoring done; " + unfinished + "."
        });
      }
      var onlyDoneAction =
        validated.actions.length === 1 && validated.actions[0].type === "done";
      if (
        unfinished &&
        agent.recoverUnfinishedAction &&
        (!validated.actions.length || onlyDoneAction)
      ) {
        var recoveredPlan = agent.recoverUnfinishedAction(turn.payload.context, goal);
        if (recoveredPlan) {
          var recoveredValid = agent.validateActions(
            [recoveredPlan],
            turn.payload.context,
            networkPayload.goal || turn.payload.goal
          );
          if (recoveredValid.ok && recoveredValid.actions.length) {
            validated = recoveredValid;
            parsed.done = false;
            pushAgentLog({
              step: step + 1,
              phase: "plan",
              detail:
                "The goal is not complete (" +
                unfinished +
                "). Using " +
                recoveredPlan.type +
                " on " +
                recoveredPlan.elementId +
                "."
            });
          }
        }
      }
      var composer = agent.findComposerElement(turn.payload.context);
      var goalMessage = agent.messageFromGoal(goal);
      if (
        !validated.actions.length &&
        composer &&
        goalMessage &&
        agent.namedChatIsOpen(turn.payload.context, goal) &&
        agent.textIsGrounded("fill", goalMessage, goal)
      ) {
        var recovery = [{ type: "fill", elementId: composer.id, text: goalMessage }];
        if (options.allowDestructive === true) {
          recovery.push({ type: "press", elementId: composer.id, key: "Enter" });
        }
        var recovered = agent.validateActions(
          recovery,
          turn.payload.context,
          networkPayload.goal || turn.payload.goal
        );
        if (recovered.ok && recovered.actions.length) {
          validated = recovered;
          pushAgentLog({
            step: step + 1,
            phase: "plan",
            detail: "Named chat is open; typing the goal message in the composer."
          });
        }
      }
      var destructive = validated.actions.filter(function (action) {
        return agent.isDestructiveAction(action, turn.payload.context);
      });
      if (destructive.length && options.allowDestructive !== true) {
        throw new Error("A submit, send, purchase, or destructive action requires user confirmation.");
      }
      var fingerprint = agent.logicalPlanKey(validated.actions, turn.payload.context);
      if (fingerprint === lastPlanFingerprint) {
        repeatedPlanCount += 1;
      } else {
        repeatedPlanCount = 0;
        lastPlanFingerprint = fingerprint;
      }
      if (repeatedPlanCount >= 2) {
        var retryingOpen =
          agent.goalContactName(goal) &&
          !agent.namedChatIsOpen(turn.payload.context, goal) &&
          validated.actions.every(function (action) {
            var el = (turn.payload.context.elements || []).find(function (element) {
              return element.id === action.elementId;
            });
            return (
              action.type === "wait" ||
              (action.type === "click" && el && agent.isGoalContactRow(el, goal))
            );
          });
        if (!retryingOpen) {
          throw new Error("Agent stopped after receiving the same no-progress plan repeatedly.");
        }
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

      if (!validated.actions.length) {
        lastElementHints = ((turn.payload.context && turn.payload.context.elements) || [])
          .map(agent.compactElementHint)
          .filter(Boolean);
        var chatOpen =
          Boolean(agent.goalContactName(goal)) && agent.namedChatIsOpen(turn.payload.context, goal);
        if (parsed.done) {
          if ((agent.goalContactName(goal) && !chatOpen) || unfinished) {
            parsed.done = false;
            pushAgentLog({
              step: step + 1,
              phase: "plan",
              detail: unfinished
                ? "Ignoring done; " + unfinished + "."
                : "Ignoring done; the named chat is not open yet."
            });
          } else {
            finished = true;
            pushAgentLog({
              step: step + 1,
              phase: "done",
              detail: "The model marked the goal complete."
            });
            break;
          }
        }
        pushAgentLog({
          step: step + 1,
          phase: "plan",
          detail: unfinished
            ? "The goal is not complete (" + unfinished + "). Taking another look."
            : chatOpen
              ? "The named chat is already open. Fill Type a message on the next snapshot."
              : agent.goalContactName(goal)
                ? "The named chat is not open yet. Taking a fresh snapshot."
                : "Old element ids were stale after the page updated. Taking a fresh snapshot."
        });
        previousTurns.push({
          actions: [],
          results: [],
          elements: lastElementHints
        });
        continue;
      }
      if (validated.actions.length === 1 && validated.actions[0].type === "done") {
        if (unfinished) {
          parsed.done = false;
          pushAgentLog({
            step: step + 1,
            phase: "plan",
            detail: "Ignoring done; " + unfinished + "."
          });
        } else {
          finished = true;
          pushAgentLog({
            step: step + 1,
            phase: "done",
            detail: validated.actions[0].reason || "The model stopped."
          });
          break;
        }
      }

      var beforePage = pageIdentity(tab);
      var followed = await applyPlanAndFollowTab(tab, validated.actions, {
        allowHighRiskProfile: Boolean(options && options.allowHighRiskProfile),
        goal: goal
      });
      var applied = followed.applied;
      if (followed.tab && followed.tab.id != null) {
        tab = followed.tab;
      }
      tab = await activateTab(tab);
      var failed = applied.results.filter(function (item) {
        return !item.ok;
      })[0];
      var skipped = applied.results.filter(function (item) {
        return item.skipped;
      });
      var skipReason = (skipped[0] && skipped[0].reason) || "";
      pushAgentLog({
        step: step + 1,
        phase: "apply",
        detail: failed
          ? failed.error
          : skipped.length === applied.results.length && skipped.length
            ? "Skipped: " + (skipReason || "the fill did not match the field.")
            : skipped.length
              ? "Applied with " + skipped.length + " fill(s) skipped."
              : "Applied " + applied.results.length + " action(s).",
        results: applied.results.map(function (item) {
          return {
            ok: item.ok,
            skipped: Boolean(item.skipped),
            type: item.type,
            elementId: item.elementId,
            error: item.error || null,
            reason: item.reason || null
          };
        })
      });
      if (!applied.ok || failed) {
        throw new Error((failed && failed.error) || "Applying actions failed.");
      }
      if (skipped.length && skipped.length === applied.results.length) {
        throw new Error(
          (skipReason || "The planned fill was skipped.") +
            " The page did not change. For a chat, fill the message box with words from your goal, then click send."
        );
      }

      previousTurns.push({
        actions: validated.actions,
        results: applied.results.map(function (item) {
          return {
            ok: item.ok,
            skipped: Boolean(item.skipped),
            type: item.type,
            elementId: item.elementId,
            error: item.error || item.reason || null
          };
        }),
        elements: ((turn.payload.context && turn.payload.context.elements) || [])
          .map(agent.compactElementHint)
          .filter(Boolean),
        note: String((turn.payload.context && turn.payload.context.observation) || "").slice(0, 240)
      });
      lastElementHints = previousTurns[previousTurns.length - 1].elements;

      await settleTab(tab.id);
      if (agent.actionsMayNavigate(validated.actions)) {
        await sleep(900);
        await settleTab(tab.id);
      }
      if (
        validated.actions.some(function (action) {
          var el = (turn.payload.context.elements || []).find(function (element) {
            return element.id === action.elementId;
          });
          return action.type === "fill" && el && agent.isSearchField(el);
        })
      ) {
        await sleep(1500);
      }
      if (
        validated.actions.some(function (action) {
          var el = (turn.payload.context.elements || []).find(function (element) {
            return element.id === action.elementId;
          });
          return action.type === "click" && el && agent.isGoalContactRow(el, goal);
        })
      ) {
        await sleep(800);
      }
      try {
        tab = await chrome.tabs.get(tab.id);
      } catch (error) {
        tab = followed.tab || tab;
      }
      var pageChanged = pageIdentity(tab) !== beforePage;
      if (analysisMode !== "dom") {
        try {
          tab = await prepareTabForAgent(tab.id);
          var afterTurn = await chrome.tabs.sendMessage(tab.id, {
            type: MSG.AGENT_TURN,
            mode: (options && options.contextMode) || "visible",
            sensitivityPolicy: (options && options.sensitivityPolicy) || null,
            goal: goal,
            history: previousTurns,
            runNer: false
          });
          if (afterTurn && afterTurn.ok) {
            pushAgentLog({
              step: step + 1,
              phase: "vision",
              detail: "Capturing the screen after actions."
            });
            await captureAndKeep(
              tab,
              afterTurn,
              options,
              analysisMode,
              step + 1,
              pageChanged ? "after" : "after",
              true
            );
          }
        } catch (afterError) {
          rememberCaptureError(
            afterError && afterError.message ? afterError.message : String(afterError)
          );
          pushAgentLog({
            step: step + 1,
            phase: "vision",
            detail:
              "Could not snapshot the resulting screen. " +
              (afterError && afterError.message ? afterError.message : String(afterError))
          });
        }
      }
      if (parsed.done && agent.actionsMayNavigate(validated.actions)) {
        parsed.done = false;
        pushAgentLog({
          step: step + 1,
          phase: "plan",
          detail: pageChanged
            ? "The page changed; capturing the next screen before treating the goal as done."
            : "A click was applied; taking another snapshot of the resulting screen."
        });
      }

      if (parsed.done) {
        if (
          (agent.goalContactName(goal) && !agent.namedChatIsOpen(turn.payload.context, goal)) ||
          unfinished
        ) {
          parsed.done = false;
        } else {
          finished = true;
          pushAgentLog({ step: step + 1, phase: "done", detail: "The model marked the goal complete." });
          break;
        }
      }
    }

    if (!finished && lastAgentRun.status === "running") {
      pushAgentLog({
        step: Math.max(modelTurnsUsed, 1),
        phase: "done",
        detail: "Stopped after " + maxSteps + " model turns."
      });
    }

    if (analysisMode !== "dom" && tab && tab.id != null) {
      try {
        tab = await activateTab(tab);
        await settleTab(tab.id);
        if (pageIdentity(tab) !== lastAgentRun.lastCapturedIdentity) {
          pushAgentLog({
            step: Math.max(previousTurns.length, 1),
            phase: "vision",
            detail: "Capturing the screen after the last navigation."
          });
          tab = await prepareTabForAgent(tab.id);
          var extraTurn = await chrome.tabs.sendMessage(tab.id, {
            type: MSG.AGENT_TURN,
            mode: (options && options.contextMode) || "visible",
            sensitivityPolicy: (options && options.sensitivityPolicy) || null,
            goal: goal,
            history: previousTurns,
            runNer: true
          });
          if (extraTurn && extraTurn.ok) {
            await captureAndKeep(
              tab,
              extraTurn,
              options,
              analysisMode,
              Math.max(previousTurns.length, 1),
              "final",
              true
            );
          }
        }
      } catch (captureError) {
        pushAgentLog({
          step: Math.max(previousTurns.length, 1),
          phase: "vision",
          detail:
            "Could not capture the last screen. " +
            (captureError && captureError.message ? captureError.message : String(captureError))
        });
      }
    }

    lastAgentRun.status = "done";
    lastAgentRun.authGate = null;
    syncLoopState = function () {};
    loopState = null;
    persistAgentSession();
    broadcastAgentStatus({ finished: true, ok: true });
    return agentRunPublicState({
      ok: true,
      timings: Object.assign({}, lastAgentRun.timings || {}, {
        totalAgentMs: Date.now() - startedAt - parkedMs,
        waitedForUserMs: parkedMs,
        heapEstimateBytes: heapEstimateBytes()
      })
    });
  } catch (error) {
    lastAgentRun.status = stopAgentRequested ? "stopped" : "error";
    lastAgentRun.error = error && error.message ? error.message : String(error);
    lastAgentRun.authGate = null;
    persistAgentSession();
    pushAgentLog({
      step: Math.max(logStep, previousTurns.length, 1),
      phase: lastAgentRun.status,
      detail: lastAgentRun.error
    });
    broadcastAgentStatus({ finished: true, ok: false });
    return agentRunPublicState({
      ok: false,
      error: lastAgentRun.error,
      timings: Object.assign({}, lastAgentRun.timings || {}, {
        totalAgentMs: Date.now() - startedAt - parkedMs,
        waitedForUserMs: parkedMs,
        heapEstimateBytes: heapEstimateBytes()
      })
    });
  } finally {
    agentLoopActive = false;
  }
}

async function resumePersistedRun() {
  if (agentLoopActive) {
    return;
  }
  if (!loopState || loopState.tabId == null || !loopState.options) {
    return;
  }
  var tab;
  try {
    tab = await chrome.tabs.get(loopState.tabId);
  } catch (error) {
    lastAgentRun.status = "error";
    lastAgentRun.error = "The tab closed while waiting for verification.";
    lastAgentRun.authGate = null;
    persistAgentSession();
    broadcastAgentStatus({ finished: true, ok: false });
    return;
  }
  pushAgentLog({
    step: Math.max(loopState.logStep || 1, 1),
    phase: "await_user",
    detail: "Still waiting for you in the tab. Closing this popup does not stop the task."
  });
  return runAgent(tab, loopState.options, loopState);
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

function hostAccessMessage(url, error) {
  var raw = error && error.message ? error.message : String(error || "");
  if (!/Cannot access/i.test(raw) && !/must request permission/i.test(raw)) {
    return raw;
  }
  if (url && !isInjectableUrl(url)) {
    return restrictedPageMessage(url);
  }
  return (
    "Chrome blocked reading this page after a navigation" +
    (url ? " (" + url + ")" : "") +
    ". Reload the unpacked extension at chrome://extensions so it can access websites, then run the agent again."
  );
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: CONTENT_SCRIPT_FILES
  });
}

async function prepareTabForAgent(tabId) {
  await settleTab(tabId);
  var tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    throw new Error("The tab was closed.");
  }
  if (!isInjectableUrl(tab.url)) {
    throw new Error(restrictedPageMessage(tab.url));
  }
  try {
    await ensureContentScript(tab.id);
  } catch (error) {
    throw new Error(hostAccessMessage(tab.url, error));
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function connectAgentKeepalivePort() {
        try {
          if (globalThis.__browserAgentKeepalivePort) {
            return;
          }
          var port = chrome.runtime.connect({ name: "agent-keepalive" });
          globalThis.__browserAgentKeepalivePort = port;
          port.onDisconnect.addListener(function () {
            globalThis.__browserAgentKeepalivePort = null;
          });
        } catch (error) {
          globalThis.__browserAgentKeepalivePort = null;
        }
      }
    });
  } catch (keepaliveError) {
    /* Best-effort: polling still works without a port. */
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: MSG.AGENT_KEEPALIVE_START });
  } catch (keepaliveError) {
    /* Port is best-effort; the next extract still injects the script. */
  }
  return tab;
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
    if (/Cannot access/i.test(message) || /Cannot access contents/i.test(message) || /must request permission/i.test(message)) {
      return { ok: false, error: hostAccessMessage(tab.url, error) };
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
      if (/Receiving end does not exist|message port closed/i.test(String(error && error.message))) {
        try {
          await chrome.offscreen.closeDocument();
        } catch (closeError) {
          /* Recreate below. */
        }
        await ensureOffscreen();
      }
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

  var captureStart = performance.now();
  var captured = await captureVisibleImage(tab);
  if (!captured.ok) {
    return {
      ok: false,
      error: captured.error,
      snapshot: snapshot,
      redaction: redaction
    };
  }
  var imageDataUrl = captured.imageDataUrl;
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

var hydratePromise = (async function hydrateAgentSession() {
  if (!chrome.storage || !chrome.storage.session) {
    return;
  }
  try {
    var data = await chrome.storage.session.get(AGENT_SESSION_KEY);
    var session = data && data.agentSession;
    if (!session) {
      return;
    }
    lastAgentRun.status = session.status || "idle";
    lastAgentRun.goal = session.goal || "";
    lastAgentRun.error = session.error || null;
    lastAgentRun.log = session.log || [];
    lastAgentRun.authGate = session.authGate || null;
    lastAgentRun.analysisMode = session.analysisMode || null;
    lastAgentRun.tabId = session.tabId;
    loopState = session.loopState || null;
    if (session.tabId != null) {
      try {
        await chrome.tabs.get(session.tabId);
      } catch (gone) {
        clearAgentRun("idle");
        persistAgentSession();
        return;
      }
    }
    if (
      session.status === "waiting_for_user" &&
      loopState &&
      loopState.tabId != null &&
      !agentLoopActive
    ) {
      resumePersistedRun();
    }
    syncAgentBadge();
  } catch (error) {
    /* Fresh worker; start idle. */
  }
})();

chrome.runtime.onConnect.addListener(function (port) {
  if (!port || port.name !== "agent-keepalive") {
    return;
  }
  port.onMessage.addListener(function () {});
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  hydratePromise.then(function () {
    if (lastAgentRun.tabId !== tabId) {
      return;
    }
    stopAgentRequested = true;
    continueAgentRequested = false;
    pauseAgentRequested = false;
    if (activeAgentAbort) {
      activeAgentAbort.abort();
    }
    clearAgentRun("idle");
    persistAgentSession();
    broadcastAgentStatus({ finished: true, ok: true, status: "idle", tabId: tabId });
  });
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (changeInfo.status !== "complete" && !changeInfo.url) {
    return;
  }
  hydratePromise.then(function () {
    if (lastAgentRun.status !== "waiting_for_user" || !loopState || loopState.tabId !== tabId) {
      return;
    }
    if (!agentLoopActive) {
      resumePersistedRun();
    }
  });
});

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
      try {
        var tab = await getActionTab(sender);
        sendResponse(await analyzeTab(tab, message.mode, message.sensitivityPolicy));
      } catch (error) {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error)
        });
      }
    })();
    return true;
  }

  if (message.type === MSG.AGENT_STATUS) {
    (async function () {
      await hydratePromise;
      if (message.anyTab) {
        sendResponse(agentRunPublicState({ ok: true }));
        return;
      }
      if (message.tabId != null) {
        sendResponse(agentStatusForView(message.tabId));
        return;
      }
      try {
        var tab = await getActionTab(sender);
        sendResponse(agentStatusForView(tab && tab.id));
      } catch (error) {
        sendResponse(idleAgentPublicState());
      }
    })();
    return true;
  }

  if (message.type === MSG.AUTH_GATE_UPDATE) {
    hydratePromise.then(function () {
      if (lastAgentRun.status !== "waiting_for_user") {
        return;
      }
      if (!agentLoopActive) {
        resumePersistedRun();
      }
    });
    return;
  }

  if (message.type === MSG.STOP_AGENT) {
    stopAgentRequested = true;
    continueAgentRequested = false;
    pauseAgentRequested = false;
    if (activeAgentAbort) {
      activeAgentAbort.abort();
    }
    lastAgentRun.status = "stopped";
    lastAgentRun.authGate = null;
    persistAgentSession();
    broadcastAgentStatus({ finished: true, ok: false });
    if (lastAgentRun.tabId != null) {
      chrome.tabs.sendMessage(
        lastAgentRun.tabId,
        { type: MSG.AGENT_PAUSE_BANNER, show: false },
        function () {
          void chrome.runtime.lastError;
        }
      );
    }
    sendResponse({ ok: true, status: "stopped" });
    return;
  }

  if (message.type === MSG.CONTINUE_AGENT) {
    hydratePromise.then(function () {
      sendResponse(requestAgentContinue());
    });
    return true;
  }

  if (message.type === MSG.TOGGLE_AGENT_PAUSE) {
    hydratePromise.then(function () {
      sendResponse(toggleAgentPause());
    });
    return true;
  }

  if (message.type === MSG.RUN_AGENT) {
    (async function () {
      var replied = false;
      try {
        await hydratePromise;
        var tab = await getActionTab(sender);
        if (isAgentBusy()) {
          var otherTab = lastAgentRun.tabId != null && (!tab || lastAgentRun.tabId !== tab.id);
          sendResponse(
            Object.assign(agentStatusForView(tab && tab.id, { ok: false }), {
              error: otherTab
                ? "An agent run is already in progress in another tab."
                : "An agent run is already in progress."
            })
          );
          return;
        }
        lastAgentRun.status = "running";
        lastAgentRun.goal = String(message.goal || "");
        sendResponse(agentRunPublicState({ ok: true, accepted: true }));
        replied = true;
        await runAgent(tab, message);
      } catch (error) {
        var err = error && error.message ? error.message : String(error);
        if (!replied) {
          sendResponse({
            ok: false,
            error: err,
            log: lastAgentRun.log
          });
          return;
        }
        lastAgentRun.status = "error";
        lastAgentRun.error = err;
        lastAgentRun.authGate = null;
        persistAgentSession();
        broadcastAgentStatus({ finished: true, ok: false });
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

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(function (command) {
    if (command !== "toggle-agent-pause") {
      return;
    }
    hydratePromise.then(function () {
      toggleAgentPause();
    });
  });
}
