/**
 * Build a compact semantic snapshot of the current page from the DOM.
 *
 * Default mode (`visible`) returns only rendered-visible elements.
 * `viewport` mode further limits that set to the current browser viewport.
 * Hidden nodes are counted for debugging but omitted from `elements`.
 */
var BrowserAgent = globalThis.BrowserAgent || {};

var RELEVANT_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "img",
  "canvas",
  "video",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "label",
  "summary",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
  "[role='textbox']",
  "[role='searchbox']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='combobox']",
  "[role='menuitem']",
  "[role='heading']",
  "[role='img']"
].join(",");

/**
 * Containers that commonly display already-submitted data but are far too
 * common to include in the agent context wholesale. These are scanned for
 * identifier values only, and admitted to `elements` solely when something
 * is actually found. Rendered PII usually lives here rather than in the
 * interactive elements RELEVANT_SELECTOR collects.
 */
var VALUE_TEXT_SELECTOR = [
  "div",
  "span",
  "dd",
  "dt",
  "td",
  "th",
  "li",
  "figcaption",
  "address",
  "output",
  "blockquote",
  "pre",
  "code",
  "small",
  "strong",
  "em",
  "b",
  "i"
].join(",");

var INTERACTIVE_ROLES = {
  button: true,
  link: true,
  textbox: true,
  searchbox: true,
  checkbox: true,
  radio: true,
  combobox: true,
  menuitem: true,
  slider: true,
  switch: true,
  tab: true
};

function shortLabelText(node) {
  if (!node) {
    return "";
  }
  if (node.querySelector && node.querySelector("input, select, textarea, button")) {
    return "";
  }
  var text = BrowserAgent.text.normalizeText(node.innerText || node.textContent);
  if (!text || text.length > 80) {
    return "";
  }
  return text;
}

function inferNearbyLabel(element) {
  var prev = element.previousElementSibling;
  while (prev) {
    var direct = shortLabelText(prev);
    if (direct) {
      return direct;
    }
    prev = prev.previousElementSibling;
  }

  var parent = element.parentElement;
  if (!parent) {
    return "";
  }

  var parentPrev = parent.previousElementSibling;
  if (parentPrev) {
    var beside = shortLabelText(parentPrev);
    if (beside) {
      return beside;
    }
  }

  var row = element.closest("tr");
  if (row) {
    var cells = row.querySelectorAll("th, td");
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].contains(element) && i > 0) {
        var cellText = shortLabelText(cells[i - 1]);
        if (cellText) {
          return cellText;
        }
      }
    }
  }

  if (parent.tagName.toLowerCase() === "dd") {
    var dt = parent.previousElementSibling;
    if (dt && dt.tagName.toLowerCase() === "dt") {
      return shortLabelText(dt);
    }
  }

  return "";
}

/**
 * True for elements that have no text of their own and therefore take their
 * accessible name from nearby markup — form controls and contenteditable
 * hosts. A heading, paragraph, cell, or label owns its text and must not
 * borrow a neighbour's.
 */
function takesNameFromContext(element) {
  var tag = element.tagName.toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") {
    return true;
  }
  return Boolean(element.isContentEditable);
}

function getAccessibleName(element) {
  var text = BrowserAgent.text;
  var tag = element.tagName.toLowerCase();
  var ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) {
    return text.truncateText(ariaLabel);
  }

  var labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    var parts = labelledBy.split(/\s+/).map(function (id) {
      var node = document.getElementById(id);
      return node ? text.normalizeText(node.innerText || node.textContent) : "";
    }).filter(Boolean);
    if (parts.length) {
      return text.truncateText(parts.join(" "));
    }
  }

  if (element.labels && element.labels.length) {
    var labelText = Array.prototype.map.call(element.labels, function (label) {
      return text.normalizeText(label.innerText || label.textContent);
    }).join(" ");
    if (labelText) {
      return text.truncateText(labelText);
    }
  }

  // Only a form control borrows its name from surrounding markup. Applying
  // this to text elements made a paragraph inherit the preceding heading's
  // text as its own name, which both mislabelled `text` and fed the wrong
  // words to keyword matching — a paragraph after an "Email address" heading
  // was itself flagged as an email field. Anything with its own text uses it.
  if (takesNameFromContext(element)) {
    var nearby = inferNearbyLabel(element);
    if (nearby) {
      return text.truncateText(nearby);
    }
  }

  var alt = element.getAttribute("alt");
  if (alt) {
    return text.truncateText(alt);
  }

  var title = element.getAttribute("title");
  if (title) {
    return text.truncateText(title);
  }

  var placeholder = element.getAttribute("placeholder");
  if (placeholder) {
    return text.truncateText(placeholder);
  }

  if (tag === "input" || tag === "select" || tag === "textarea") {
    var name = element.getAttribute("name");
    if (name) {
      return text.truncateText(name.replace(/^[0-9_]+/, "").replace(/[_-]+/g, " "));
    }
    return "";
  }

  var ownText = text.normalizeText(element.innerText || element.textContent);
  return text.truncateText(ownText);
}

