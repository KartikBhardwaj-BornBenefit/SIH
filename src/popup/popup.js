/**
 * Popup UI. Talks only to the extension service worker.
 * It never contacts an external API.
 */

var analyzeButton = document.getElementById("analyze-button");
var analyzeLabel = document.getElementById("analyze-label");
var statusBoxEl = document.getElementById("status-box");
var statusEl = document.getElementById("status");
var replacementListEl = document.getElementById("replacement-list");
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
var latestRedaction = null;
var latestNer = null;
var popupAgentTabId = null;

function agentStatusForThisTab(message) {
  if (popupAgentTabId == null) {
    return false;
  }
  if (message && message.tabId != null && Number(message.tabId) !== Number(popupAgentTabId)) {
    return false;
  }
  return true;
}

function requestAgentStatus(callback) {
  chrome.runtime.sendMessage({ type: "AGENT_STATUS", tabId: popupAgentTabId }, callback);
}

function clearVault() {
  latestRedaction = null;
  latestNer = null;
}

function uniqueReplacements(redaction) {
  var records = (redaction && redaction.records) || [];
  var seen = {};
  var out = [];
  records.forEach(function (record) {
    if (!record || !record.placeholder || seen[record.placeholder]) {
      return;
    }
    seen[record.placeholder] = true;
    out.push(record);
  });
  return out;
}

function categoryLabel(categoryId) {
  var cats = (BrowserAgent && BrowserAgent.SENSITIVITY_CATEGORIES) || [];
  for (var i = 0; i < cats.length; i++) {
    if (cats[i].id === categoryId) {
      return cats[i].label;
    }
  }
  if (categoryId === "truncated_text") {
    return "Truncated text";
  }
  return String(categoryId || "value").replace(/_/g, " ");
}

function replacementNote(record) {
  var label = categoryLabel(record.category);
  if (record.oneWay) {
    return label + " · not recoverable";
  }
  if (record.confidence === "checksum") {
    return label + " · checksum";
  }
  if (record.confidence === "model") {
    return label + " · name model";
  }
  if (record.confidence === "structure" || record.confidence === "shape") {
    return label + " · " + record.confidence;
  }
  return label;
}

function renderReplacementList(records) {
  if (!replacementListEl) {
    return;
  }
  replacementListEl.replaceChildren();
  if (!records || !records.length) {
    replacementListEl.hidden = true;
    return;
  }
  replacementListEl.hidden = false;
  records.forEach(function (record) {
    var item = node("li", "replacement-item");
    item.appendChild(node("code", "replacement-token", record.placeholder));
    item.appendChild(node("span", "replacement-kind", replacementNote(record)));
    replacementListEl.appendChild(item);
  });
}

