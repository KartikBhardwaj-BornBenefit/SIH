/**
 * Offscreen document: owns the local VisionEngine, OCREngine, and NerEngine.
 * Screenshots and text are received in messages and never fetched remotely.
 *
 * The NER engine is loaded separately from vision, and only on demand. Vision
 * is also on demand now: loading both on document create made the first
 * Analyze compete with YOLOS for bandwidth and the WASM thread.
 */
import { VisionEngine } from "../vision/VisionEngine.js";
import { YuNetFaceAdapter } from "../vision/adapters/YuNetFaceAdapter.js";
import { OCREngine, TesseractAdapter } from "../vision/ocr/OCREngine.js";
import { NerEngine } from "../nlp/NerEngine.js";
import { BertBaseNerAdapter } from "../nlp/adapters/BertBaseNerAdapter.js";
import "../utils/sensitivityCatalog.js";
import "../utils/validators.js";
import "../utils/sensitivity.js";
import { normalizeDetections, sanitizeScreenshot } from "../privacy/sanitizer.js";

var MSG = {
  OFFSCREEN_LOAD: "OFFSCREEN_LOAD",
  OFFSCREEN_ANALYZE: "OFFSCREEN_ANALYZE",
  OFFSCREEN_STATUS: "OFFSCREEN_STATUS",
  OFFSCREEN_NER_LOAD: "OFFSCREEN_NER_LOAD",
  OFFSCREEN_NER_ANALYZE: "OFFSCREEN_NER_ANALYZE",
  OFFSCREEN_NER_STATUS: "OFFSCREEN_NER_STATUS"
};

var visionEngine = new VisionEngine(new YuNetFaceAdapter());
var ocrEngine = new OCREngine(new TesseractAdapter());
var nerEngine = new NerEngine(new BertBaseNerAdapter());
nerEngine.adapter.onProgress = function (info) {
  postNerProgress(info);
};
var ocrReady = false;
var loadPromise = null;
var nerLoadPromise = null;

function safeOcrMetadata(ocr) {
  if (!ocr) {
    return null;
  }
  return {
    items: (ocr.items || []).map(function (item) {
      return {
        confidence: item.confidence,
        boundingBox: item.boundingBox,
        sensitivity: item.sensitivity,
        sensitivityCategories: item.sensitivityCategories || [],
        redactedText: "<IMAGE_TEXT>"
      };
    }),
    inferenceTimeMs: ocr.inferenceTimeMs,
    modelLoadTimeMs: ocr.modelLoadTimeMs,
    model: ocr.model,
    backend: ocr.backend,
    screenshotLeftDevice: false,
    rawTextRetained: false
  };
}

function downscaleDataUrl(dataUrl, maxEdge) {
  return new Promise(function (resolve) {
    var img = new Image();
    img.onload = function () {
      var width = img.naturalWidth || img.width;
      var height = img.naturalHeight || img.height;
      var edge = Math.max(width, height);
      if (!maxEdge || edge <= maxEdge) {
        resolve({ dataUrl: dataUrl, width: width, height: height });
        return;
      }
      var scale = maxEdge / edge;
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve({
        dataUrl: canvas.toDataURL("image/jpeg", 0.82),
        width: canvas.width,
        height: canvas.height
      });
    };
    img.onerror = function () {
      resolve({ dataUrl: dataUrl, width: 0, height: 0 });
    };
    img.src = dataUrl;
  });
}