function isDisabled(element) {
  if (element.disabled === true) {
    return true;
  }
  if (element.getAttribute("aria-disabled") === "true") {
    return true;
  }
  if (element.closest("fieldset[disabled]")) {
    return true;
  }
  return false;
}

function headingLevel(element) {
  var match = /^h([1-6])$/.exec(element.tagName.toLowerCase());
  if (match) {
    return Number(match[1]);
  }
  var ariaLevel = element.getAttribute("aria-level");
  if (ariaLevel && /^\d+$/.test(ariaLevel)) {
    return Number(ariaLevel);
  }
  return undefined;
}

function classifyKind(element) {
  var tag = element.tagName.toLowerCase();
  var role = (element.getAttribute("role") || "").toLowerCase();
  var inputType = (element.getAttribute("type") || "").toLowerCase();

  if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6" || role === "heading") {
    return "heading";
  }
  if (tag === "img" || role === "img") {
    return "image";
  }
  if (tag === "canvas") {
    return "canvas";
  }
  if (tag === "video") {
    return "video";
  }
  if (tag === "a" || role === "link") {
    return "link";
  }
  if (tag === "textarea") {
    return "textarea";
  }
  if (tag === "select") {
    return "select";
  }
  if ((tag === "input" && inputType === "checkbox") || role === "checkbox") {
    return "checkbox";
  }
  if ((tag === "input" && inputType === "radio") || role === "radio") {
    return "radio";
  }
  if (
    tag === "button" ||
    role === "button" ||
    tag === "summary" ||
    (tag === "input" && (inputType === "button" || inputType === "submit" || inputType === "reset" || inputType === "image"))
  ) {
    return "button";
  }
  if (tag === "label") {
    return "label";
  }
  if (tag === "input" || role === "textbox" || role === "searchbox" || element.isContentEditable) {
    return "input";
  }
  return "text";
}

function isInteractive(element, kind) {
  var tag = element.tagName.toLowerCase();
  var role = (element.getAttribute("role") || "").toLowerCase();
  if (kind === "button" || kind === "link" || kind === "input" || kind === "textarea" || kind === "select" || kind === "checkbox" || kind === "radio") {
    return true;
  }
  if (INTERACTIVE_ROLES[role]) {
    return true;
  }
  if (element.isContentEditable) {
    return true;
  }
  if (tag === "summary") {
    return true;
  }
  if (element.tabIndex >= 0 && (tag === "div" || tag === "span")) {
    return true;
  }
  return false;
}

function isTrackingPixel(element) {
  if (element.tagName.toLowerCase() !== "img") {
    return false;
  }
  var width = Number(element.getAttribute("width"));
  var height = Number(element.getAttribute("height"));
  return width === 1 && height === 1;
}

function normalizeMode(mode) {
  if (mode === BrowserAgent.MODES.VIEWPORT || mode === "viewport") {
    return BrowserAgent.MODES.VIEWPORT;
  }
  return BrowserAgent.MODES.VISIBLE;
}

function passesModeFilter(visible, inViewport, mode) {
  if (!visible) {
    return false;
  }
  if (mode === BrowserAgent.MODES.VIEWPORT) {
    return inViewport;
  }
  return true;
}

