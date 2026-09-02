/**
 * Popup UI. Talks only to the extension service worker.
 * It never contacts an external API.
 */

var analyzeButton = document.getElementById("analyze-button");
var analyzeLabel = document.getElementById("analyze-label");
var statusEl = document.getElementById("status");
var emptyEl = document.getElementById("empty");
var resultsEl = document.getElementById("results");
var readableEl = document.getElementById("readable");
var jsonEl = document.getElementById("json");
var pageTitleEl = document.getElementById("page-title");
var pageUrlEl = document.getElementById("page-url");
var pageFlagsEl = document.getElementById("page-flags");
var viewReadable = document.getElementById("view-readable");
var viewJson = document.getElementById("view-json");
var copyJson = document.getElementById("copy-json");
var copyLabel = document.getElementById("copy-label");
var contextModeEl = document.getElementById("context-mode");

var latestSnapshot = null;

function setStatus(message, isError) {
  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = "";
    statusEl.classList.remove("is-error");
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.classList.toggle("is-error", Boolean(isError));
}

function setLoading(isLoading) {
  analyzeButton.disabled = isLoading;
  analyzeButton.classList.toggle("is-loading", isLoading);
  analyzeLabel.textContent = isLoading ? "Scanning page…" : "Analyze current page";
}

function node(tag, className, text) {
  var el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (text != null && text !== "") {
    el.textContent = text;
  }
  return el;
}

function flagLabel(value) {
  if (value === "sensitive") {
    return "Sensitive";
  }
  if (value === "potentially_sensitive") {
    return "PII";
  }
  return "";
}

function elementMeta(element) {
  var bits = [element.id];
  if (element.inputType) {
    bits.push(element.inputType);
  }
  if (element.disabled) {
    bits.push("disabled");
  }
  if (element.visible === false) {
    bits.push("not CSS-visible");
  }
  if (element.href) {
    bits.push(element.href);
  }
  if (element.sensitivityCategories && element.sensitivityCategories.length) {
    bits.push(element.sensitivityCategories.join(", "));
  }
  return bits.join(" · ");
}

function elementTitle(element) {
  return (
    element.text ||
    element.placeholder ||
    element.ariaLabel ||
    element.name ||
    element.htmlId ||
    element.inputType ||
    element.kind
  );
}

function elementBadge(element) {
  if (element.kind === "input" && element.inputType) {
    return element.inputType;
  }
  return element.kind;
}

function renderReadable(snapshot) {
  readableEl.replaceChildren();

  if (snapshot.limits.iframeCount > 0) {
    readableEl.appendChild(
      node(
        "p",
        "note-row",
        "This page has " +
          snapshot.limits.iframeCount +
          " iframe(s). Cross-origin iframe DOM is not readable."
      )
    );
  }

  if (!snapshot.elements.length) {
    readableEl.appendChild(node("p", "empty-list", "No matching elements were found."));
    return;
  }

  snapshot.elements.forEach(function (element) {
    var row = node("article", "element-row");
    var kind = node("span", "kind kind-" + element.kind, elementBadge(element));
    var main = node("div", "element-main");
    main.appendChild(node("div", "element-text", elementTitle(element)));
    main.appendChild(node("div", "element-meta", elementMeta(element)));
    row.appendChild(kind);
    row.appendChild(main);

    var flagText = flagLabel(element.sensitivity);
    if (flagText) {
      var flagClass = element.sensitivity === "sensitive" ? "flag flag-sensitive" : "flag flag-pii";
      row.appendChild(node("span", flagClass, flagText));
    }

    readableEl.appendChild(row);
  });
}

function showReadable() {
  readableEl.hidden = false;
  jsonEl.hidden = true;
  viewReadable.classList.add("is-active");
  viewJson.classList.remove("is-active");
  viewReadable.setAttribute("aria-selected", "true");
  viewJson.setAttribute("aria-selected", "false");
}

function showJson() {
  readableEl.hidden = true;
  jsonEl.hidden = false;
  viewReadable.classList.remove("is-active");
  viewJson.classList.add("is-active");
  viewReadable.setAttribute("aria-selected", "false");
  viewJson.setAttribute("aria-selected", "true");
}

