/**
 * Background service worker (Manifest V3).
 *
 * Injects content scripts and relays messages. The snapshot it forwards is
 * already redacted by the content script, so this file never sees an
 * unredacted one. It relays the session vault to the popup without retaining
 * it: nothing here is kept between messages and nothing is written to storage.
 *
 * Vision runs in an offscreen document so screenshots never leave the device
 * and the service worker is not used as an inference runtime.
 */

var MSG = {
  PING: "PING",
  EXTRACT_DOM: "EXTRACT_DOM",
  FILL_FROM_VAULT: "FILL_FROM_VAULT",
  ANALYZE_PAGE: "ANALYZE_PAGE",
  VISION_INIT: "VISION_INIT",
  VISION_STATUS: "VISION_STATUS",
  ANALYZE_SCREEN: "ANALYZE_SCREEN",
  OFFSCREEN_LOAD: "OFFSCREEN_LOAD",
  OFFSCREEN_ANALYZE: "OFFSCREEN_ANALYZE",
  OFFSCREEN_STATUS: "OFFSCREEN_STATUS"
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
  "src/content/content.js"
];

var lastVisionStatus = {
  status: "idle",
  model: "YOLOS-Tiny (baseline)",
  backend: null,
  error: null
};

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
      "Run local ONNX object detection and OCR. Screenshots are not uploaded."
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

async function analyzeScreen(options) {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var tab = tabs[0];
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
  var domResult = await analyzeTab(tab, "viewport", policy);
  var snapshot = domResult && domResult.ok ? domResult.snapshot : null;
  // Records only: the canvas needs element ids and placeholders to draw masks,
  // never the values. The vault is deliberately not forwarded on this path.
  var redaction = domResult && domResult.ok ? domResult.redaction : null;

  var imageDataUrl;
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

  var visionResponse = await sendToOffscreen({
    type: MSG.OFFSCREEN_ANALYZE,
    imageDataUrl: imageDataUrl,
    runOcr: Boolean(options && options.runOcr)
  });

  if (!visionResponse || !visionResponse.ok) {
    return {
      ok: false,
      error: (visionResponse && visionResponse.error) || "Local vision inference failed.",
      snapshot: snapshot,
      redaction: redaction
    };
  }

  return {
    ok: true,
    imageDataUrl: imageDataUrl,
    snapshot: snapshot,
    redaction: redaction,
    vision: visionResponse.vision,
    ocr: visionResponse.ocr || null,
    wallTimeMs: visionResponse.wallTimeMs,
    screenshotLeftDevice: false
  };
}

chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
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

  if (message.type === MSG.ANALYZE_PAGE) {
    (async function () {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      var result = await analyzeTab(tabs[0], message.mode, message.sensitivityPolicy);
      sendResponse(result);
    })();
    return true;
  }

  // De-referencing relay. Carries a placeholder and an element id, never a
  // value, so the payload is safe even though it passes through here.
  if (message.type === MSG.FILL_FROM_VAULT) {
    (async function () {
      try {
        var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        var tab = tabs[0];
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

  if (message.type === MSG.ANALYZE_SCREEN) {
    (async function () {
      try {
        var result = await analyzeScreen(message);
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
