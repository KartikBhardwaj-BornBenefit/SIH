/**
 * Policy-driven sensitivity classifier.
 *
 * Matches DOM attributes against the enabled categories in the popup form.
 * Vision/OCR hits are annotated separately with annotatePixelSensitivity().
 */
var BrowserAgent = globalThis.BrowserAgent || {};

function collectHaystack(element, extraText) {
  var parts = [
    element.getAttribute("name"),
    element.getAttribute("id"),
    element.getAttribute("placeholder"),
    element.getAttribute("aria-label"),
    element.getAttribute("autocomplete"),
    element.getAttribute("type"),
    extraText
  ];
  return parts.filter(Boolean).join(" ");
}

function matchesAny(text, patterns) {
  if (!text || !patterns) {
    return false;
  }
  for (var i = 0; i < patterns.length; i++) {
    if (patterns[i].test(text)) {
      return true;
    }
  }
  return false;
}

function listIncludes(list, value) {
  if (!list || !value) {
    return false;
  }
  return list.indexOf(value) !== -1;
}

function categoryMatchesDom(category, ctx) {
  if (category.source && category.source !== "dom") {
    return false;
  }
  if (category.fieldOnly && !ctx.isField) {
    return false;
  }
  if (listIncludes(category.inputTypes, ctx.inputType)) {
    return true;
  }
  if (listIncludes(category.autocomplete, ctx.autocomplete)) {
    return true;
  }
  return matchesAny(ctx.haystack, category.patterns);
}

function strongerLevel(current, next) {
  if (next === "sensitive" || current === "sensitive") {
    return "sensitive";
  }
  if (next === "potentially_sensitive" || current === "potentially_sensitive") {
    return "potentially_sensitive";
  }
  return "unknown";
}

function classifySensitivity(element, extraText, policy) {
  var catalog = BrowserAgent.SENSITIVITY_CATEGORIES || [];
  policy = BrowserAgent.normalizeSensitivityPolicy
    ? BrowserAgent.normalizeSensitivityPolicy(policy)
    : policy || {};

  var tag = element.tagName.toLowerCase();
  var inputType = (element.getAttribute("type") || (tag === "input" ? "text" : "")).toLowerCase();
  var autocomplete = (element.getAttribute("autocomplete") || "").trim().toLowerCase();
  var haystack = collectHaystack(element, extraText);
  var isField = tag === "input" || tag === "textarea" || tag === "select";
  var ctx = {
    tag: tag,
    inputType: inputType,
    autocomplete: autocomplete,
    haystack: haystack,
    isField: isField
  };

  var categories = [];
  var level = "unknown";

  catalog.forEach(function (category) {
    if (!policy[category.id]) {
      return;
    }
    if (!categoryMatchesDom(category, ctx)) {
      return;
    }
    categories.push(category.id);
    level = strongerLevel(level, category.level);
  });

  return {
    sensitivity: level,
    sensitivityCategories: categories
  };
}

function textMatchesCategory(category, text) {
  if (!text) {
    return false;
  }
  if (category.id === "email") {
    return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text);
  }
  if (category.id === "phone") {
    return /(\+?\d[\d\s\-()]{8,}\d)/.test(text);
  }
  return matchesAny(text, category.patterns);
}

function annotatePixelSensitivity(vision, ocr, snapshot, policy) {
  policy = BrowserAgent.normalizeSensitivityPolicy
    ? BrowserAgent.normalizeSensitivityPolicy(policy)
    : policy || {};
  var catalogById = {};
  (BrowserAgent.SENSITIVITY_CATEGORIES || []).forEach(function (category) {
    catalogById[category.id] = category;
  });

  var hasCanvas = snapshot && snapshot.elements
    ? snapshot.elements.some(function (el) {
        return el.tag === "canvas" || el.kind === "canvas";
      })
    : false;

  var detections = ((vision && vision.detections) || []).map(function (det) {
    var copy = Object.assign({}, det);
    var cats = [];
    if (policy.faces_people && /person/i.test(det.label || "")) {
      cats.push("faces_people");
    }
    copy.sensitivityCategories = cats;
    copy.sensitivity = cats.length
      ? (catalogById.faces_people && catalogById.faces_people.level) || "potentially_sensitive"
      : "unknown";
    return copy;
  });

  var ocrItems = ((ocr && ocr.items) || []).map(function (item) {
    var copy = Object.assign({}, item);
    var cats = [];
    var level = "unknown";
    if (policy.image_embedded_text) {
      cats.push("image_embedded_text");
      level = strongerLevel(level, "potentially_sensitive");
    }
    if (policy.canvas_text && hasCanvas) {
      cats.push("canvas_text");
      level = strongerLevel(level, "potentially_sensitive");
    }
    ["email", "phone", "aadhaar", "pan", "passport", "bank_account"].forEach(function (id) {
      if (!policy[id] || !catalogById[id]) {
        return;
      }
      if (textMatchesCategory(catalogById[id], item.text || "")) {
        cats.push(id);
        level = strongerLevel(level, catalogById[id].level);
      }
    });
    copy.sensitivityCategories = cats;
    copy.sensitivity = level;
    return copy;
  });

  return {
    detections: detections,
    ocrItems: ocrItems
  };
}

BrowserAgent.sensitivity = {
  classifySensitivity: classifySensitivity,
  annotatePixelSensitivity: annotatePixelSensitivity
};

globalThis.BrowserAgent = BrowserAgent;