function renderSnapshot(snapshot) {
  latestSnapshot = snapshot;
  document.getElementById("count-elements").textContent = String(snapshot.counts.elements);
  document.getElementById("count-interactive").textContent = String(snapshot.counts.interactive);
  document.getElementById("count-sensitive").textContent = String(
    snapshot.counts.sensitive + snapshot.counts.potentiallySensitive
  );
  document.getElementById("stat-found").textContent = String(snapshot.counts.found || 0);
  document.getElementById("stat-visible").textContent = String(snapshot.counts.visible || 0);
  document.getElementById("stat-viewport").textContent = String(snapshot.counts.inViewport || 0);
  document.getElementById("stat-interactive-visible").textContent = String(
    snapshot.counts.interactiveVisible || 0
  );
  pageTitleEl.textContent = snapshot.page.title || "(untitled)";
  pageUrlEl.textContent = snapshot.page.url || "";
  pageFlagsEl.textContent =
    (snapshot.mode === "viewport" ? "Current Viewport" : "Visible DOM") +
    " · " +
    snapshot.counts.sensitive +
    " sensitive · " +
    snapshot.counts.potentiallySensitive +
    " potentially sensitive";
  renderReadable(snapshot);
  jsonEl.textContent = JSON.stringify(snapshot, null, 2);
  emptyEl.hidden = true;
  resultsEl.hidden = false;
}

function analyzeCurrentPage() {
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
    setStatus("Open this popup from the extension icon to analyze a live tab.", true);
    return;
  }

  setLoading(true);
  setStatus("Reading the current tab…");
  resultsEl.hidden = true;
  emptyEl.hidden = true;

  chrome.runtime.sendMessage(
    {
      type: "ANALYZE_PAGE",
      mode: contextModeEl.value,
      sensitivityPolicy: SensitivityForm && SensitivityForm.getPolicy ? SensitivityForm.getPolicy() : null
    },
    function (response) {
      setLoading(false);

      if (chrome.runtime.lastError) {
        emptyEl.hidden = false;
        setStatus(chrome.runtime.lastError.message, true);
        return;
      }
      if (!response || !response.ok) {
        emptyEl.hidden = false;
        setStatus((response && response.error) || "Analysis failed.", true);
        return;
      }

      setStatus("Snapshot created locally. Nothing was uploaded.");
      renderSnapshot(response.snapshot);
      showReadable();
    }
  );
}

analyzeButton.addEventListener("click", analyzeCurrentPage);
viewReadable.addEventListener("click", showReadable);
viewJson.addEventListener("click", showJson);

copyJson.addEventListener("click", function () {
  if (!latestSnapshot) {
    return;
  }
  var payload = JSON.stringify(latestSnapshot, null, 2);
  navigator.clipboard.writeText(payload).then(function () {
    copyLabel.textContent = "Copied";
    setTimeout(function () {
      copyLabel.textContent = "Copy JSON";
    }, 1200);
  }).catch(function () {
    setStatus("Could not copy to the clipboard.", true);
  });
});

var visionButton = document.getElementById("vision-button");
var visionLabel = document.getElementById("vision-label");
var visionStateEl = document.getElementById("vision-state");
var visionBackendEl = document.getElementById("vision-backend");
var visionResultsEl = document.getElementById("vision-results");
var visionMetricsEl = document.getElementById("vision-metrics");
var visionHybridEl = document.getElementById("vision-hybrid");
var visionCanvas = document.getElementById("vision-canvas");
var detectionListEl = document.getElementById("detection-list");
var hybridTableEl = document.getElementById("hybrid-table");
var visionJsonEl = document.getElementById("vision-json");
var runOcrEl = document.getElementById("run-ocr");

function updateVisionStatus(status) {
  if (!status) {
    return;
  }
  var label = "Loading…";
  if (status.status === "ready") {
    label = "Ready";
  } else if (status.status === "error") {
    label = "Error";
  } else if (status.status === "idle") {
    label = "Idle";
  }
  visionStateEl.textContent = label;
  visionBackendEl.textContent = status.backend || "—";
  if (status.error) {
    setStatus(status.error, true);
  }
}