function selectOptions(element) {
  if (element.tagName.toLowerCase() !== "select") {
    return undefined;
  }
  var labels = [];
  var options = element.options || [];
  var limit = Math.min(options.length, 30);
  for (var i = 0; i < limit; i++) {
    var label = BrowserAgent.text.truncateText(options[i].text, 80);
    if (label) {
      labels.push(label);
    }
  }
  if (options.length > 30) {
    labels.push("… " + (options.length - 30) + " more options omitted");
  }
  return labels;
}

function compactSrc(element) {
  if (element.tagName.toLowerCase() !== "img") {
    return undefined;
  }
  var src = element.currentSrc || element.getAttribute("src") || "";
  if (!src || src.indexOf("data:") === 0) {
    return undefined;
  }
  try {
    var url = new URL(src, location.href);
    return url.origin + url.pathname;
  } catch (error) {
    return undefined;
  }
}

function controlHasUserValue(element) {
  var tag = element.tagName.toLowerCase();
  var type = (element.getAttribute("type") || (tag === "input" ? "text" : "")).toLowerCase();
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
  if (tag === "select") {
    if (element.selectedIndex < 0) {
      return false;
    }
    var opt = element.options[element.selectedIndex];
    if (!opt) {
      return false;
    }
    var optionText = String(opt.text || "").trim();
    var optionValue = String(opt.value || "").trim();
    if (!optionText && !optionValue) {
      return false;
    }
    if (/^(select|choose|pick)\b/i.test(optionText) || /^--/.test(optionText)) {
      return false;
    }
    return true;
  }
  var raw = element.value;
  if (raw == null) {
    if (element.isContentEditable) {
      return Boolean((element.textContent || "").trim());
    }
    return false;
  }
  var value = String(raw).trim();
  if (!value) {
    return false;
  }
  var placeholder = String(element.getAttribute("placeholder") || "").trim();
  if (placeholder && value.toLowerCase() === placeholder.toLowerCase()) {
    return false;
  }
  return true;
}

/**
 * Text this element contributes itself, from its immediate child text nodes
 * only. Descendant text belongs to the descendant.
 *
 * Using direct text rather than innerText matters for three reasons: each
 * text node is scanned exactly once no matter how deeply nested, a wrapper
 * and its child cannot both report the same identifier, and we avoid forcing
 * layout on every candidate.
 *
 * The trade-off is that a value split across inline elements
 * (`<span>2345</span><span>6789 0124</span>`) is not seen as one value.
 *
 * Offsets reported against this string are reproducible: a later phase can
 * recompute it from the live DOM, so the snapshot never has to carry the text
 * just to locate a redaction.
 */
function directText(element) {
  var parts = [];
  var nodes = element.childNodes;
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].nodeType === 3) {
      parts.push(nodes[i].nodeValue);
    }
  }
  if (!parts.length) {
    return "";
  }
  var raw = BrowserAgent.text.normalizeText(parts.join(" "));
  var limit = BrowserAgent.validators ? BrowserAgent.validators.MAX_SCAN_LENGTH : 4000;
  return raw.length > limit ? raw.slice(0, limit) : raw;
}

function renderedTextFor(element) {
  var tag = element.tagName.toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") {
    return "";
  }
  return directText(element);
}

/**
 * The string to scan for identifier values.
 *
 * This must be the string that ends up in the snapshot, not merely the one the
 * element "owns". `text` is serialised from the accessible name, which for a
 * text element folds in descendant content; scanning only direct child text
 * nodes meant a value split across inline children — `<span>4561</span>
 * <span>2378 9011</span>` — was reported as absent while the joined form was
 * serialised anyway. Redaction re-scans and caught it regardless, so nothing
 * leaked, but an element could be redacted while carrying no signal saying
 * why. Scanning what we serialise keeps the two answers consistent, and keeps
 * the signal offsets meaningful against the field they index into.
 *
 * Direct text is still preferred when it already covers the accessible name,
 * so the common case neither changes nor pays for the longer string.
 */
function scannableTextFor(element, accessibleName) {
  var own = renderedTextFor(element);
  if (!accessibleName) {
    return own;
  }
  var tag = element.tagName.toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") {
    return "";
  }
  return accessibleName.length > own.length ? accessibleName : own;
}

