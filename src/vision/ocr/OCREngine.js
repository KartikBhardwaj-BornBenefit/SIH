/**
 * Browser OCR experiment using Tesseract.js.
 * Separate from object detection. Not the final OCR stack.
 */
export class TesseractAdapter {
  constructor() {
    this.id = "tesseract";
    this.displayName = "Tesseract.js (experimental)";
    this.worker = null;
    this.loadTimeMs = null;
    this.backend = "wasm";
  }

  async load() {
    if (this.worker) {
      return { loadTimeMs: this.loadTimeMs, backend: this.backend };
    }
    var start = performance.now();
    var tesseract = await import("tesseract.js");
    var options = {
      logger: function () {},
      workerBlobURL: false
    };
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
      options.workerPath = chrome.runtime.getURL("vendor/tesseract/worker.min.js");
      options.corePath = chrome.runtime.getURL("vendor/tesseract");
      options.langPath = chrome.runtime.getURL("vendor/tesseract/lang");
      options.gzip = true;
    }
    this.worker = await tesseract.createWorker("eng", 1, options);
    this.loadTimeMs = Math.round(performance.now() - start);
    return { loadTimeMs: this.loadTimeMs, backend: this.backend };
  }

  async extractText(image) {
    if (!this.worker) {
      await this.load();
    }
    var start = performance.now();
    var result = await this.worker.recognize(image);
    var inferenceTimeMs = Math.round(performance.now() - start);
    var data = result && result.data ? result.data : {};
    var words = Array.isArray(data.words) ? data.words : [];
    var items = words
      .map(function (word) {
        var box = word.bbox || {};
        return {
          text: word.text || "",
          confidence: typeof word.confidence === "number" ? word.confidence / 100 : 0,
          boundingBox: {
            x: Math.round(box.x0 || 0),
            y: Math.round(box.y0 || 0),
            width: Math.round((box.x1 || 0) - (box.x0 || 0)),
            height: Math.round((box.y1 || 0) - (box.y0 || 0))
          }
        };
      })
      .filter(function (item) {
        return item.text && item.text.trim();
      });

    return {
      text: (data.text || "").trim(),
      items: items,
      inferenceTimeMs: inferenceTimeMs,
      modelLoadTimeMs: this.loadTimeMs,
      model: this.displayName,
      backend: this.backend,
      screenshotLeftDevice: false
    };
  }
}

export class OCREngine {
  constructor(adapter) {
    this.adapter = adapter || new TesseractAdapter();
    this.status = "idle";
  }

  async init() {
    this.status = "loading";
    await this.adapter.load();
    this.status = "ready";
    return { status: this.status, model: this.adapter.displayName };
  }

  async extractText(image) {
    return this.adapter.extractText(image);
  }
}