function cssBoxToImage(box, imgWidth, imgHeight, viewport) {
  if (!box) {
    return null;
  }
  var dpr = (viewport && viewport.devicePixelRatio) || 1;
  var cssW = (viewport && (viewport.visualWidth || viewport.width)) || 0;
  var cssH = (viewport && (viewport.visualHeight || viewport.height)) || 0;
  var ox = (viewport && viewport.offsetLeft) || 0;
  var oy = (viewport && viewport.offsetTop) || 0;

  var sx;
  var sy;
  var widthRatio = cssW ? imgWidth / cssW : dpr;
  var heightRatio = cssH ? imgHeight / cssH : dpr;
  var dprWidthMatch = cssW && Math.abs(imgWidth - cssW * dpr) <= Math.max(3, dpr * 2);
  var dprHeightMatch = cssH && Math.abs(imgHeight - cssH * dpr) <= Math.max(3, dpr * 2);
  var cssPixelCapture = cssW && Math.abs(imgWidth - cssW) <= 3;

  if (cssPixelCapture) {
    sx = 1;
    sy = cssH && Math.abs(imgHeight - cssH) <= 3 ? 1 : heightRatio;
  } else if (dprWidthMatch || dprHeightMatch) {
    sx = dpr;
    sy = dpr;
  } else {
    sx = widthRatio || dpr;
    sy = heightRatio || sx;
    if (sx && sy && Math.abs(sx - sy) / sx < 0.03) {
      sx = sy = (sx + sy) / 2;
    }
  }

  return {
    x: (box.x - ox) * sx,
    y: (box.y - oy) * sy,
    width: box.width * sx,
    height: box.height * sy
  };
}

function isFormControl(element) {
  var tag = element.tag || "";
  var kind = element.kind || "";
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    kind === "input" ||
    kind === "textarea" ||
    kind === "select"
  );
}

function shouldRedactElement(element) {
  if (!element || !isFormControl(element)) {
    return false;
  }
  var type = element.inputType || "";
  if (
    type === "hidden" ||
    type === "submit" ||
    type === "button" ||
    type === "reset" ||
    type === "image" ||
    type === "file" ||
    type === "checkbox" ||
    type === "radio"
  ) {
    return false;
  }
  if (element.hasUserValue !== true) {
    return false;
  }
  if (type === "password") {
    return true;
  }
  return element.sensitivity === "sensitive" || element.sensitivity === "potentially_sensitive";
}

function elementCssBox(element, viewport) {
  if (element.viewportBox) {
    return element.viewportBox;
  }
  var box = element.boundingBox;
  if (!box || !viewport) {
    return box;
  }
  return {
    x: box.x - (viewport.scrollX || 0),
    y: box.y - (viewport.scrollY || 0),
    width: box.width,
    height: box.height
  };
}

function redactionLabel(element) {
  if (element.inputType === "password") {
    return "password hidden";
  }
  if (element.sensitivityCategories && element.sensitivityCategories.length) {
    return element.sensitivityCategories[0].replace(/_/g, " ");
  }
  return "field hidden";
}

