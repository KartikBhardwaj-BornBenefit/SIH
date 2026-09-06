/**
 * Deterministic screenshot sanitizer.
 *
 * Input pixels never leave this function. It creates a second canvas, applies
 * irreversible masks, and returns only a branded sanitized image object plus
 * value-free detection metadata.
 */

var HIGH_RISK = {
  password: true,
  otp: true,
  cvv: true,
  payment_card: true,
  aadhaar: true,
  pan: true,
  gstin: true,
  bank_account: true,
  authentication_secret: true,
  session_secret: true
};

function imageFromDataUrl(dataUrl) {
  return new Promise(function (resolve, reject) {
    var image = new Image();
    image.onload = function () {
      resolve(image);
    };
    image.onerror = function () {
      reject(new Error("Could not decode the local screenshot for sanitization."));
    };
    image.src = dataUrl;
  });
}

function cssBoxToImage(box, image, viewport) {
  if (!box || !image || !viewport) {
    return null;
  }
  var cssWidth = viewport.visualWidth || viewport.width || 0;
  var cssHeight = viewport.visualHeight || viewport.height || 0;
  if (!cssWidth || !cssHeight) {
    return null;
  }
  var offsetLeft = viewport.offsetLeft || 0;
  var offsetTop = viewport.offsetTop || 0;
  return {
    x: (box.x - offsetLeft) * (image.width / cssWidth),
    y: (box.y - offsetTop) * (image.height / cssHeight),
    width: box.width * (image.width / cssWidth),
    height: box.height * (image.height / cssHeight)
  };
}

function elementImageBox(element, image, viewport) {
  if (!element) {
    return null;
  }
  var box = element.viewportBox;
  if (!box && element.boundingBox) {
    box = {
      x: element.boundingBox.x - (viewport.scrollX || 0),
      y: element.boundingBox.y - (viewport.scrollY || 0),
      width: element.boundingBox.width,
      height: element.boundingBox.height
    };
  }
  return cssBoxToImage(box, image, viewport);
}

function safeCategory(categories, fallback) {
  var list = Array.isArray(categories) ? categories : [];
  for (var i = 0; i < list.length; i++) {
    if (HIGH_RISK[list[i]]) {
      return list[i];
    }
  }
  return list[0] || fallback;
}

function clampBox(box, image) {
  if (!box || !image) {
    return null;
  }
  var left = Math.max(0, Math.floor(box.x || 0));
  var top = Math.max(0, Math.floor(box.y || 0));
  var right = Math.min(image.width, Math.ceil((box.x || 0) + (box.width || 0)));
  var bottom = Math.min(image.height, Math.ceil((box.y || 0) + (box.height || 0)));
  if (right <= left || bottom <= top) {
    return null;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function isPixelSurfaceElement(element) {
  if (!element) {
    return false;
  }
  var tag = String(element.tag || "").toLowerCase();
  var kind = String(element.kind || "").toLowerCase();
  return (
    tag === "img" ||
    tag === "canvas" ||
    tag === "video" ||
    kind === "image" ||
    kind === "canvas" ||
    kind === "video"
  );
}

function boxCoversTooMuch(box, image) {
  if (!box || !image) {
    return false;
  }
  var imageArea = image.width * image.height;
  if (!imageArea) {
    return false;
  }
  return (box.width * box.height) / imageArea > 0.4;
}

function padBox(box, image, category) {
  var ratio = HIGH_RISK[category] ? 0.12 : 0.07;
  var minimum = HIGH_RISK[category] ? 8 : 5;
  var padX = Math.max(minimum, Math.round(box.width * ratio));
  var padY = Math.max(minimum, Math.round(box.height * ratio));
  return clampBox(
    {
      x: box.x - padX,
      y: box.y - padY,
      width: box.width + padX * 2,
      height: box.height + padY * 2
    },
    image
  );
}

function normalizedDetection(category, source, confidence, box, policy, elementId, reason) {
  return {
    category: category,
    source: source,
    confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
    boundingRect: {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height)
    },
    coordinateSystem: "screenshot_px",
    redactionPolicy: policy,
    elementId: elementId || null,
    reason: reason
  };
}

export function normalizeDetections(snapshot, redaction, vision, ocr) {
  var image = vision && vision.image;
  if (!image || !image.width || !image.height) {
    return [];
  }
  var detections = [];

  ((vision && vision.detections) || []).forEach(function (item) {
    if (!item || item.sensitivity === "unknown") {
      return;
    }
    var box = clampBox(item.boundingBox, image);
    if (!box || boxCoversTooMuch(box, image)) {
      return;
    }
    detections.push(
      normalizedDetection(
        safeCategory(item.sensitivityCategories, "faces_people"),
        "vision",
        item.confidence,
        box,
        "pixelate",
        null,
        "Local YuNet face detection"
      )
    );
  });

  ((ocr && ocr.items) || []).forEach(function (item) {
    if (!item || item.sensitivity === "unknown") {
      return;
    }
    var box = clampBox(item.boundingBox, image);
    if (!box) {
      return;
    }
    var category = safeCategory(item.sensitivityCategories, "image_embedded_text");
    detections.push(
      normalizedDetection(
        category,
        "ocr",
        item.confidence,
        box,
        "black",
        null,
        HIGH_RISK[category] ? "Local OCR plus identifier validation" : "Sensitive image text"
      )
    );
  });

  var elementsById = {};
  ((snapshot && snapshot.elements) || []).forEach(function (element) {
    if (element && element.id) {
      elementsById[element.id] = element;
    }
  });
  var seenDom = {};
  ((redaction && redaction.records) || []).forEach(function (record) {
    var recordKey = record && record.elementId + "\u0000" + record.category;
    if (!record || !record.elementId || seenDom[recordKey]) {
      return;
    }
    var element = elementsById[record.elementId];
    if (isPixelSurfaceElement(element)) {
      return;
    }
    var box = elementImageBox(element, image, snapshot && snapshot.viewport);
    box = clampBox(box, image);
    if (!box || boxCoversTooMuch(box, image)) {
      return;
    }
    seenDom[recordKey] = true;
    var source =
      record.confidence === "model"
        ? "ner"
        : record.confidence === "keyword"
          ? "dom"
          : "validator";
    detections.push(
      normalizedDetection(
        record.category || "sensitive_dom",
        source,
        record.score == null ? 1 : record.score,
        box,
        "black",
        record.elementId,
        record.oneWay ? "One-way credential redaction" : "Local structured-context redaction"
      )
    );
  });

  return detections;
}

function boxesOverlap(a, b) {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

function mergeBoxes(boxes, image) {
  var pending = boxes.map(function (box) {
    return clampBox(box, image);
  }).filter(Boolean);
  var merged = [];
  while (pending.length) {
    var current = pending.shift();
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = pending.length - 1; i >= 0; i--) {
        if (!boxesOverlap(current, pending[i])) {
          continue;
        }
        var other = pending.splice(i, 1)[0];
        var left = Math.min(current.x, other.x);
        var top = Math.min(current.y, other.y);
        var right = Math.max(current.x + current.width, other.x + other.width);
        var bottom = Math.max(current.y + current.height, other.y + other.height);
        current = { x: left, y: top, width: right - left, height: bottom - top };
        changed = true;
      }
    }
    merged.push(clampBox(current, image));
  }
  return merged.filter(Boolean);
}

