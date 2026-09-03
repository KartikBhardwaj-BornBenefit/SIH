/**
 * OpenCV YuNet face detection through ONNX Runtime Web.
 *
 * YuNet is a 232 KB model trained for faces down to roughly 10×10 pixels. It
 * is a better fit than selfie-oriented BlazeFace for browser screenshots and
 * printed document portraits. All inference remains in the offscreen page.
 */
import * as ort from "onnxruntime-web";
import { ModelAdapter } from "./ModelAdapter.js";

var INPUT_SIZE = 640;
var SCORE_THRESHOLD = 0.45;
var NMS_THRESHOLD = 0.3;
var STRIDES = [8, 16, 32];

function extensionUrl(path) {
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(path);
  }
  return path;
}

function loadImage(source) {
  return new Promise(function (resolve, reject) {
    var image = new Image();
    image.onload = function () {
      resolve(image);
    };
    image.onerror = function () {
      reject(new Error("Could not decode the screenshot for face detection."));
    };
    image.src = source;
  });
}

function configureRuntime() {
  ort.env.wasm.proxy = false;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = extensionUrl("vendor/onnx/");
}

function intersectionOverUnion(a, b) {
  var left = Math.max(a.x, b.x);
  var top = Math.max(a.y, b.y);
  var right = Math.min(a.x + a.width, b.x + b.width);
  var bottom = Math.min(a.y + a.height, b.y + b.height);
  var intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  var union = a.width * a.height + b.width * b.height - intersection;
  return union ? intersection / union : 0;
}

function nonMaximumSuppression(detections) {
  var sorted = detections.slice().sort(function (a, b) {
    return b.confidence - a.confidence;
  });
  var kept = [];
  sorted.forEach(function (candidate) {
    var overlaps = kept.some(function (existing) {
      return intersectionOverUnion(candidate.boundingBox, existing.boundingBox) >= NMS_THRESHOLD;
    });
    if (!overlaps) {
      kept.push(candidate);
    }
  });
  return kept;
}

function decodeOutputs(outputs) {
  var detections = [];
  STRIDES.forEach(function (stride) {
    var cls = outputs["cls_" + stride] && outputs["cls_" + stride].data;
    var obj = outputs["obj_" + stride] && outputs["obj_" + stride].data;
    var bbox = outputs["bbox_" + stride] && outputs["bbox_" + stride].data;
    if (!cls || !obj || !bbox) {
      return;
    }

    var featureWidth = INPUT_SIZE / stride;
    for (var i = 0; i < cls.length; i++) {
      var classScore = Math.min(1, Math.max(0, cls[i]));
      var objectScore = Math.min(1, Math.max(0, obj[i]));
      var score = Math.sqrt(classScore * objectScore);
      if (score < SCORE_THRESHOLD) {
        continue;
      }
      var row = Math.floor(i / featureWidth);
      var column = i % featureWidth;
      var centerX = (column + bbox[i * 4]) * stride;
      var centerY = (row + bbox[i * 4 + 1]) * stride;
      var width = Math.exp(bbox[i * 4 + 2]) * stride;
      var height = Math.exp(bbox[i * 4 + 3]) * stride;
      detections.push({
        confidence: score,
        box: {
          x: centerX - width / 2,
          y: centerY - height / 2,
          width: width,
          height: height
        }
      });
    }
  });
  return detections;
}

function tileStarts(total, tileSize) {
  if (total <= tileSize) {
    return [0];
  }
  var last = total - tileSize;
  var stride = Math.round(tileSize * 0.75);
  var starts = [];
  for (var value = 0; value < last; value += stride) {
    starts.push(value);
  }
  starts.push(last);
  return starts;
}

export class YuNetFaceAdapter extends ModelAdapter {
  constructor() {
    super();
    this.id = "opencv-yunet";
    this.displayName = "OpenCV YuNet Face Detector";
    this.modelId = "face_detection_yunet_2023mar";
    this.session = null;
  }

