/**
 * YOLOS-Tiny baseline detector via Transformers.js.
 *
 * This is an experimental on-device model, not a production PII detector.
 * It predicts COCO-style classes (person, car, …). It cannot read passwords,
 * emails, or placeholder widgets; those stay a DOM problem. Inference does
 * not paint privacy masks (`redactPixels: false`). Weights are the public
 * Xenova/yolos-tiny checkpoint — they are not fine-tuned in this project.
 */
import { pipeline, env } from "@huggingface/transformers";
import { ModelAdapter } from "./ModelAdapter.js";

function configureRuntime() {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.numThreads = 1;
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
    env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/onnx/");
  }
}

function toBox(box) {
  if (!box) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  var xmin = box.xmin != null ? box.xmin : box.x;
  var ymin = box.ymin != null ? box.ymin : box.y;
  var xmax = box.xmax != null ? box.xmax : xmin + (box.width || 0);
  var ymax = box.ymax != null ? box.ymax : ymin + (box.height || 0);
  return {
    x: Math.round(xmin),
    y: Math.round(ymin),
    width: Math.round(Math.max(0, xmax - xmin)),
    height: Math.round(Math.max(0, ymax - ymin))
  };
}

export class YolosTinyAdapter extends ModelAdapter {
  constructor() {
    super();
    this.id = "yolos-tiny";
    this.displayName = "YOLOS-Tiny (baseline)";
    this.modelId = "Xenova/yolos-tiny";
    this.detector = null;
  }

  async load(preferredDevice) {
    configureRuntime();
    var start = performance.now();
    var attempts =
      preferredDevice === "wasm"
        ? [{ device: "wasm", dtype: "q8" }]
        : [
            { device: "webgpu", dtype: "fp32" },
            { device: "wasm", dtype: "q8" }
          ];

    var lastError = null;
    for (var i = 0; i < attempts.length; i++) {
      var opts = attempts[i];
      try {
        this.detector = await pipeline("object-detection", this.modelId, {
          device: opts.device,
          dtype: opts.dtype
        });
        this.backend = opts.device;
        this.loadTimeMs = Math.round(performance.now() - start);
        return {
          backend: this.backend,
          loadTimeMs: this.loadTimeMs,
          model: this.displayName,
          modelId: this.modelId
        };
      } catch (error) {
        lastError = error;
        this.detector = null;
      }
    }

    throw lastError || new Error("Failed to load YOLOS-Tiny.");
  }

  async analyze(image) {
    if (!this.detector) {
      throw new Error("YOLOS-Tiny is not loaded yet.");
    }
    var start = performance.now();
    var raw = await this.detector(image, { threshold: 0.72 });
    var inferenceTimeMs = Math.round(performance.now() - start);
    var list = Array.isArray(raw) ? raw : [];
    var detections = list.map(function (item) {
      return {
        label: item.label || "object",
        confidence: typeof item.score === "number" ? item.score : 0,
        boundingBox: toBox(item.box),
        redactPixels: false
      };
    });
    return {
      detections: detections,
      inferenceTimeMs: inferenceTimeMs,
      model: this.displayName,
      modelId: this.modelId,
      backend: this.backend,
      adapterId: this.id
    };
  }
}