function setStatus(message, isError, replacementRecords) {
  var box = statusBoxEl || statusEl;
  if (!message) {
    box.hidden = true;
    statusEl.textContent = "";
    box.classList.remove("is-error");
    renderReplacementList([]);
    return;
  }
  box.hidden = false;
  statusEl.textContent = message;
  box.classList.toggle("is-error", Boolean(isError));
  renderReplacementList(!isError && replacementRecords ? replacementRecords : []);
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

/**
 * "asks" means the control requests this data. "found" means we matched an
 * actual identifier, and a tick means an arithmetic check digit passed.
 */
function signalLabel(signal) {
  if (signal.via === "field-purpose") {
    return signal.category + " asks";
  }
  var where = signal.via === "control-value" ? " in value" : " found";
  var extra = "";
  if (signal.confidence === "checksum") {
    extra = " ✓";
  } else if (signal.confidence === "model") {
    extra = " (model)";
  }
  return signal.category + where + extra;
}

function signalSummary(element) {
  var signals = element.sensitivitySignals || [];
  if (signals.length) {
    return signals.map(signalLabel).join(", ");
  }
  if (element.sensitivityCategories && element.sensitivityCategories.length) {
    return element.sensitivityCategories.join(", ");
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
  var summary = signalSummary(element);
  if (summary) {
    bits.push(summary);
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

  if (snapshot.limits && snapshot.limits.iframeCount > 0) {
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

  if (!(snapshot.elements && snapshot.elements.length)) {
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

function renderRedactionStats(snapshot, ner) {
  var counts = (snapshot && snapshot.redactionCounts) || {};
  var replacedEl = document.getElementById("stat-redacted");
  if (replacedEl) {
    replacedEl.textContent = String(counts.replacements || 0);
  }
  var nerEl = document.getElementById("stat-ner");
  if (nerEl) {
    var modelHits = (counts.byConfidence && counts.byConfidence.model) || 0;
    if (!modelHits && ner && ner.ok) {
      modelHits = ner.entities || 0;
    }
    nerEl.textContent = String(modelHits);
  }
}

function renderSnapshot(snapshot, ner) {
  if (!snapshot) {
    throw new Error("The tab returned no snapshot.");
  }
  latestSnapshot = snapshot;
  latestNer = ner || null;
  var counts = snapshot.counts || {};
  document.getElementById("count-elements").textContent = String(counts.elements || 0);
  document.getElementById("count-interactive").textContent = String(counts.interactive || 0);
  document.getElementById("count-sensitive").textContent = String(
    (counts.sensitive || 0) + (counts.potentiallySensitive || 0)
  );
  document.getElementById("stat-found").textContent = String(counts.found || 0);
  document.getElementById("stat-visible").textContent = String(counts.visible || 0);
  document.getElementById("stat-viewport").textContent = String(counts.inViewport || 0);
  document.getElementById("stat-interactive-visible").textContent = String(
    counts.interactiveVisible || 0
  );
  document.getElementById("stat-value-matched").textContent = String(counts.valueMatched || 0);
  document.getElementById("stat-checksum").textContent = String(counts.checksumVerified || 0);
  renderRedactionStats(snapshot, ner);
  updateNerStatus(ner);
  pageTitleEl.textContent = (snapshot.page && snapshot.page.title) || "(untitled)";
  pageUrlEl.textContent = (snapshot.page && snapshot.page.url) || "";
  pageFlagsEl.textContent =
    (snapshot.mode === "viewport" ? "Current Viewport" : "Visible DOM") +
    " · " +
    (counts.sensitive || 0) +
    " sensitive · " +
    (counts.potentiallySensitive || 0) +
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
  setStatus("Reading the current tab. First time: downloading a 66 MB English name model (progress shows above).");
  resultsEl.hidden = true;
  emptyEl.hidden = true;
  clearVault();

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

      latestRedaction = response.redaction || null;

      var replacements = uniqueReplacements(latestRedaction);
      var ner = response.ner || null;
      var statusBits = [];
      if (replacements.length) {
        statusBits.push(replacements.length + " value(s) replaced with placeholders.");
      }
      if (ner && ner.ok) {
        statusBits.push(
          (ner.entities || 0) + " name span(s) from the local model" +
            (ner.inferenceTimeMs != null ? " in " + ner.inferenceTimeMs + " ms" : "") + "."
        );
      } else if (ner && ner.ok === false) {
        statusBits.push("Name model skipped: " + (ner.error || "unavailable") + ".");
      }
      setStatus(
        statusBits.length
          ? "Snapshot created locally. " + statusBits.join(" ")
          : "Snapshot created locally. Nothing was uploaded.",
        false,
        replacements
      );
      try {
        renderSnapshot(response.snapshot, ner);
        showReadable();
      } catch (error) {
        emptyEl.hidden = false;
        resultsEl.hidden = true;
        setStatus(error && error.message ? error.message : "Could not render the snapshot.", true);
      }
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

function updateNerStatus(ner) {
  var stateEl = document.getElementById("ner-state");
  var backendEl = document.getElementById("ner-backend");
  if (!stateEl) {
    return;
  }
  if (!ner) {
    stateEl.textContent = "Idle";
    if (backendEl) {
      backendEl.textContent = "—";
    }
    return;
  }
  if (ner.ok === false) {
    stateEl.textContent = "Error";
    if (backendEl) {
      backendEl.textContent = "—";
    }
    return;
  }
  if (ner.status === "loading") {
    var bits = ["Downloading"];
    if (ner.progress != null && !isNaN(ner.progress)) {
      bits.push(ner.progress + "%");
    }
    if (ner.file) {
      var shortName = String(ner.file).split("/").pop();
      if (shortName) {
        bits.push(shortName);
      }
    }
    stateEl.textContent = bits.join(" ");
    if (backendEl) {
      backendEl.textContent = "wasm";
    }
    if (ner.progress != null && !isNaN(ner.progress)) {
      setStatus("Downloading name model " + ner.progress + "%…");
    }
    return;
  }
  stateEl.textContent = ner.ok ? "Ready" : (ner.status === "ready" ? "Ready" : "Idle");
  if (backendEl) {
    backendEl.textContent = ner.backend || "—";
  }
}

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

/**
 * The mask set is the redaction set.
 *
 * Masks used to be decided by their own rules, which meant the picture and
 * the payload could disagree — the canvas could black out a field whose value
 * was still sitting in the JSON, or leave one visible that had been replaced.
 * Both now come from the records the redaction pass produced, so a masked
 * region is exactly a region where something was replaced.
 */
function redactedElementIds() {
  var ids = {};
  ((latestRedaction && latestRedaction.records) || []).forEach(function (record) {
    if (record.elementId) {
      ids[record.elementId] = true;
    }
  });
  return ids;
}

function shouldRedactElement(element, ids) {
  if (!element || !element.id) {
    return false;
  }
  if (!ids[element.id]) {
    return false;
  }
  var tag = String(element.tag || "").toLowerCase();
  var kind = String(element.kind || "").toLowerCase();
  if (
    tag === "img" ||
    tag === "canvas" ||
    tag === "video" ||
    kind === "image" ||
    kind === "canvas" ||
    kind === "video"
  ) {
    return false;
  }
  return true;
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

/**
 * Label a mask with the placeholder that replaced the value, so the picture
 * and the JSON name the same thing.
 */
function redactionLabel(element) {
  var records = (latestRedaction && latestRedaction.records) || [];
  for (var i = 0; i < records.length; i++) {
    if (records[i].elementId === element.id) {
      return records[i].placeholder;
    }
  }
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
      ctx.fillStyle = "#062016";
      ctx.fillText(title, box.x + 5, Math.max(fontSize, box.y - 6));
    }

    function paintMask(box, title) {
      if (!box || box.width < 2 || box.height < 2) {
        return;
      }
      ctx.fillStyle = "rgba(8, 12, 10, 0.92)";
      ctx.fillRect(box.x, box.y, box.width, box.height);
      ctx.strokeStyle = "rgba(52, 196, 132, 0.4)";
      ctx.lineWidth = 1;
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      var fontSize = Math.max(10, Math.min(14, Math.round(box.height * 0.55)));
      if (box.height >= 12 && title) {
        ctx.font = fontSize + "px system-ui, sans-serif";
        ctx.fillStyle = "#8fd4b8";
        ctx.fillText(title, box.x + 4, box.y + Math.min(box.height - 3, fontSize + 2));
      }
    }

    var viewport = snapshot && snapshot.viewport;
    var masked = 0;
    var redactedIds = redactedElementIds();
    ((snapshot && snapshot.elements) || []).forEach(function (element) {
      if (!shouldRedactElement(element, redactedIds)) {
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
      if (det.redactPixels && det.sensitivity && det.sensitivity !== "unknown") {
        paintMask(det.boundingBox, "face hidden");
      } else {
        paintStroke(det.boundingBox, "#34c484", det.label + " " + score + "%");
      }
    });
    (ocrItems || []).forEach(function (item) {
      if (item.sensitivity && item.sensitivity !== "unknown") {
        paintMask(item.boundingBox, "ocr hidden");
      } else {
        paintStroke(item.boundingBox, "#6eb8e8", item.text);
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
  var ocrPlan = payload.ocrPlan;
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
    vision.model || "OpenCV YuNet Face Detector",
    vision.backend || "unknown backend",
    vision.image && vision.image.width
      ? vision.image.width + " × " + vision.image.height
      : "",
    "load " + (vision.modelLoadTimeMs != null ? vision.modelLoadTimeMs + " ms" : "n/a"),
    "inference " + (vision.inferenceTimeMs != null ? vision.inferenceTimeMs + " ms" : "n/a"),
    (vision.detections || []).length + " detections"
  ];
  var maskIds = redactedElementIds();
  var maskCount = ((payload.snapshot && payload.snapshot.elements) || []).filter(function (element) {
    return shouldRedactElement(element, maskIds);
  }).length;
  if (maskCount) {
    metrics.push(maskCount + " regions masked from DOM");
  }
  if (ocr) {
    metrics.push(
      "OCR " +
      (ocrPlan && ocrPlan.mode === "automatic" ? "auto · " : "") +
      ocr.inferenceTimeMs +
      " ms"
    );
  } else if (ocrPlan && ocrPlan.mode === "skipped") {
    metrics.push("OCR skipped");
  }
  visionMetricsEl.textContent = metrics.filter(Boolean).join(" · ");
  visionHybridEl.textContent = decision
    ? (decision.visionRecommended
        ? "Hybrid: DOM is not enough for some pixels; vision was relevant."
        : "Hybrid: DOM already described the sensitive controls; vision ran only as a baseline.")
    : "";
  if (payload.sanitizedImageDataUrl) {
    drawDetections(payload.sanitizedImageDataUrl, [], [], null);
  } else {
    drawDetections(payload.imageDataUrl, vision.detections, ocr && ocr.items, payload.snapshot);
  }
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
          ? "No face was detected by the model. Printed, small, or angled portraits can be missed; policy-flagged DOM regions were still masked."
          : "No face was detected by the model. Printed, small, or angled portraits can be missed."
      )
    );
  }
  renderHybrid(decision);
  visionJsonEl.textContent = JSON.stringify(
    {
      vision: vision,
      ocr: ocr,
      ocrPlan: ocrPlan,
      hybrid: decision,
      privacyManifest: payload.privacyManifest || null,
      normalizedDetections: payload.normalizedDetections || [],
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
  setStatus(
    "Capturing the visible tab and running on-device inference. OCR will run automatically when pixel text may be present."
  );
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
      // Records arrive on this path but the vault does not, so a vision run
      // can draw masks without being able to reveal anything.
      latestRedaction = response.redaction || null;
      setStatus(
        response.ocrPlan && response.ocrPlan.run
          ? "Local vision and OCR finished. Screenshot stayed on this device."
          : "Local vision finished. OCR skipped because the viewport DOM exposed no image, canvas, or video.",
        false,
        uniqueReplacements(latestRedaction)
      );
      try {
        if (response.snapshot) {
          renderSnapshot(response.snapshot, response.ner);
          showReadable();
        }
        renderVision(response);
      } catch (error) {
        emptyEl.hidden = false;
        resultsEl.hidden = true;
        visionResultsEl.hidden = true;
        setStatus(error && error.message ? error.message : "Could not render vision results.", true);
      }
    }
  );
}

visionButton.addEventListener("click", analyzeCurrentScreen);

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
  chrome.runtime.onMessage.addListener(function (message) {
    if (message && message.type === "OFFSCREEN_STATUS") {
      updateVisionStatus(message);
    }
    if (message && message.type === "OFFSCREEN_NER_STATUS") {
      updateNerStatus(message);
    }
    if (message && message.type === "AGENT_STATUS") {
      if (!agentStatusForThisTab(message)) {
        return;
      }
      if (message.entry) {
        appendAgentLog(message.entry);
      }
      if (message.goal && agentGoalEl && !agentGoalEl.value.trim()) {
        agentGoalEl.value = message.goal;
      }
      if (message.status === "waiting_for_user") {
        setAgentChrome("waiting", message.authGate);
      } else if (message.status === "running") {
        setAgentChrome("running");
      } else if (message.status === "stopped") {
        setAgentChrome("stopped");
      } else if (message.finished || message.status === "done" || message.status === "error") {
        requestAgentStatus(function (response) {
          if (!response || chrome.runtime.lastError) {
            finishAgentState({
              ok: message.status === "done",
              error: message.status === "error" ? "Agent failed." : "",
              status: message.status
            });
            return;
          }
          renderAgentResult(response, response.analysisMode || agentModeEl.value);
          finishAgentState(response);
        });
      }
      if (message.screenshotCount) {
        requestAgentStatus(function (response) {
          if (!response || chrome.runtime.lastError) {
            return;
          }
          renderAgentResult(response, response.analysisMode || agentModeEl.value);
        });
      }
    }
  });
}

var agentGoalEl = document.getElementById("agent-goal");
var agentModeEl = document.getElementById("agent-mode");
var agentRunEl = document.getElementById("agent-run");
var agentStopEl = document.getElementById("agent-stop");
var agentPauseEl = document.getElementById("agent-pause");
var agentContinueEl = document.getElementById("agent-continue");
var agentGateEl = document.getElementById("agent-gate");
var agentGateTitleEl = document.getElementById("agent-gate-title");
var agentGateCopyEl = document.getElementById("agent-gate-copy");
var agentStateEl = document.getElementById("agent-state");
var agentErrorEl = document.getElementById("agent-error");
var agentOutputEl = document.getElementById("agent-output");
var agentLogEl = document.getElementById("agent-log");
var agentPreviewEl = document.getElementById("agent-sanitized-preview");
var agentImageNoteEl = document.getElementById("agent-image-note");
var agentScreenshotStripEl = document.getElementById("agent-screenshot-strip");
var agentOpenGalleryEl = document.getElementById("agent-open-gallery");
var agentContextEl = document.getElementById("agent-context-preview");
var agentPrivacyEl = document.getElementById("agent-privacy-summary");
var agentTimingsEl = document.getElementById("agent-timings");
var privacySubtitleEl = document.getElementById("privacy-subtitle");
var privacyPillEl = document.getElementById("privacy-pill");
var agentScreenshotFrames = [];
var selectedShotIndex = 0;

function renderAuthGate(authGate) {
  if (!agentGateEl) {
    return;
  }
  if (!authGate) {
    return;
  }
  if (agentGateTitleEl && authGate.title) {
    agentGateTitleEl.textContent = authGate.title;
  }
  if (agentGateCopyEl && authGate.detail) {
    agentGateCopyEl.textContent = authGate.detail;
  }
}

function setAgentChrome(state, authGate) {
  var running = state === "running";
  var waiting = state === "waiting" || state === "waiting_for_user";
  var busy = running || waiting;
  agentRunEl.disabled = busy;
  agentStopEl.disabled = !busy;
  if (agentContinueEl) {
    agentContinueEl.disabled = !waiting;
    if (authGate && authGate.kind === "manual") {
      agentContinueEl.textContent = "Resume agent";
    } else {
      agentContinueEl.textContent = "I've finished — continue";
    }
  }
  if (agentPauseEl) {
    agentPauseEl.disabled = !busy;
    agentPauseEl.textContent = waiting ? "Resume" : "Pause for input";
  }
  if (agentGateEl) {
    agentGateEl.hidden = !waiting;
  }
  if (waiting) {
    renderAuthGate(authGate);
  }
  agentStateEl.classList.toggle("is-running", running);
  agentStateEl.classList.toggle("is-waiting", waiting);
  agentStateEl.classList.toggle("is-error", state === "error");
  if (running) {
    agentStateEl.textContent = "Running";
    privacySubtitleEl.textContent = "Agent mode · only sanitized context is transmitted";
    privacyPillEl.lastChild.textContent = " Agent";
    return;
  }
  if (waiting) {
    agentStateEl.textContent = "Waiting";
    privacySubtitleEl.textContent =
      authGate && authGate.kind === "manual"
        ? "Paused — type in the tab, then resume"
        : "Paused for a code only you can enter";
    privacyPillEl.lastChild.textContent = " Agent";
    return;
  }
  if (state === "stopped") {
    agentStateEl.textContent = "Stopped";
    return;
  }
  if (state === "error") {
    agentStateEl.textContent = "Error";
    return;
  }
  if (state === "done" || state === "complete") {
    agentStateEl.textContent = "Complete";
    return;
  }
  agentStateEl.textContent = "Idle";
}

function setAgentRunning(running) {
  setAgentChrome(running ? "running" : "idle");
}

function appendAgentLog(entry) {
  if (!agentLogEl || !entry) {
    return;
  }
  var item = document.createElement("li");
  var title = document.createElement("strong");
  title.textContent = "Step " + (entry.step || "—") + " · " + (entry.phase || "status");
  item.appendChild(title);
  item.appendChild(document.createTextNode(" — " + (entry.detail || "")));
  agentLogEl.appendChild(item);
  agentLogEl.scrollTop = agentLogEl.scrollHeight;
}

function renderPrivacyManifest(manifest) {
  agentPrivacyEl.replaceChildren();
  var categories = (manifest && manifest.categories) || {};
  var names = Object.keys(categories);
  if (!names.length) {
    agentPrivacyEl.appendChild(node("span", "privacy-chip", "No detected categories"));
    return;
  }
  names.sort().forEach(function (category) {
    agentPrivacyEl.appendChild(
      node("span", "privacy-chip", category.replace(/_/g, " ") + " · " + categories[category])
    );
  });
}

function renderAgentTimings(timings) {
  agentTimingsEl.replaceChildren();
  var labels = {
    captureMs: "Capture",
    domMs: "DOM",
    domExtractionMs: "DOM + rule detection",
    ruleRedactionMs: "Structured redaction",
    nerMs: "NER",
    visionMs: "Face detection",
    ocrMs: "OCR",
    redactionMs: "Pixel redaction",
    serverMs: "Server",
    totalAgentMs: "Total",
    waitedForUserMs: "Waited for you",
    totalClientMs: "Client total",
    payloadBytes: "Payload",
    sanitizedImageBytes: "Sanitized image",
    heapEstimateBytes: "JS heap estimate",
    peakCanvasWidth: "Peak canvas width",
    peakCanvasHeight: "Peak canvas height"
  };
  Object.keys(labels).forEach(function (key) {
    if (!timings || timings[key] == null) {
      return;
    }
    var value =
      key === "payloadBytes" || key === "sanitizedImageBytes" || key === "heapEstimateBytes"
        ? Math.round(timings[key] / 1024) + " KB"
        : key === "peakCanvasWidth" || key === "peakCanvasHeight"
          ? timings[key] + " px"
          : timings[key] + " ms";
    var row = node("div", "compare-row");
    row.appendChild(node("span", "", labels[key]));
    row.appendChild(node("strong", "", value));
    agentTimingsEl.appendChild(row);
  });
}

function renderScreenshotGallery(analysisMode) {
  var api = BrowserAgent.screenshotFrames;
  var frames = agentScreenshotFrames;
  if (!api || !agentPreviewEl || !agentImageNoteEl) {
    return;
  }
  if (!frames.length) {
    agentPreviewEl.removeAttribute("src");
    agentPreviewEl.hidden = true;
    if (agentScreenshotStripEl) {
      agentScreenshotStripEl.replaceChildren();
      agentScreenshotStripEl.hidden = true;
    }
    if (agentOpenGalleryEl) {
      agentOpenGalleryEl.hidden = true;
    }
    agentImageNoteEl.hidden = false;
    agentImageNoteEl.textContent = api.emptyNote(analysisMode);
    return;
  }
  if (selectedShotIndex < 0 || selectedShotIndex >= frames.length) {
    selectedShotIndex = frames.length - 1;
  }
  var selected = frames[selectedShotIndex];
  agentPreviewEl.src = selected.screenshot.dataUrl;
  agentPreviewEl.hidden = false;
  agentImageNoteEl.hidden = false;
  agentImageNoteEl.textContent = api.note(selected, analysisMode, frames.length);
  if (agentOpenGalleryEl) {
    agentOpenGalleryEl.hidden = false;
  }
  if (!agentScreenshotStripEl) {
    return;
  }
  agentScreenshotStripEl.replaceChildren();
  if (frames.length < 2) {
    agentScreenshotStripEl.hidden = true;
    return;
  }
  agentScreenshotStripEl.hidden = false;
  frames.forEach(function (frame, index) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "agent-shot-thumb" + (index === selectedShotIndex ? " is-selected" : "");
    var img = document.createElement("img");
    img.src = frame.screenshot.dataUrl;
    img.alt = api.label(frame);
    var badge = document.createElement("span");
    badge.className = "agent-shot-step";
    badge.textContent = String(index + 1);
    button.appendChild(img);
    button.appendChild(badge);
    button.addEventListener("click", function () {
      selectedShotIndex = index;
      renderScreenshotGallery(analysisMode);
    });
    agentScreenshotStripEl.appendChild(button);
  });
}

function renderAgentResult(response, analysisMode) {
  agentOutputEl.hidden = false;
  if (response && response.snapshot) {
    agentContextEl.textContent = JSON.stringify(response.snapshot, null, 2);
  }
  var mode = analysisMode || (response && response.analysisMode) || agentModeEl.value;
  agentScreenshotFrames = BrowserAgent.screenshotFrames
    ? BrowserAgent.screenshotFrames.listFrom(response)
    : [];
  selectedShotIndex = Math.max(0, agentScreenshotFrames.length - 1);
  renderScreenshotGallery(mode);
  renderPrivacyManifest(response && response.privacyManifest);
  renderAgentTimings(response && response.timings);
}

function finishAgentState(response) {
  var raw = (response && response.status) || "";
  if (raw === "waiting_for_user") {
    setAgentChrome("waiting", response.authGate);
    return;
  }
  if (raw === "running") {
    setAgentChrome("running");
    return;
  }
  var status = "idle";
  if (raw === "done" || (response && response.ok && raw !== "error" && raw !== "stopped")) {
    status = "complete";
  } else if (raw === "stopped" || (response && /stopped/i.test(response.error || ""))) {
    status = "stopped";
  } else if (raw === "error" || (response && response.ok === false)) {
    status = "error";
  }
  setAgentChrome(status);
  agentErrorEl.hidden = status !== "error";
  agentErrorEl.textContent = status === "error" ? (response && response.error) || "Agent failed." : "";
}

agentRunEl.addEventListener("click", function () {
  var goal = agentGoalEl.value.trim();
  if (!goal) {
    agentErrorEl.hidden = false;
    agentErrorEl.textContent = "Enter a goal first.";
    return;
  }
  var shouldConfirm = document.getElementById("confirm-remote").checked;
  if (
    shouldConfirm &&
    !window.confirm(
      "Run agent mode? Only locally sanitized context and profile availability tokens will be sent. Real Aadhaar, email, and other profile values stay on this device."
    )
  ) {
    return;
  }
  var allowDestructive = document.getElementById("allow-destructive").checked;
  if (
    allowDestructive &&
    !window.confirm("Allow the agent to activate submit, continue, send, purchase, or delete controls?")
  ) {
    allowDestructive = false;
  }
  var allowHighRiskProfile = document.getElementById("allow-profile-high-risk").checked;
  if (
    allowHighRiskProfile &&
    !window.confirm(
      "Allow this run to type Aadhaar, PAN, passport, GSTIN, or payment profile values into matching fields on the current page?"
    )
  ) {
    allowHighRiskProfile = false;
  }

  agentErrorEl.hidden = true;
  agentLogEl.replaceChildren();
  agentScreenshotFrames = [];
  selectedShotIndex = 0;
  renderScreenshotGallery(agentModeEl.value);
  agentOutputEl.hidden = false;
  setAgentRunning(true);
  var analysisMode = agentModeEl.value;
  chrome.runtime.sendMessage(
    {
      type: "RUN_AGENT",
      goal: goal,
      analysisMode: analysisMode,
      contextMode: contextModeEl.value,
      sensitivityPolicy: SensitivityForm.getPolicy(),
      remoteConfirmed: true,
      allowDestructive: allowDestructive,
      allowHighRiskProfile: allowHighRiskProfile
    },
    function (response) {
      if (chrome.runtime.lastError) {
        var disconnected = /message port closed|receiving end does not exist/i.test(
          chrome.runtime.lastError.message || ""
        );
        if (disconnected) {
          return;
        }
        response = { ok: false, error: chrome.runtime.lastError.message };
      }
      if (response && response.accepted) {
        if (response.goal) {
          agentGoalEl.value = response.goal;
        }
        setAgentChrome(
          response.status === "waiting_for_user" ? "waiting" : "running",
          response.authGate
        );
        return;
      }
      (response && response.log || []).forEach(function (entry) {
        if (!agentLogEl.textContent.includes(entry.detail || "")) {
          appendAgentLog(entry);
        }
      });
      renderAgentResult(response || {}, analysisMode);
      finishAgentState(response || {});
    }
  );
});

agentStopEl.addEventListener("click", function () {
  chrome.runtime.sendMessage({ type: "STOP_AGENT" }, function () {
    setAgentChrome("stopped");
  });
});

if (agentPauseEl) {
  agentPauseEl.addEventListener("click", function () {
    chrome.runtime.sendMessage({ type: "TOGGLE_AGENT_PAUSE" }, function (response) {
      if (chrome.runtime.lastError || !response || !response.ok) {
        agentErrorEl.hidden = false;
        agentErrorEl.textContent =
          (response && response.error) ||
          (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
          "Could not pause or resume the agent.";
        return;
      }
      agentErrorEl.hidden = true;
      agentErrorEl.textContent = "";
    });
  });
}

if (agentContinueEl) {
  agentContinueEl.addEventListener("click", function () {
    agentContinueEl.disabled = true;
    chrome.runtime.sendMessage({ type: "CONTINUE_AGENT" }, function (response) {
      if (chrome.runtime.lastError || !response || !response.ok) {
        agentContinueEl.disabled = false;
        agentErrorEl.hidden = false;
        agentErrorEl.textContent =
          (response && response.error) ||
          (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
          "Could not continue the agent.";
        return;
      }
      agentErrorEl.hidden = true;
      agentErrorEl.textContent = "";
    });
  });
}

if (agentOpenGalleryEl) {
  agentOpenGalleryEl.addEventListener("click", function () {
    if (BrowserAgent.screenshotFrames) {
      BrowserAgent.screenshotFrames.openViewer();
    }
  });
}

if (agentPreviewEl) {
  agentPreviewEl.addEventListener("click", function () {
    if (agentOpenGalleryEl && !agentOpenGalleryEl.hidden && BrowserAgent.screenshotFrames) {
      BrowserAgent.screenshotFrames.openViewer();
    }
  });
}

function restoreLastAgentRun() {
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
    return;
  }
  var apply = function () {
    requestAgentStatus(function (response) {
      if (chrome.runtime.lastError || !response) {
        return;
      }
      if (!response.status || response.status === "idle") {
        return;
      }
      if (response.goal && agentGoalEl) {
        agentGoalEl.value = response.goal;
      }
      agentOutputEl.hidden = false;
      agentLogEl.replaceChildren();
      (response.log || []).forEach(appendAgentLog);
      renderAgentResult(response, response.analysisMode || agentModeEl.value);
      if (response.status === "running") {
        setAgentChrome("running");
        return;
      }
      if (response.status === "waiting_for_user") {
        setAgentChrome("waiting", response.authGate);
        return;
      }
      finishAgentState({
        ok: response.status === "done",
        error: response.error,
        status: response.status,
        authGate: response.authGate
      });
    });
  };
  if (!chrome.tabs || !chrome.tabs.query) {
    apply();
    return;
  }
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    popupAgentTabId = tabs && tabs[0] && tabs[0].id;
    apply();
  });
}

restoreLastAgentRun();