function imageSize(dataUrl) {
  return new Promise(function (resolve) {
    var img = new Image();
    img.onload = function () {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = function () {
      resolve({ width: 0, height: 0 });
    };
    img.src = dataUrl;
  });
}

function postNerProgress(info) {
  if (!info) {
    return;
  }
  var loaded = Number(info.loaded) || 0;
  var total = Number(info.total) || 0;
  var raw = Number(info.progress);
  var percent = null;
  if (total) {
    percent = Math.round((loaded / total) * 100);
  } else if (!isNaN(raw)) {
    percent = raw <= 1 ? Math.round(raw * 100) : Math.round(raw);
  }
  var payload = {
    type: MSG.OFFSCREEN_NER_STATUS,
    status: "loading",
    model: nerEngine.adapter && nerEngine.adapter.displayName,
    modelId: nerEngine.adapter && nerEngine.adapter.modelId,
    file: info.file || info.name || "",
    progress: percent,
    loaded: loaded,
    total: total
  };
  chrome.runtime.sendMessage(payload).catch(function () {});
}

function postStatus() {
  var payload = Object.assign({ type: MSG.OFFSCREEN_STATUS }, visionEngine.getStatus());
  chrome.runtime.sendMessage(payload).catch(function () {});
}

async function ensureLoaded(preferredDevice) {
  if (visionEngine.status === "ready") {
    return visionEngine.getStatus();
  }
  if (!loadPromise) {
    loadPromise = visionEngine.init(preferredDevice).finally(function () {
      if (visionEngine.status !== "ready") {
        loadPromise = null;
      }
    });
  }
  return loadPromise;
}

async function ensureNerLoaded(preferredDevice) {
  if (nerEngine.status === "ready") {
    return nerEngine.getStatus();
  }
  if (!nerLoadPromise) {
    nerLoadPromise = nerEngine.init(preferredDevice).finally(function () {
      if (nerEngine.status !== "ready") {
        nerLoadPromise = null;
      }
    });
  }
  return nerLoadPromise;
}

chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
  if (!message || !message.type) {
    return;
  }

  if (message.type === MSG.OFFSCREEN_STATUS) {
    sendResponse(visionEngine.getStatus());
    return;
  }

  if (message.type === MSG.OFFSCREEN_LOAD) {
    (async function () {
      try {
        postStatus();
        var status = await ensureLoaded(message.preferredDevice);
        sendResponse({ ok: true, status: status });
      } catch (error) {
        sendResponse({
          ok: false,
          status: visionEngine.getStatus(),
          error: error && error.message ? error.message : String(error)
        });
      }
    })();
    return true;
  }

  if (message.type === MSG.OFFSCREEN_ANALYZE) {
    (async function () {
      var totalStart = performance.now();
      try {
        await ensureLoaded(message.preferredDevice);
        var scaled = await downscaleDataUrl(message.imageDataUrl, 1600);
        var imageDataUrl = scaled.dataUrl;
        var size = { width: scaled.width, height: scaled.height };
        if (!size.width || !size.height) {
          size = await imageSize(imageDataUrl);
        }
        var vision = await visionEngine.analyze(imageDataUrl, size);
        var ocr = null;
        if (message.runOcr) {
          try {
            if (!ocrReady) {
              await ocrEngine.init();
              ocrReady = true;
            }
            ocr = await ocrEngine.extractText(imageDataUrl);
          } catch (ocrError) {
            ocr = null;
          }
        }
        var sensitivity = globalThis.BrowserAgent && globalThis.BrowserAgent.sensitivity;
        if (sensitivity && sensitivity.annotatePixelSensitivity) {
          var annotated = sensitivity.annotatePixelSensitivity(
            vision,
            ocr,
            message.snapshot,
            message.sensitivityPolicy
          );
          vision = Object.assign({}, vision, { detections: annotated.detections });
          if (ocr) {
            ocr = Object.assign({}, ocr, { items: annotated.ocrItems });
          }
        }
        var sanitization = null;
        if (message.sanitize) {
          var normalized = normalizeDetections(
            message.snapshot,
            message.redaction,
            vision,
            ocr
          );
          sanitization = await sanitizeScreenshot(imageDataUrl, normalized, {
            quality: message.imageQuality,
            faceMode: message.faceMode
          });
        }
        var publicOcr = safeOcrMetadata(ocr);
        ocr = null;
        sendResponse({
          ok: true,
          vision: vision,
          ocr: publicOcr,
          sanitization: sanitization,
          timings: {
            visionMs: vision.totalProcessingTimeMs || vision.inferenceTimeMs || 0,
            ocrMs: (publicOcr && publicOcr.inferenceTimeMs) || 0,
            redactionMs: (sanitization && sanitization.processingTimeMs) || 0,
            totalMs: Math.round(performance.now() - totalStart)
          },
          wallTimeMs: Math.round(performance.now() - totalStart)
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error),
          status: visionEngine.getStatus()
        });
      }
    })();
    return true;
  }

  if (message.type === MSG.OFFSCREEN_NER_STATUS) {
    sendResponse(nerEngine.getStatus());
    return;
  }

  if (message.type === MSG.OFFSCREEN_NER_LOAD) {
    (async function () {
      try {
        var status = await ensureNerLoaded(message.preferredDevice);
        sendResponse({ ok: true, status: status });
      } catch (error) {
        sendResponse({
          ok: false,
          status: nerEngine.getStatus(),
          error: error && error.message ? error.message : String(error)
        });
      }
    })();
    return true;
  }

  if (message.type === MSG.OFFSCREEN_NER_ANALYZE) {
    (async function () {
      try {
        await ensureNerLoaded(message.preferredDevice);
        var ner = await nerEngine.analyze(message.texts || []);
        sendResponse({ ok: true, ner: ner });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error),
          status: nerEngine.getStatus()
        });
      }
    })();
    return true;
  }
});

// Vision is loaded on VISION_INIT, not here. Starting both models on document
// create made the first Analyze compete with YOLOS for bandwidth and the
// WASM thread, which is why a 66 MB name model felt like it never finished.