function mergeBlackBoxes(padded, image) {
  var groups = {};
  padded.forEach(function (entry) {
    if (!entry || entry.item.redactionPolicy !== "black") {
      return;
    }
    var key = entry.item.category || "unknown";
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(entry.box);
  });
  var merged = [];
  Object.keys(groups).forEach(function (key) {
    merged.push.apply(merged, mergeBoxes(groups[key], image));
  });
  return merged;
}

function pixelate(context, sourceCanvas, box) {
  var block = Math.max(8, Math.min(24, Math.round(Math.min(box.width, box.height) / 7)));
  var smallWidth = Math.max(1, Math.ceil(box.width / block));
  var smallHeight = Math.max(1, Math.ceil(box.height / block));
  var scratch = document.createElement("canvas");
  scratch.width = smallWidth;
  scratch.height = smallHeight;
  var scratchContext = scratch.getContext("2d");
  scratchContext.drawImage(
    sourceCanvas,
    box.x,
    box.y,
    box.width,
    box.height,
    0,
    0,
    smallWidth,
    smallHeight
  );
  context.save();
  context.imageSmoothingEnabled = false;
  context.drawImage(scratch, 0, 0, smallWidth, smallHeight, box.x, box.y, box.width, box.height);
  context.restore();
  scratch.width = 1;
  scratch.height = 1;
}

function countBy(items, field) {
  var counts = {};
  items.forEach(function (item) {
    var key = item[field] || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

function dataUrlBytes(dataUrl) {
  var comma = String(dataUrl || "").indexOf(",");
  var encoded = comma >= 0 ? dataUrl.slice(comma + 1) : "";
  return Math.floor(encoded.length * 0.75);
}

export async function sanitizeScreenshot(originalDataUrl, normalized, options) {
  var started = performance.now();
  var imageElement = await imageFromDataUrl(originalDataUrl);
  var image = { width: imageElement.naturalWidth, height: imageElement.naturalHeight };
  var canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  var context = canvas.getContext("2d");
  context.drawImage(imageElement, 0, 0);

  var faceMode = options && options.faceMode === "black" ? "black" : "pixelate";
  var padded = (normalized || []).map(function (item) {
    var policy =
      item.category === "faces_people" && item.redactionPolicy === "pixelate"
        ? faceMode
        : item.redactionPolicy;
    return {
      item: Object.assign({}, item, { redactionPolicy: policy }),
      box: padBox(item.boundingRect, image, item.category)
    };
  }).filter(function (entry) {
    return entry.box;
  });

  padded.filter(function (entry) {
    return entry.item.redactionPolicy === "pixelate";
  }).forEach(function (entry) {
    pixelate(context, canvas, entry.box);
  });

  var blackBoxes = mergeBlackBoxes(padded, image);
  context.fillStyle = "#000";
  blackBoxes.forEach(function (box) {
    context.fillRect(box.x, box.y, box.width, box.height);
  });

  var quality = options && options.quality != null ? options.quality : 0.82;
  var dataUrl = canvas.toDataURL("image/jpeg", quality);
  var result = {
    sanitized: true,
    kind: "sanitized-screenshot-v1",
    dataUrl: dataUrl,
    mimeType: "image/jpeg",
    width: image.width,
    height: image.height,
    byteLength: dataUrlBytes(dataUrl),
    redaction: {
      faceMode: faceMode,
      padded: true,
      blackRegions: blackBoxes.length,
      detections: normalized.length
    }
  };
  var manifest = {
    sanitized: true,
    version: 1,
    categories: countBy(normalized, "category"),
    sources: countBy(normalized, "source"),
    policies: countBy(padded.map(function (entry) {
      return entry.item;
    }), "redactionPolicy"),
    detectionCount: normalized.length,
    blackRegionCount: blackBoxes.length,
    imageWidth: image.width,
    imageHeight: image.height
  };

  canvas.width = 1;
  canvas.height = 1;
  return {
    image: result,
    privacyManifest: manifest,
    detections: normalized,
    processingTimeMs: Math.round(performance.now() - started)
  };
}
