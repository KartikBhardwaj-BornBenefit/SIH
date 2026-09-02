/**
 * Offscreen document: owns the local VisionEngine and OCREngine.
 * Screenshots are received as data URLs and never fetched remotely.
 */
import { VisionEngine } from "../vision/VisionEngine.js";
import { YolosTinyAdapter } from "../vision/adapters/YolosTinyAdapter.js";
import { OCREngine, TesseractAdapter } from "../vision/ocr/OCREngine.js";

var MSG = {
  OFFSCREEN_LOAD: "OFFSCREEN_LOAD",
  OFFSCREEN_ANALYZE: "OFFSCREEN_ANALYZE",
  OFFSCREEN_STATUS: "OFFSCREEN_STATUS"
};

var visionEngine = new VisionEngine(new YolosTinyAdapter());
var ocrEngine = new OCREngine(new TesseractAdapter());
var ocrReady = false;
var loadPromise = null;

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
        var size = await imageSize(message.imageDataUrl);
        var vision = await visionEngine.analyze(message.imageDataUrl, size);
        var ocr = null;
        if (message.runOcr) {
          if (!ocrReady) {
            await ocrEngine.init();
            ocrReady = true;
          }
          ocr = await ocrEngine.extractText(message.imageDataUrl);
        }
        sendResponse({
          ok: true,
          vision: vision,
          ocr: ocr,
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
});

ensureLoaded().then(postStatus).catch(postStatus);
