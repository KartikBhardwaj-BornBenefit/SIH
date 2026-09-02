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

  var nearby = inferNearbyLabel(element);
  if (nearby) {
    return text.truncateText(nearby);
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

function extractElement(element, inViewport, policy) {
  var textUtil = BrowserAgent.text;
  var kind = classifyKind(element);
  var agentId = BrowserAgent.identifiers.getOrCreateId(element);
  var accessibleName = getAccessibleName(element);
  var inputType = element.tagName.toLowerCase() === "input"
    ? (element.getAttribute("type") || "text").toLowerCase()
    : undefined;
  var classified = BrowserAgent.sensitivity.classifySensitivity(element, accessibleName, policy);

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
    hasUserValue: controlHasUserValue(element),
    sensitivity: classified.sensitivity,
    sensitivityCategories: classified.sensitivityCategories
  };

  return textUtil.compactRecord(record);
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

  var interactiveInContext = 0;
  var sensitive = 0;
  var potentiallySensitive = 0;
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
      potentiallySensitive: potentiallySensitive
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
