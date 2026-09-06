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
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='link']",
  "[role='textbox']",
  "[role='searchbox']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='combobox']",
  "[role='menuitem']",
  "[role='listitem']",
  "[role='row']",
  "[role='option']",
  "[role='gridcell']",
  "[role='tab']",
  "[role='heading']",
  "[role='img']",
  "div[tabindex='0']",
  "li[tabindex='0']",
  "article[tabindex='0']",
  "section[tabindex='0']"
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
  listitem: true,
  row: true,
  option: true,
  gridcell: true,
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
  var current = element;
  var hops = 0;
  while (current && hops < 6) {
    var tag = String(current.tagName || "").toLowerCase();
    if (tag === "body" || tag === "html") {
      break;
    }
    var prev = current.previousElementSibling;
    while (prev) {
      var direct = shortLabelText(prev);
      if (direct) {
        return direct;
      }
      prev = prev.previousElementSibling;
    }
    current = current.parentElement;
    hops += 1;
  }

  var parent = element.parentElement;
  if (!parent) {
    return "";
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

function isConversationRow(element) {
  var role = (element.getAttribute("role") || "").toLowerCase();
  return role === "listitem" || role === "row" || role === "option" || role === "gridcell";
}

function isPreviewLabel(text) {
  return (
    /\breacted\b/i.test(text) ||
    /^(yesterday|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(text) ||
    /^\d{1,2}:\d{2}/.test(text)
  );
}

function conversationLabel(element) {
  if (!isConversationRow(element)) {
    return "";
  }
  var spans = element.querySelectorAll("span, strong");
  var i;
  var own;
  for (i = 0; i < spans.length; i++) {
    own = BrowserAgent.text.normalizeText(spans[i].textContent || "");
    if (
      own.length >= 2 &&
      own.length <= 48 &&
      spans[i].querySelectorAll("span, div").length <= 2 &&
      !isPreviewLabel(own)
    ) {
      return own;
    }
  }
  var titled = BrowserAgent.text.normalizeText(element.getAttribute("title") || "");
  if (titled && titled.length >= 2 && titled.length <= 80 && !/\breacted\b/i.test(titled)) {
    return titled.split(/[.•·]/)[0].trim().slice(0, 48);
  }
  var raw = String(element.innerText || element.textContent || "");
  var firstLine = BrowserAgent.text.normalizeText(raw.split("\n")[0] || "");
  if (firstLine.length >= 2 && firstLine.length <= 48 && !isPreviewLabel(firstLine)) {
    return firstLine;
  }
  var blob = BrowserAgent.text.normalizeText(raw);
  if (!blob) {
    return "";
  }
  return blob.slice(0, 48);
}

function looksLikePhoneLabel(text) {
  var digits = String(text || "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 && /^\+?[\d\s().-]{8,22}$/.test(String(text || "").trim());
}

function normalizeOpenTitle(raw) {
  var name = BrowserAgent.text.normalizeText(raw || "");
  name = name
    .replace(/\b(last seen|online|typing|click here for contact info|tap here for contact info|click here for group info).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name || name.length < 2 || name.length > 48) {
    return "";
  }
  if (looksLikePhoneLabel(name)) {
    return "";
  }
  if (
    /^(search|menu|mute|video|voice|online|offline|typing|chats|status|about)$/i.test(name) ||
    /\b(search or start|type a message)\b/i.test(name)
  ) {
    return "";
  }
  return name;
}

function pushOpenTitle(list, raw) {
  var name = normalizeOpenTitle(raw);
  if (name && list.indexOf(name) === -1) {
    list.push(name);
  }
}

function detectOpenConversationCandidates() {
  var candidates = [];
  var main = document.getElementById("main");
  var header = main ? main.querySelector("header") : null;
  var nodes;
  var i;
  var docTitle;
  if (header) {
    nodes = header.querySelectorAll("[title]");
    for (i = 0; i < nodes.length; i++) {
      pushOpenTitle(candidates, nodes[i].getAttribute("title"));
    }
    nodes = header.querySelectorAll("span, strong, h1, h2, [role='heading']");
    for (i = 0; i < nodes.length; i++) {
      pushOpenTitle(candidates, nodes[i].textContent);
    }
  }
  docTitle = String(document.title || "")
    .replace(/^\(\d+\)\s*/, "")
    .replace(/\s*[-–|].*$/, "")
    .trim();
  pushOpenTitle(candidates, docTitle);
  return candidates;
}

function detectOpenConversation() {
  return detectOpenConversationCandidates()[0] || "";
}

function getAccessibleName(element) {
  var text = BrowserAgent.text;
  var tag = element.tagName.toLowerCase();
  var conv = conversationLabel(element);
  if (conv) {
    return conv;
  }
  var ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) {
    var aria = text.normalizeText(ariaLabel);
    if (isConversationRow(element) && aria.length > 80) {
      return aria.slice(0, 48);
    }
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
  if (
    role === "listitem" ||
    role === "row" ||
    role === "option" ||
    role === "menuitem" ||
    role === "tab"
  ) {
    return "button";
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
  if (element.tabIndex >= 0 && (tag === "div" || tag === "li" || tag === "article" || tag === "section")) {
    var cardText = String(element.innerText || element.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (cardText.length <= 200 && /\b(verified|unverified)\b/i.test(cardText)) {
      return "button";
    }
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
    ariaSelected: element.getAttribute("aria-selected") === "true" ? true : undefined,
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

function isAgentOverlay(element) {
  return Boolean(element && element.closest && element.closest("[data-browser-agent]"));
}

function pageHasSecurityPinCue() {
  var text = "";
  try {
    text = String(
      (document.body && (document.body.innerText || document.body.textContent)) ||
        document.title ||
        ""
    ).slice(0, 8000);
  } catch (error) {
    text = String(document.title || "");
  }
  if (/\b(otp|one[-\s]?time(?:\s*code)?)\b/i.test(text) && !/security\s*pin/i.test(text)) {
    return false;
  }
  return (
    /security\s*pin/i.test(text) ||
    /6[\s-]?digit\s+(?:security\s+)?pin/i.test(text) ||
    /\b(?:m[\s-]?pin|mpin)\b/i.test(text)
  );
}

function isLikelyPinInput(element) {
  if (!element || String(element.tagName || "").toLowerCase() !== "input") {
    return false;
  }
  var type = String(element.getAttribute("type") || element.type || "text").toLowerCase();
  if (type === "hidden" || type === "checkbox" || type === "radio" || type === "submit" || type === "button") {
    return false;
  }
  var max = Number(element.getAttribute("maxlength") || 0);
  var mode = String(element.getAttribute("inputmode") || "").toLowerCase();
  var auto = String(element.getAttribute("autocomplete") || "").toLowerCase();
  return (
    type === "password" ||
    type === "tel" ||
    type === "number" ||
    max === 1 ||
    max === 6 ||
    mode === "numeric" ||
    mode === "tel" ||
    auto === "one-time-code"
  );
}

function extractPage(options) {
  var mode = normalizeMode(options && options.mode);
  var policy = BrowserAgent.normalizeSensitivityPolicy
    ? BrowserAgent.normalizeSensitivityPolicy(options && options.sensitivityPolicy)
    : (options && options.sensitivityPolicy) || {};
  var keepHiddenPinBoxes = pageHasSecurityPinCue();
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
    if (isAgentOverlay(element) || seen.has(element)) {
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
      if (!(keepHiddenPinBoxes && isLikelyPinInput(element))) {
        continue;
      }
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
      if (isAgentOverlay(candidate) || seen.has(candidate)) {
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

  var chooserBudget = 8;
  var chooserScan = document.querySelectorAll(
    "div, li, article, section, label, [tabindex='0']"
  );
  for (var c = 0; c < chooserScan.length && chooserBudget > 0; c++) {
    var chooser = chooserScan[c];
    if (isAgentOverlay(chooser) || seen.has(chooser)) {
      continue;
    }
    var chooserText = String(chooser.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (chooserText.length < 6 || chooserText.length > 200) {
      continue;
    }
    if (!/\b(verified|unverified)\b/i.test(chooserText)) {
      continue;
    }
    var target = chooser;
    var climb = chooser;
    for (var depth = 0; depth < 8 && climb; depth++) {
      var climbRole = (climb.getAttribute && (climb.getAttribute("role") || "").toLowerCase()) || "";
      if (
        climb.tabIndex >= 0 ||
        climbRole === "button" ||
        climbRole === "link" ||
        climbRole === "option" ||
        climbRole === "radio" ||
        climbRole === "listitem" ||
        (climb.getAttribute && climb.getAttribute("onclick"))
      ) {
        target = climb;
        break;
      }
      climb = climb.parentElement;
    }
    if (seen.has(target)) {
      continue;
    }
    var chooserVisibility = BrowserAgent.visibility.classifyVisibility(target);
    if (!passesModeFilter(chooserVisibility.visible, chooserVisibility.inViewport, mode)) {
      continue;
    }
    seen.add(target);
    elements.push(extractElement(target, chooserVisibility.inViewport, policy));
    chooserBudget -= 1;
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
      lang: document.documentElement.lang || undefined,
      openConversation: detectOpenConversation() || undefined,
      openConversationCandidates: detectOpenConversationCandidates()
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