  async load(_preferredDevice) {
    configureRuntime();
    var start = performance.now();
    var modelUrl = extensionUrl("vendor/vision/face_detection_yunet_2023mar.onnx");
    var response = await fetch(modelUrl);
    if (!response.ok) {
      throw new Error("Could not load the packaged YuNet model: HTTP " + response.status);
    }
    this.session = await ort.InferenceSession.create(await response.arrayBuffer(), {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    });
    this.backend = "wasm";
    this.loadTimeMs = Math.round(performance.now() - start);
    return {
      backend: this.backend,
      loadTimeMs: this.loadTimeMs,
      model: this.displayName,
      modelId: this.modelId
    };
  }

  async detectRegion(image, region) {
    var canvas = document.createElement("canvas");
    canvas.width = INPUT_SIZE;
    canvas.height = INPUT_SIZE;
    var context = canvas.getContext("2d", { willReadFrequently: true });
    context.fillStyle = "black";
    context.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);

    var scale = Math.min(INPUT_SIZE / region.width, INPUT_SIZE / region.height);
    var drawWidth = Math.round(region.width * scale);
    var drawHeight = Math.round(region.height * scale);
    var padX = Math.floor((INPUT_SIZE - drawWidth) / 2);
    var padY = Math.floor((INPUT_SIZE - drawHeight) / 2);
    context.drawImage(
      image,
      region.x,
      region.y,
      region.width,
      region.height,
      padX,
      padY,
      drawWidth,
      drawHeight
    );

    var pixels = context.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
    var planeSize = INPUT_SIZE * INPUT_SIZE;
    var data = new Float32Array(planeSize * 3);
    for (var i = 0; i < planeSize; i++) {
      var pixel = i * 4;
      data[i] = pixels[pixel + 2];
      data[planeSize + i] = pixels[pixel + 1];
      data[planeSize * 2 + i] = pixels[pixel];
    }

    var outputs = await this.session.run({
      input: new ort.Tensor("float32", data, [1, 3, INPUT_SIZE, INPUT_SIZE])
    });
    return decodeOutputs(outputs)
      .map(function (item) {
        var box = item.box;
        var left = Math.max(region.x, (box.x - padX) / scale + region.x);
        var top = Math.max(region.y, (box.y - padY) / scale + region.y);
        var right = Math.min(
          region.x + region.width,
          (box.x + box.width - padX) / scale + region.x
        );
        var bottom = Math.min(
          region.y + region.height,
          (box.y + box.height - padY) / scale + region.y
        );
        return {
          label: "face",
          confidence: item.confidence,
          boundingBox: {
            x: Math.round(left),
            y: Math.round(top),
            width: Math.round(Math.max(0, right - left)),
            height: Math.round(Math.max(0, bottom - top))
          },
          redactPixels: true
        };
      })
      .filter(function (item) {
        return item.boundingBox.width >= 4 && item.boundingBox.height >= 4;
      });
  }

  async analyze(source) {
    if (!this.session) {
      throw new Error("YuNet face detector is not loaded yet.");
    }
    var image = await loadImage(source);
    var start = performance.now();
    var fullRegion = {
      x: 0,
      y: 0,
      width: image.naturalWidth,
      height: image.naturalHeight
    };
    var detections = await this.detectRegion(image, fullRegion);

    // Only pay the extra inference cost when the full frame misses. Overlapping
    // 1280px crops enlarge tiny browser-content faces while keeping the common
    // path to one YuNet pass.
    if (!detections.length && (image.naturalWidth > 1280 || image.naturalHeight > 1280)) {
      var tileWidth = Math.min(1280, image.naturalWidth);
      var tileHeight = Math.min(1280, image.naturalHeight);
      var xs = tileStarts(image.naturalWidth, tileWidth);
      var ys = tileStarts(image.naturalHeight, tileHeight);
      for (var yi = 0; yi < ys.length; yi++) {
        for (var xi = 0; xi < xs.length; xi++) {
          var tileDetections = await this.detectRegion(image, {
            x: xs[xi],
            y: ys[yi],
            width: tileWidth,
            height: tileHeight
          });
          detections.push.apply(detections, tileDetections);
        }
      }
    }

    return {
      detections: nonMaximumSuppression(detections),
      inferenceTimeMs: Math.round(performance.now() - start),
      model: this.displayName,
      modelId: this.modelId,
      backend: this.backend,
      adapterId: this.id
    };
  }
}
