/**
 * Policy-driven sensitivity classifier.
 *
 * Two independent questions, reported separately so we can tell why an
 * element was flagged:
 *
 *   field purpose — does this control *ask* for sensitive data? Keyword and
 *                   attribute matching against the enabled catalog entries.
 *   value         — does this text *contain* a sensitive identifier? Format
 *                   and checksum validation in utils/validators.js.
 *
 * Field purpose alone misses the common case: PII that has already been
 * submitted and is now rendered as ordinary page text. Value detection alone
 * misses empty forms. We need both.
 *
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

function looksLikeSecurityPinCue(text) {
  var hay = String(text || "");
  if (!hay) {
    return false;
  }
  if (/\b(otp|one[-\s]?time(?:\s*code)?|verification\s*code|2fa)\b/i.test(hay) && !/security\s*pin/i.test(hay)) {
    return false;
  }
  return (
    /security\s*pin/i.test(hay) ||
    /6[\s-]?digit\s+(?:security\s+)?pin/i.test(hay) ||
    /\b(?:m[\s-]?pin|mpin)\b/i.test(hay) ||
    /(?:login|unlock|account)\s*pin/i.test(hay)
  );
}

function nodeCueText(node) {
  if (!node) {
    return "";
  }
  var tag = String(node.tagName || "").toLowerCase();
  if (tag === "script" || tag === "style" || tag === "nav" || tag === "header" || tag === "svg") {
    return "";
  }
  if (node.querySelector && node.querySelector("input, select, textarea")) {
    if (!node.querySelectorAll) {
      return "";
    }
    var heads = node.querySelectorAll("h1, h2, h3, h4, [role='heading']");
    var parts = [];
    var i;
    var piece;
    for (i = 0; i < heads.length && i < 4; i++) {
      piece = String(heads[i].textContent || "").replace(/\s+/g, " ").trim();
      if (piece && piece.length <= 120) {
        parts.push(piece);
      }
    }
    return parts.join(" ");
  }
  var text = String(node.textContent || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 160) {
    return "";
  }
  return text;
}

function nearbyHeadingText(element) {
  if (!element) {
    return "";
  }
  var parts = [];
  function add(node) {
    var text = nodeCueText(node);
    if (text && parts.indexOf(text) === -1) {
      parts.push(text);
    }
  }
  var current = element;
  var hops = 0;
  while (current && hops < 8) {
    var tag = String(current.tagName || "").toLowerCase();
    if (tag === "body" || tag === "html") {
      break;
    }
    var sib = current.previousElementSibling;
    var scanned = 0;
    while (sib && scanned < 6) {
      add(sib);
      sib = sib.previousElementSibling;
      scanned += 1;
    }
    sib = current.nextElementSibling;
    scanned = 0;
    while (sib && scanned < 4) {
      add(sib);
      sib = sib.nextElementSibling;
      scanned += 1;
    }
    current = current.parentElement;
    hops += 1;
  }
  return parts.join(" ");
}

function isInDigitBoxCluster(element) {
  if (!element || !element.parentElement || !element.parentElement.querySelectorAll) {
    return false;
  }
  var current = element;
  var hops = 0;
  while (current && current.parentElement && hops < 6) {
    var inputs = current.parentElement.querySelectorAll("input");
    var digitish = 0;
    var i;
    var el;
    var type;
    var max;
    var mode;
    for (i = 0; i < inputs.length; i++) {
      el = inputs[i];
      type = String(el.type || "").toLowerCase();
      max = Number(el.getAttribute("maxlength") || 0);
      mode = String(el.getAttribute("inputmode") || "").toLowerCase();
      if (
        (type === "password" || type === "tel" || type === "text" || type === "number") &&
        (max === 1 || max === 6 || mode === "numeric" || mode === "tel" || type === "password" || type === "tel")
      ) {
        digitish += 1;
      }
    }
    if (digitish >= 4 && digitish <= 8) {
      return true;
    }
    current = current.parentElement;
    hops += 1;
  }
  return false;
}

function looksLikeDigitPinBox(element, ctx) {
  if (!ctx || !ctx.isField) {
    return false;
  }
  var type = String(ctx.inputType || "").toLowerCase();
  if (
    type === "hidden" ||
    type === "email" ||
    type === "search" ||
    type === "url" ||
    type === "checkbox" ||
    type === "radio" ||
    type === "submit" ||
    type === "button" ||
    type === "file"
  ) {
    return false;
  }
  var max = Number((element.getAttribute && element.getAttribute("maxlength")) || 0);
  var mode = String((element.getAttribute && element.getAttribute("inputmode")) || "").toLowerCase();
  if (max === 1 || max === 6) {
    return true;
  }
  if (mode === "numeric" || mode === "tel") {
    return true;
  }
  if (ctx.autocomplete === "one-time-code") {
    return true;
  }
  if (type === "tel" || type === "number") {
    return true;
  }
  if (type === "password" || type === "text") {
    return isInDigitBoxCluster(element);
  }
  return false;
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

function pixelRegions(snapshot, vision, tags) {
  var viewport = snapshot && snapshot.viewport;
  var image = vision && vision.image;
  if (!viewport || !image || !image.width || !image.height) {
    return [];
  }
  var cssWidth = viewport.visualWidth || viewport.width || 0;
  var cssHeight = viewport.visualHeight || viewport.height || 0;
  if (!cssWidth || !cssHeight) {
    return [];
  }
  var scaleX = image.width / cssWidth;
  var scaleY = image.height / cssHeight;
  var offsetLeft = viewport.offsetLeft || 0;
  var offsetTop = viewport.offsetTop || 0;
  return ((snapshot && snapshot.elements) || [])
    .filter(function (element) {
      return tags.indexOf(element.tag || element.kind) !== -1;
    })
    .map(function (element) {
      var box = element.viewportBox;
      if (!box && element.boundingBox) {
        box = {
          x: element.boundingBox.x - (viewport.scrollX || 0),
          y: element.boundingBox.y - (viewport.scrollY || 0),
          width: element.boundingBox.width,
          height: element.boundingBox.height
        };
      }
      return box
        ? {
            x: (box.x - offsetLeft) * scaleX,
            y: (box.y - offsetTop) * scaleY,
            width: box.width * scaleX,
            height: box.height * scaleY
          }
        : null;
    })
    .filter(Boolean);
}

function boxOverlapsRegion(box, regions) {
  if (!box) {
    return false;
  }
  var centerX = box.x + box.width / 2;
  var centerY = box.y + box.height / 2;
  return regions.some(function (region) {
    return (
      centerX >= region.x &&
      centerX <= region.x + region.width &&
      centerY >= region.y &&
      centerY <= region.y + region.height
    );
  });
}

function catalogIndex() {
  var byId = {};
  (BrowserAgent.SENSITIVITY_CATEGORIES || []).forEach(function (category) {
    byId[category.id] = category;
  });
  return byId;
}

/**
 * Read a control's current value so it can be scanned for identifiers.
 *
 * The value is used and discarded inside this module. Callers only ever see
 * a category and a confidence — never the string, its offset, or its length.
 * Password fields are skipped: field purpose already flags them, and there
 * is nothing to gain by inspecting the secret.
 */