function extractElement(element, inViewport, policy) {
  var textUtil = BrowserAgent.text;
  var kind = classifyKind(element);
  var agentId = BrowserAgent.identifiers.getOrCreateId(element);
  var accessibleName = getAccessibleName(element);
  var inputType = element.tagName.toLowerCase() === "input"
    ? (element.getAttribute("type") || "text").toLowerCase()
    : undefined;
  var hasUserValue = controlHasUserValue(element);
  var classified = BrowserAgent.sensitivity.classifySensitivity(element, accessibleName, policy, {
    text: scannableTextFor(element, accessibleName),
    hasUserValue: hasUserValue,
    nearbyText: cheapNearbyText(element)
  });

  var record = {
    id: agentId,
    selectorHint: BrowserAgent.identifiers.selectorHint(element, agentId),
    kind: kind,
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute("role") || undefined,
    inputType: inputType,
    text: accessibleName,
    ariaLabel: textUtil.truncateText(element.getAttribute("aria-label") || ""),
    placeholder: textUtil.truncateText(element.getAttribute("placeholder") || ""),
    name: element.getAttribute("name") || undefined,
    htmlId: element.getAttribute("id") || undefined,
    href: element.tagName.toLowerCase() === "a" ? element.href || element.getAttribute("href") : undefined,
    alt: textUtil.truncateText(element.getAttribute("alt") || ""),
    autocomplete: element.getAttribute("autocomplete") || undefined,
    labelFor: element.tagName.toLowerCase() === "label" ? (element.getAttribute("for") || undefined) : undefined,
    headingLevel: headingLevel(element),
    checked: (kind === "checkbox" || kind === "radio") ? !!element.checked : undefined,
    options: selectOptions(element),
    src: compactSrc(element),
    interactive: isInteractive(element, kind),
    visible: true,
    inViewport: inViewport,
    disabled: isDisabled(element),
    boundingBox: BrowserAgent.visibility.getBoundingBox(element),
    viewportBox: BrowserAgent.visibility.getViewportBox(element),
    hasUserValue: hasUserValue,
    sensitivity: classified.sensitivity,
    sensitivityCategories: classified.sensitivityCategories,
    sensitivitySignals: classified.sensitivitySignals
  };

  return textUtil.compactRecord(record);
}

/**
 * Cheap label lookup for the second-pass pre-filter: the preceding sibling's
 * own text. Covers the common "label then value" markup patterns —
 * `<dt>`/`<dd>`, `<th>`/`<td>`, and a heading before a value — without
 * forcing layout the way getAccessibleName can.
 *
 * extractElement later corroborates against the full accessible name, which
 * is a superset of this, so the pre-filter never admits something the real
 * classifier would reject.
 */
function cheapNearbyText(element) {
  var prev = element.previousElementSibling;
  return prev ? directText(prev) : "";
}

function isShortParagraph(element) {
  if (element.tagName.toLowerCase() !== "p") {
    return false;
  }
  var text = BrowserAgent.text.normalizeText(element.innerText || element.textContent);
  return text.length < 24;
}