function drawDetections(dataUrl, detections, ocrItems, snapshot) {
  var img = new Image();
  img.onload = function () {
    visionCanvas.width = img.naturalWidth;
    visionCanvas.height = img.naturalHeight;
    var ctx = visionCanvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0);

    function paintStroke(box, color, title) {
      if (!box) {
        return;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, Math.round(img.naturalWidth / 400));
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      if (!title) {
        return;
      }
      var fontSize = Math.max(12, Math.round(img.naturalWidth / 90));
      ctx.font = fontSize + "px Segoe UI, sans-serif";
      var tw = ctx.measureText(title).width + 10;
      var th = fontSize + 8;
      ctx.fillStyle = color;
      ctx.fillRect(box.x, Math.max(0, box.y - th), tw, th);
      ctx.fillStyle = "#04150f";
      ctx.fillText(title, box.x + 5, Math.max(fontSize, box.y - 6));
    }

    function paintMask(box, title) {
      if (!box || box.width < 2 || box.height < 2) {
        return;
      }
      ctx.fillStyle = "rgba(6, 14, 12, 0.92)";
      ctx.fillRect(box.x, box.y, box.width, box.height);
      ctx.strokeStyle = "rgba(61, 207, 142, 0.45)";
      ctx.lineWidth = 1;
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      var fontSize = Math.max(10, Math.min(14, Math.round(box.height * 0.55)));
      if (box.height >= 12 && title) {
        ctx.font = fontSize + "px Segoe UI, sans-serif";
        ctx.fillStyle = "#9ad4bf";
        ctx.fillText(title, box.x + 4, box.y + Math.min(box.height - 3, fontSize + 2));
      }
    }

    var viewport = snapshot && snapshot.viewport;
    var masked = 0;
    ((snapshot && snapshot.elements) || []).forEach(function (element) {
      if (!shouldRedactElement(element)) {
        return;
      }
      var cssBox = elementCssBox(element, viewport);
      var imageBox = cssBoxToImage(cssBox, img.naturalWidth, img.naturalHeight, viewport);
      if (!imageBox) {
        return;
      }
      var left = Math.max(0, imageBox.x);
      var top = Math.max(0, imageBox.y);
      var right = Math.min(img.naturalWidth, imageBox.x + imageBox.width);
      var bottom = Math.min(img.naturalHeight, imageBox.y + imageBox.height);
      imageBox = { x: left, y: top, width: right - left, height: bottom - top };
      paintMask(imageBox, redactionLabel(element));
      masked += 1;
    });
    visionCanvas.dataset.maskedCount = String(masked);

    (detections || []).forEach(function (det) {
      var score = Math.round((det.confidence || 0) * 100);
      paintStroke(det.boundingBox, "#3dcf8e", det.label + " " + score + "%");
    });
    (ocrItems || []).forEach(function (item) {
      if (item.sensitivity && item.sensitivity !== "unknown") {
        paintMask(item.boundingBox, "ocr hidden");
      } else {
        paintStroke(item.boundingBox, "#7ec8ff", item.text);
      }
    });
  };
  img.src = dataUrl;
}

function renderHybrid(decision) {
  hybridTableEl.replaceChildren();
  if (!decision || !decision.comparison) {
    return;
  }
  decision.comparison.forEach(function (row) {
    var el = node("div", "compare-row");
    el.appendChild(node("span", "", row.signal + " · DOM " + row.dom));
    el.appendChild(node("strong", "", "Vision " + row.vision));
    hybridTableEl.appendChild(el);
  });
}