function readControlValue(element) {
  var tag = element.tagName.toLowerCase();
  var type = (element.getAttribute("type") || "").toLowerCase();
  if (type === "password") {
    return "";
  }
  if (tag === "select") {
    var option = element.options && element.options[element.selectedIndex];
    return option ? String(option.text || "") : "";
  }
  if (element.value != null) {
    return String(element.value);
  }
  if (element.isContentEditable) {
    return String(element.textContent || "");
  }
  return "";
}

/**
 * @param {Element} element
 * @param {string} extraText Accessible name, folded into the keyword haystack.
 * @param {object} policy Sensitivity policy from the popup.
 * @param {object} [options]
 * @param {string} [options.text] Rendered text of the element, scanned for
 *   identifier values. Offsets in the result index into this string.
 * @param {boolean} [options.hasUserValue] Whether the control currently holds
 *   a user-entered value worth scanning.
 * @param {string} [options.nearbyText] Text of the preceding sibling. Used
 *   only to corroborate low-confidence shapes such as a voter id, never for
 *   keyword matching — a paragraph must not inherit its neighbour's meaning.
 */
function classifySensitivity(element, extraText, policy, options) {
  var catalog = BrowserAgent.SENSITIVITY_CATEGORIES || [];
  var byId = catalogIndex();
  var validators = BrowserAgent.validators;
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

  var opts = options || {};
  var categories = [];
  var signals = [];
  var level = "unknown";

  function record(categoryId, via, confidence, start, length) {
    var category = byId[categoryId];
    if (!category) {
      return;
    }
    var signal = { category: categoryId, via: via, confidence: confidence };
    if (start != null) {
      signal.start = start;
      signal.length = length;
    }
    signals.push(signal);
    if (categories.indexOf(categoryId) === -1) {
      categories.push(categoryId);
    }
    level = strongerLevel(level, category.level);
  }

  // 1. Field purpose. Unchanged behaviour: keywords, input types, autocomplete.
  var headingCue = nearbyHeadingText(element);
  var pinCue = looksLikeSecurityPinCue(haystack + " " + headingCue);
  var digitBox = looksLikeDigitPinBox(element, ctx);

  catalog.forEach(function (category) {
    if (!policy[category.id]) {
      return;
    }
    if (category.id === "otp" && pinCue && digitBox) {
      return;
    }
    if (!categoryMatchesDom(category, ctx)) {
      return;
    }
    record(category.id, "field-purpose", "keyword");
  });

  if (
    isField &&
    digitBox &&
    pinCue &&
    categories.indexOf("cvv") === -1 &&
    categories.indexOf("security_pin") === -1
  ) {
    record("security_pin", "field-purpose", "keyword");
  }

  if (!validators) {
    return {
      sensitivity: level,
      sensitivityCategories: categories,
      sensitivitySignals: signals
    };
  }

  // Corroboration is deliberately wider than the keyword haystack: a value
  // in a <dd> is often only identifiable from the <dt> beside it, but that
  // neighbouring text must not make the <dd> itself match a category.
  var corroborationText = haystack + " " + (opts.nearbyText || "");

  // 2. Identifier values in text the page renders. Offsets are kept so Phase 5
  //    can replace just the substring rather than masking the whole element.
  if (opts.text) {
    validators
      .findValues(opts.text, policy, { corroborationText: corroborationText })
      .forEach(function (hit) {
        record(hit.category, "value", hit.confidence, hit.start, hit.length);
      });
  }

  // 3. Identifier values the user typed. No offsets: a filled sensitive field
  //    gets masked whole, so position and length are not needed.
  if (isField && opts.hasUserValue) {
    validators
      .scanControlValue(readControlValue(element), policy, corroborationText)
      .forEach(function (hit) {
        record(hit.category, "control-value", hit.confidence);
      });
  }

  return {
    sensitivity: level,
    sensitivityCategories: categories,
    sensitivitySignals: signals
  };
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
  var embeddedRegions = pixelRegions(snapshot, vision, ["img", "image", "canvas"]);
  var canvasRegions = hasCanvas ? pixelRegions(snapshot, vision, ["canvas"]) : [];

  var detections = ((vision && vision.detections) || []).map(function (det) {
    var copy = Object.assign({}, det);
    var cats = [];
    if (policy.faces_people && /(?:face|person)/i.test(det.label || "")) {
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
    // Same validator layer the DOM path uses, so an Aadhaar number read off
    // pixels is held to the same checksum as one read out of the DOM. No
    // corroboration text is available here, so "shape"-only matchers
    // (voter id, passport) stay silent by design.
    //
    // Ordinary painted words — "Government of India", slogans, labels — are
    // not secrets. Tagging every OCR line inside an <img> as sensitive was
    // blacking out entire ID cards.
    if (BrowserAgent.validators) {
      BrowserAgent.validators
        .findValues(item.text || "", policy, { offsets: false })
        .forEach(function (hit) {
          if (cats.indexOf(hit.category) === -1) {
            cats.push(hit.category);
          }
          var category = catalogById[hit.category];
          level = strongerLevel(level, category ? category.level : "potentially_sensitive");
        });
    }
    if (cats.length && policy.image_embedded_text && boxOverlapsRegion(item.boundingBox, embeddedRegions)) {
      cats.push("image_embedded_text");
    }
    if (cats.length && policy.canvas_text && boxOverlapsRegion(item.boundingBox, canvasRegions)) {
      cats.push("canvas_text");
    }
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
  annotatePixelSensitivity: annotatePixelSensitivity,
  // Exported so the redaction pass can read a control's value through the
  // same password guard rather than reimplementing it.
  readControlValue: readControlValue
};

globalThis.BrowserAgent = BrowserAgent;