function extractPage(options) {
  var mode = normalizeMode(options && options.mode);
  var policy = BrowserAgent.normalizeSensitivityPolicy
    ? BrowserAgent.normalizeSensitivityPolicy(options && options.sensitivityPolicy)
    : (options && options.sensitivityPolicy) || {};
  var nodes = document.querySelectorAll(RELEVANT_SELECTOR);
  var elements = [];
  var seen = new Set();
  var paragraphBudget = 12;
  var found = 0;
  var visibleCount = 0;
  var viewportCount = 0;
  var interactiveVisible = 0;

  for (var i = 0; i < nodes.length; i++) {
    var element = nodes[i];
    if (seen.has(element)) {
      continue;
    }
    seen.add(element);
    found += 1;

    var visibility = BrowserAgent.visibility.classifyVisibility(element);
    if (isTrackingPixel(element)) {
      visibility.visible = false;
      visibility.inViewport = false;
    }

    var kind = classifyKind(element);
    var isInteractiveEl = isInteractive(element, kind);

    if (visibility.visible) {
      visibleCount += 1;
      if (isInteractiveEl) {
        interactiveVisible += 1;
      }
    }
    if (visibility.inViewport) {
      viewportCount += 1;
    }

    if (!passesModeFilter(visibility.visible, visibility.inViewport, mode)) {
      continue;
    }
    if (isShortParagraph(element)) {
      continue;
    }
    if (element.tagName.toLowerCase() === "p") {
      if (paragraphBudget <= 0) {
        continue;
      }
      paragraphBudget -= 1;
    }

    elements.push(extractElement(element, visibility.inViewport, policy));
  }

  // Second pass. RELEVANT_SELECTOR is built around interactive and structural
  // elements, but rendered PII usually sits in a div, span, td, or dd. Scan
  // those for identifier values and admit one only when a value is actually
  // found, so the agent context stays small.
  var valueOnlyElements = 0;
  if (BrowserAgent.validators) {
    var textNodes = document.querySelectorAll(VALUE_TEXT_SELECTOR);
    for (var t = 0; t < textNodes.length; t++) {
      var candidate = textNodes[t];
      if (seen.has(candidate)) {
        continue;
      }
      var ownText = directText(candidate);
      if (!ownText) {
        continue;
      }
      var hits = BrowserAgent.validators.findValues(ownText, policy, {
        corroborationText: ownText + " " + cheapNearbyText(candidate)
      });
      if (!hits.length) {
        continue;
      }
      seen.add(candidate);
      var textVisibility = BrowserAgent.visibility.classifyVisibility(candidate);
      if (!passesModeFilter(textVisibility.visible, textVisibility.inViewport, mode)) {
        continue;
      }
      elements.push(extractElement(candidate, textVisibility.inViewport, policy));
      valueOnlyElements += 1;
    }
  }

  var interactiveInContext = 0;
  var sensitive = 0;
  var potentiallySensitive = 0;
  var valueMatched = 0;
  var checksumVerified = 0;
  for (var j = 0; j < elements.length; j++) {
    if (elements[j].interactive) {
      interactiveInContext += 1;
    }
    if (elements[j].sensitivity === "sensitive") {
      sensitive += 1;
    }
    if (elements[j].sensitivity === "potentially_sensitive") {
      potentiallySensitive += 1;
    }
    var signals = elements[j].sensitivitySignals || [];
    var hasValueSignal = false;
    var hasChecksum = false;
    for (var k = 0; k < signals.length; k++) {
      if (signals[k].via === "value" || signals[k].via === "control-value") {
        hasValueSignal = true;
        if (signals[k].confidence === "checksum") {
          hasChecksum = true;
        }
      }
    }
    if (hasValueSignal) {
      valueMatched += 1;
    }
    if (hasChecksum) {
      checksumVerified += 1;
    }
  }

  return {
    schemaVersion: BrowserAgent.SCHEMA_VERSION,
    extractedAt: new Date().toISOString(),
    mode: mode,
    sensitivityPolicy: policy,
    page: {
      title: document.title || "",
      url: location.href,
      lang: document.documentElement.lang || undefined
    },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      clientWidth: document.documentElement.clientWidth,
      clientHeight: document.documentElement.clientHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      offsetLeft: window.visualViewport ? window.visualViewport.offsetLeft : 0,
      offsetTop: window.visualViewport ? window.visualViewport.offsetTop : 0,
      visualWidth: window.visualViewport ? window.visualViewport.width : window.innerWidth,
      visualHeight: window.visualViewport ? window.visualViewport.height : window.innerHeight
    },
    elements: elements,
    counts: {
      found: found,
      visible: visibleCount,
      inViewport: viewportCount,
      interactiveVisible: interactiveVisible,
      elements: elements.length,
      interactive: interactiveInContext,
      sensitive: sensitive,
      potentiallySensitive: potentiallySensitive,
      valueMatched: valueMatched,
      checksumVerified: checksumVerified,
      valueOnlyElements: valueOnlyElements
    },
    limits: {
      iframeCount: document.querySelectorAll("iframe").length,
      shadowDomNotPierced: true,
      visibilityIsCssNotVisual: true
    }
  };
}

BrowserAgent.extractPage = extractPage;

globalThis.BrowserAgent = BrowserAgent;