function renderVision(payload) {
  var vision = payload.vision || {};
  var ocr = payload.ocr;
  var policy = SensitivityForm && SensitivityForm.getPolicy ? SensitivityForm.getPolicy() : null;
  var annotated =
    BrowserAgent.sensitivity && BrowserAgent.sensitivity.annotatePixelSensitivity
      ? BrowserAgent.sensitivity.annotatePixelSensitivity(vision, ocr, payload.snapshot, policy)
      : { detections: vision.detections || [], ocrItems: (ocr && ocr.items) || [] };
  vision = Object.assign({}, vision, { detections: annotated.detections });
  if (ocr) {
    ocr = Object.assign({}, ocr, { items: annotated.ocrItems });
  }
  var decision =
    BrowserAgent.hybrid && BrowserAgent.hybrid.decide
      ? BrowserAgent.hybrid.decide(payload.snapshot, vision, ocr)
      : null;
  var metrics = [
    vision.model || "YOLOS-Tiny (baseline)",
    vision.backend || "unknown backend",
    vision.image && vision.image.width
      ? vision.image.width + " × " + vision.image.height
      : "",
    "load " + (vision.modelLoadTimeMs != null ? vision.modelLoadTimeMs + " ms" : "n/a"),
    "inference " + (vision.inferenceTimeMs != null ? vision.inferenceTimeMs + " ms" : "n/a"),
    (vision.detections || []).length + " detections"
  ];
  var maskCount = ((payload.snapshot && payload.snapshot.elements) || []).filter(shouldRedactElement).length;
  if (maskCount) {
    metrics.push(maskCount + " fields masked from DOM");
  }
  if (ocr) {
    metrics.push("OCR " + ocr.inferenceTimeMs + " ms");
  }
  visionMetricsEl.textContent = metrics.filter(Boolean).join(" · ");
  visionHybridEl.textContent = decision
    ? (decision.visionRecommended
        ? "Hybrid: DOM is not enough for some pixels; vision was relevant."
        : "Hybrid: DOM already described the sensitive controls; vision ran only as a baseline.")
    : "";
  drawDetections(payload.imageDataUrl, vision.detections, ocr && ocr.items, payload.snapshot);
  detectionListEl.replaceChildren();
  (vision.detections || []).forEach(function (det) {
    var row = node("article", "element-row");
    row.appendChild(node("span", "kind kind-image", det.label));
    var main = node("div", "element-main");
    main.appendChild(
      node(
        "div",
        "element-text",
        Math.round((det.confidence || 0) * 100) + "% confidence"
      )
    );
    var box = det.boundingBox || {};
    var extra =
      det.sensitivityCategories && det.sensitivityCategories.length
        ? " · " + det.sensitivityCategories.join(", ")
        : "";
    main.appendChild(
      node(
        "div",
        "element-meta",
        "x=" + box.x + " y=" + box.y + " " + box.width + "×" + box.height + extra
      )
    );
    row.appendChild(main);
    var flagText = flagLabel(det.sensitivity);
    if (flagText) {
      var flagClass = det.sensitivity === "sensitive" ? "flag flag-sensitive" : "flag flag-pii";
      row.appendChild(node("span", flagClass, flagText));
    }
    detectionListEl.appendChild(row);
  });
  if (!(vision.detections || []).length) {
    detectionListEl.appendChild(
      node(
        "p",
        "empty-list",
        maskCount
          ? "YOLOS found no COCO objects. Only policy-flagged fields were masked from the DOM."
          : "No objects detected at threshold 0.72."
      )
    );
  }
  renderHybrid(decision);
  visionJsonEl.textContent = JSON.stringify(
    {
      vision: vision,
      ocr: ocr,
      hybrid: decision,
      screenshotLeftDevice: false
    },
    null,
    2
  );
  visionResultsEl.hidden = false;
}

function analyzeCurrentScreen() {
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
    setStatus("Open this popup from the extension icon to capture a tab.", true);
    return;
  }
  visionButton.disabled = true;
  visionLabel.textContent = "Running local vision…";
  setStatus("Capturing the visible tab and running on-device inference. The screenshot is not uploaded.");
  chrome.runtime.sendMessage(
    { type: "ANALYZE_SCREEN", runOcr: runOcrEl.checked, sensitivityPolicy: SensitivityForm && SensitivityForm.getPolicy ? SensitivityForm.getPolicy() : null },
    function (response) {
      visionButton.disabled = false;
      visionLabel.textContent = "Analyze current screen";
      if (chrome.runtime.lastError) {
        setStatus(chrome.runtime.lastError.message, true);
        return;
      }
      if (!response || !response.ok) {
        setStatus((response && response.error) || "Local vision failed.", true);
        return;
      }
      setStatus("Local vision finished. Screenshot stayed on this device.");
      if (response.snapshot) {
        renderSnapshot(response.snapshot);
        showReadable();
      }
      renderVision(response);
    }
  );
}

visionButton.addEventListener("click", analyzeCurrentScreen);

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
  chrome.runtime.sendMessage({ type: "VISION_INIT" }, function (response) {
    if (chrome.runtime.lastError) {
      visionStateEl.textContent = "Error";
      return;
    }
    if (response && response.status) {
      updateVisionStatus(response.status);
    }
  });
  chrome.runtime.onMessage.addListener(function (message) {
    if (message && message.type === "OFFSCREEN_STATUS") {
      updateVisionStatus(message);
    }
  });
}
