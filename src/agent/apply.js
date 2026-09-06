/**
 * Apply validated agent actions to the live page.
 *
 * Runs in the content script's isolated world. Placeholders are expanded
 * from the session vault here, so a real value is written into the control
 * and is never handed back to the service worker or the model.
 *
 * Fail closed: an unknown placeholder, a one-way credential token, or an
 * incoming string that already contains a vault value stops that action.
 */
var BrowserAgent = globalThis.BrowserAgent || {};

var ONE_WAY_TOKENS = { PASSWORD: true, CVV: true, OTP: true };
var PRESS_KEYS = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Space: { key: " ", code: "Space", keyCode: 32 }
};

function findNode(agentId) {
  try {
    return document.querySelector('[data-browser-agent-id="' + agentId + '"]');
  } catch (error) {
    return null;
  }
}

var GOAL_STOP = {
  write: true,
  type: true,
  chat: true,
  named: true,
  name: true,
  send: true,
  open: true,
  the: true,
  and: true,
  message: true,
  box: true,
  then: true,
  with: true,
  person: true,
  to: true,
  in: true,
  for: true,
  hi: true,
  there: true,
  please: true
};

function uniqueNeedles(values) {
  var out = [];
  (values || []).forEach(function (value) {
    var text = String(value || "").replace(/\s+/g, " ").trim();
    if (text.length < 3 || out.indexOf(text) !== -1) {
      return;
    }
    out.push(text);
  });
  return out.sort(function (a, b) {
    return b.length - a.length;
  });
}

function expandSearchText(text, vault) {
  var out = String(text || "");
  Object.keys(vault || {}).forEach(function (placeholder) {
    var value = vault[placeholder];
    if (!value || out.indexOf(placeholder) === -1) {
      return;
    }
    out = out.split(placeholder).join(value);
  });
  return out
    .replace(/<TRUNCATED_[0-9]+>/g, " ")
    .replace(/<[A-Z][A-Z0-9_]*_[0-9]+>/g, " ")
    .replace(/<PROFILE_[A-Z][A-Z0-9_]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function needlesForSnapshot(snapshot, options) {
  if (!snapshot) {
    return [];
  }
  var vault = (options && options.vault) || {};
  var raw = [snapshot.text, snapshot.ariaLabel, snapshot.placeholder]
    .map(function (value) {
      return expandSearchText(value, vault);
    })
    .filter(Boolean);
  if (options && options.goal) {
    String(options.goal)
      .split(/[^A-Za-z\u0900-\u097F0-9]+/)
      .forEach(function (word) {
        if (word.length >= 4 && !GOAL_STOP[word.toLowerCase()]) {
          raw.push(word);
        }
      });
  }
  var first = expandSearchText(snapshot.text, vault).split(" ")[0];
  if (first && first.length >= 4) {
    raw.push(first);
  }
  return uniqueNeedles(raw);
}

function nodeHaystack(node) {
  return [
    node.innerText,
    node.textContent,
    node.getAttribute && node.getAttribute("aria-label"),
    node.getAttribute && node.getAttribute("title")
  ]
    .filter(Boolean)
    .join(" ");
}

function conversationTitleFromNode(node) {
  var inner = String((node && (node.innerText || node.textContent)) || "");
  var lines = inner.split(/\n+/);
  var firstLine = "";
  var i;
  for (i = 0; i < lines.length; i++) {
    firstLine = lines[i].replace(/\s+/g, " ").trim();
    if (firstLine) {
      break;
    }
  }
  if (firstLine && firstLine.length <= 48 && !/\breacted\b/i.test(firstLine)) {
    return firstLine;
  }
  var titled = String((node && node.getAttribute && node.getAttribute("title")) || "")
    .replace(/\s+/g, " ")
    .trim();
  if (titled && titled.length <= 48 && !/\breacted\b/i.test(titled)) {
    return titled;
  }
  return firstLine || titled;
}

function findReplacementNode(snapshot, options) {
  var needles = needlesForSnapshot(snapshot, options);
  if (!needles.length) {
    return null;
  }
  var role = String((snapshot && snapshot.role) || "").toLowerCase();
  var selector =
    "[role='listitem'], [role='row'], [role='option'], [role='button'], [role='link'], [role='tab'], [role='textbox'], [role='searchbox'], [contenteditable], button, a";
  var nodes = document.querySelectorAll(selector);
  var requirePrefix = role === "listitem" || role === "row";
  var i;
  var n;
  var hay;
  var needle;
  var title;
  for (i = 0; i < nodes.length; i++) {
    n = nodes[i];
    if (role && String(n.getAttribute("role") || "").toLowerCase() !== role) {
      continue;
    }
    hay = nodeHaystack(n);
    title = conversationTitleFromNode(n);
    for (var j = 0; j < needles.length; j++) {
      needle = needles[j];
      if (requirePrefix) {
        if (
          title.toLowerCase().indexOf(needle.toLowerCase()) === 0 ||
          title.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9\u0900-\u097F]+/gi, "") ===
            needle.toLowerCase()
        ) {
          return n;
        }
      } else if (hay.toLowerCase().indexOf(needle.toLowerCase()) !== -1) {
        return n;
      }
    }
  }
  return null;
}

function locateNode(agentId, options) {
  var node = findNode(agentId);
  if (node) {
    return node;
  }
  var elements = (options && options.elements) || [];
  var snapshot = null;
  for (var i = 0; i < elements.length; i++) {
    if (elements[i] && elements[i].id === agentId) {
      snapshot = elements[i];
      break;
    }
  }
  node = findReplacementNode(snapshot, options);
  if (node && snapshot && snapshot.id) {
    node.setAttribute("data-browser-agent-id", snapshot.id);
  }
  return node;
}

function requireNode(agentId, options) {
  var node = locateNode(agentId, options);
  if (!node) {
    return { ok: false, error: "No element with id " + agentId + "." };
  }
  if (isDisabled(node)) {
    return { ok: false, error: "Element " + agentId + " is disabled." };
  }
  return { ok: true, node: node };
}

function tokenOf(placeholder) {
  var inner = String(placeholder || "").replace(/^<|>$/g, "");
  return inner.replace(/_\d+$/, "");
}

function isOneWayPlaceholder(placeholder) {
  if (ONE_WAY_TOKENS[tokenOf(placeholder)]) {
    return true;
  }
  var never = BrowserAgent.redaction && BrowserAgent.redaction.NEVER_REVEAL;
  var tokens = BrowserAgent.redaction && BrowserAgent.redaction.TOKENS;
  if (!never) {
    return false;
  }
  var token = tokenOf(placeholder);
  for (var category in never) {
    if (!Object.prototype.hasOwnProperty.call(never, category) || !never[category]) {
      continue;
    }
    var mapped = tokens && tokens[category]
      ? tokens[category]
      : String(category).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    if (mapped === token) {
      return true;
    }
  }
  return false;
}

function incomingContainsVaultValue(text, vault) {
  var values = Object.keys(vault || {})
    .map(function (placeholder) {
      return vault[placeholder];
    })
    .filter(function (value) {
      return value && String(value).length >= 4;
    })
    .sort(function (a, b) {
      return b.length - a.length;
    });
  return values.some(function (value) {
    return text.indexOf(value) !== -1;
  });
}

function profileHelpers() {
  return BrowserAgent.profileVault || null;
}

function expandText(text, vault, profileMap) {
  var placeholders = BrowserAgent.agent
    ? BrowserAgent.agent.placeholdersIn(text)
    : [];
  var unknown = [];
  var oneWay = [];
  var missingProfile = [];
  var combined = Object.assign({}, vault || {}, profileMap || {});
  placeholders.forEach(function (placeholder) {
    if (isOneWayPlaceholder(placeholder)) {
      oneWay.push(placeholder);
      return;
    }
    var profile = profileHelpers();
    if (profile && profile.isProfilePlaceholder(placeholder)) {
      if (!profileMap || !Object.prototype.hasOwnProperty.call(profileMap, placeholder)) {
        missingProfile.push(placeholder);
      }
      return;
    }
    if (!vault || !Object.prototype.hasOwnProperty.call(vault, placeholder)) {
      unknown.push(placeholder);
    }
  });
  if (oneWay.length) {
    return { ok: false, error: "Refusing to fill a credential placeholder: " + oneWay.join(", ") + "." };
  }
  if (unknown.length) {
    return { ok: false, error: "Unknown placeholder for this page: " + unknown.join(", ") + "." };
  }
  if (missingProfile.length) {
    return {
      ok: true,
      skip: true,
      reason: "Local profile has no value for " + missingProfile.join(", ") + "."
    };
  }
  if (incomingContainsVaultValue(text, combined)) {
    return { ok: false, error: "Refusing to apply: the instruction already contains a vault value." };
  }
  var expanded = text;
  placeholders.forEach(function (placeholder) {
    expanded = expanded.split(placeholder).join(combined[placeholder]);
  });
  return { ok: true, text: expanded, placeholders: placeholders };
}

function skipFill(action, reason) {
  return {
    ok: true,
    skipped: true,
    type: action.type,
    elementId: action.elementId,
    reason: reason
  };
}

function profileTokensIn(text) {
  var profile = profileHelpers();
  var placeholders = BrowserAgent.agent ? BrowserAgent.agent.placeholdersIn(text) : [];
  return placeholders.filter(function (placeholder) {
    return profile ? profile.isProfilePlaceholder(placeholder) : /^<PROFILE_/.test(placeholder);
  });
}

function snapshotElementFor(elementId, elements) {
  var list = elements || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === elementId) {
      return list[i];
    }
  }
  return null;
}

function refuseMismatchedProfileTokens(action, options) {
  var profile = profileHelpers();
  var profileMap = options && options.profileMap ? options.profileMap : {};
  var snapshotElement = snapshotElementFor(action.elementId, options && options.elements);
  var tokens = profileTokensIn(action.text);
  for (var t = 0; t < tokens.length; t++) {
    var category = profile ? profile.categoryFromPlaceholder(tokens[t]) : null;
    if (category && profile && !profile.fieldAcceptsCategory(snapshotElement || {}, category)) {
      var pinOk =
        category === "security_pin" &&
        BrowserAgent.agent &&
        BrowserAgent.agent.authGateKind &&
        BrowserAgent.agent.authGateKind(
          snapshotElement || {},
          pageHayFromElements(options && options.elements)
        ) === "pin";
      if (!pinOk) {
        return skipFill(action, tokens[t] + " does not match this field's purpose; left empty.");
      }
    }
    if (category && profile && profile.isHighRisk(category) && category !== "security_pin" && !(options && options.allowHighRisk)) {
      return skipFill(action, "High-risk profile fill for " + category + " was not allowed.");
    }
  }
  var expanded = expandText(action.text, options && options.vault, profileMap);
  if (!expanded.ok) {
    return expanded;
  }
  if (expanded.skip) {
    return skipFill(action, expanded.reason);
  }
  return expanded;
}

function optionMatchesWanted(option, wanted) {
  var text = String(option.text || "");
  var value = String(option.value || "");
  if (text === wanted || value === wanted) {
    return true;
  }
  var lower = String(wanted || "").toLowerCase();
  if (!lower) {
    return false;
  }
  return wordPrefixed(text.toLowerCase(), lower) || wordPrefixed(value.toLowerCase(), lower);
}

function wordPrefixed(hay, needle) {
  var index = hay.indexOf(needle);
  if (index < 0) {
    return false;
  }
  if (index > 0 && /[a-z0-9]/.test(hay.charAt(index - 1))) {
    return false;
  }
  var after = index + needle.length;
  if (after < hay.length && /[a-z0-9]/.test(hay.charAt(after))) {
    return false;
  }
  return true;
}

function setNativeValue(node, value) {
  if (node.isContentEditable) {
    if (typeof node.focus === "function") {
      try {
        node.focus();
      } catch (error) {
        // ignore
      }
    }
    var inserted = false;
    try {
      if (document.execCommand && window.getSelection) {
        var range = document.createRange();
        range.selectNodeContents(node);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        inserted = document.execCommand("insertText", false, value);
      }
    } catch (error) {
      inserted = false;
    }
    if (!inserted) {
      node.textContent = value;
    }
    return;
  }
  var tag = node.tagName.toLowerCase();
  var proto =
    tag === "textarea"
      ? window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement && window.HTMLInputElement.prototype;
  var descriptor = proto && Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor && descriptor.set) {
    descriptor.set.call(node, value);
  } else {
    node.value = value;
  }
}

function dispatchEdit(node, data) {
  var digit = data == null ? "" : String(data);
  try {
    if (typeof InputEvent === "function") {
      node.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          data: digit,
          inputType: "insertText"
        })
      );
    } else {
      node.dispatchEvent(new Event("input", { bubbles: true }));
    }
  } catch (error) {
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }
  node.dispatchEvent(new Event("change", { bubbles: true }));
  if (digit) {
    try {
      node.dispatchEvent(
        new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: digit })
      );
    } catch (error) {
      // jsdom may not implement KeyboardEvent the same way.
    }
  }
}

function isDisabled(node) {
  return Boolean(
    node.disabled ||
      node.getAttribute("aria-disabled") === "true" ||
      (node.closest && node.closest("fieldset[disabled]"))
  );
}

function isOtpOrCvvControl(node) {
  var autocomplete = String(node.getAttribute("autocomplete") || "").toLowerCase();
  var purpose = [
    autocomplete,
    node.getAttribute("name"),
    node.getAttribute("id"),
    node.getAttribute("aria-label"),
    node.getAttribute("placeholder")
  ]
    .filter(Boolean)
    .join(" ");
  return (
    autocomplete === "cc-csc" ||
    autocomplete === "one-time-code" ||
    /\b(?:otp|one.?time|verification.?code|cvv|cvc|security.?code)\b/i.test(purpose)
  );
}

function pageHayFromElements(elements) {
  return (elements || [])
    .map(function (element) {
      return element && element.text;
    })
    .filter(Boolean)
    .join(" ");
}

function isSecurityPinControl(node, snapshotElement, elements) {
  var cats = (snapshotElement && snapshotElement.sensitivityCategories) || [];
  if (cats.indexOf("security_pin") !== -1) {
    return true;
  }
  if (cats.indexOf("otp") !== -1 || cats.indexOf("cvv") !== -1) {
    var agent = BrowserAgent.agent;
    if (
      !(
        agent &&
        agent.authGateKind &&
        snapshotElement &&
        agent.authGateKind(snapshotElement, pageHayFromElements(elements)) === "pin"
      )
    ) {
      return false;
    }
  }
  var purpose = [
    snapshotElement && snapshotElement.text,
    snapshotElement && snapshotElement.name,
    snapshotElement && snapshotElement.htmlId,
    snapshotElement && snapshotElement.ariaLabel,
    snapshotElement && snapshotElement.placeholder,
    node.getAttribute("name"),
    node.getAttribute("id"),
    node.getAttribute("aria-label"),
    node.getAttribute("placeholder")
  ]
    .filter(Boolean)
    .join(" ");
  if (
    /security\s*pin/i.test(purpose) ||
    /6[\s-]?digit\s+(?:security\s+)?pin/i.test(purpose) ||
    /\b(?:m[\s-]?pin|mpin)\b/i.test(purpose)
  ) {
    return true;
  }
  if (BrowserAgent.agent && BrowserAgent.agent.authGateKind && snapshotElement) {
    return BrowserAgent.agent.authGateKind(snapshotElement, pageHayFromElements(elements)) === "pin";
  }
  return false;
}

function isCredentialControl(node, snapshotElement, elements) {
  if (isSecurityPinControl(node, snapshotElement, elements)) {
    return false;
  }
  if (isOtpOrCvvControl(node)) {
    return true;
  }
  var type = String(node.type || "").toLowerCase();
  if (type === "password") {
    return true;
  }
  var autocomplete = String(node.getAttribute("autocomplete") || "").toLowerCase();
  var purpose = [
    autocomplete,
    node.getAttribute("name"),
    node.getAttribute("id"),
    node.getAttribute("aria-label"),
    node.getAttribute("placeholder")
  ]
    .filter(Boolean)
    .join(" ");
  return (
    autocomplete === "current-password" ||
    autocomplete === "new-password" ||
    /\b(?:password|passcode)\b/i.test(purpose)
  );
}

function digitBoxesIn(scope, node) {
  if (!scope || !scope.querySelectorAll) {
    return [];
  }
  var inputs = scope.querySelectorAll("input");
  var boxes = [];
  var i;
  var el;
  var max;
  var type;
  var mode;
  for (i = 0; i < inputs.length; i++) {
    el = inputs[i];
    type = String(el.type || "").toLowerCase();
    max = Number(el.getAttribute("maxlength") || 0);
    mode = String(el.getAttribute("inputmode") || "").toLowerCase();
    if (
      (type === "password" || type === "tel" || type === "text" || type === "number") &&
      (max === 1 ||
        mode === "numeric" ||
        mode === "tel" ||
        (max === 0 && inputs.length >= 4 && inputs.length <= 8))
    ) {
      boxes.push(el);
    }
  }
  if (boxes.length >= 4 && boxes.length <= 8 && boxes.indexOf(node) !== -1) {
    return boxes;
  }
  return [];
}

function siblingPinBoxes(node) {
  var current = node;
  var hops = 0;
  var boxes;
  while (current && hops < 6) {
    boxes = digitBoxesIn(current.parentElement || current, node);
    if (boxes.length) {
      return boxes;
    }
    current = current.parentElement;
    hops += 1;
  }
  return [node];
}

function applySecurityPinValue(node, value) {
  var digits = String(value || "").replace(/\D/g, "");
  var boxes = siblingPinBoxes(node);
  if (boxes.length > 1 && digits.length >= boxes.length) {
    boxes.forEach(function (box, index) {
      var digit = digits.charAt(index);
      if (typeof box.focus === "function") {
        try {
          box.focus();
        } catch (error) {
          // ignore
        }
      }
      setNativeValue(box, digit);
      dispatchEdit(box, digit);
    });
    return;
  }
  setNativeValue(node, value);
  dispatchEdit(node, digits);
}

function clickTarget(node) {
  var current = node;
  while (current && current !== document.documentElement) {
    var role = String((current.getAttribute && current.getAttribute("role")) || "").toLowerCase();
    var tag = String(current.tagName || "").toLowerCase();
    if (
      tag === "button" ||
      tag === "a" ||
      tag === "summary" ||
      role === "button" ||
      role === "link" ||
      role === "listitem" ||
      role === "row" ||
      role === "option" ||
      role === "menuitem" ||
      role === "tab"
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return node;
}

function namedChildForClick(node, goal) {
  var name =
    BrowserAgent.agent && BrowserAgent.agent.goalContactName
      ? BrowserAgent.agent.goalContactName(goal)
      : "";
  if (!name || !node || !node.querySelectorAll) {
    return null;
  }
  var nodes = node.querySelectorAll("span, div, p");
  var i;
  var text;
  for (i = 0; i < nodes.length; i++) {
    text = String(nodes[i].textContent || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 48) {
      continue;
    }
    if (/\breacted\b/i.test(text)) {
      continue;
    }
    if (text.toLowerCase() === name || text.toLowerCase().indexOf(name + " ") === 0) {
      return nodes[i];
    }
  }
  return null;
}

function activateNode(node) {
  if (!node) {
    return;
  }
  var opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
  try {
    if (typeof PointerEvent === "function") {
      node.dispatchEvent(new PointerEvent("pointerdown", Object.assign({ pointerType: "mouse" }, opts)));
    }
  } catch (error) {}
  node.dispatchEvent(new MouseEvent("mousedown", opts));
  try {
    if (typeof PointerEvent === "function") {
      node.dispatchEvent(new PointerEvent("pointerup", Object.assign({ pointerType: "mouse" }, opts)));
    }
  } catch (error) {}
  node.dispatchEvent(new MouseEvent("mouseup", opts));
  node.click();
}

function applyClick(action, options) {
  var found = requireNode(action.elementId, options);
  if (!found.ok) {
    return found;
  }
  var node = clickTarget(found.node);
  if (typeof node.scrollIntoView === "function") {
    try {
      node.scrollIntoView({ block: "center", inline: "nearest" });
    } catch (error) {
      // jsdom and some embedded views do not implement this.
    }
  }
  var named = namedChildForClick(node, options && options.goal);
  activateNode(named || node);
  if (named && named !== node) {
    activateNode(node);
  }
  return { ok: true, type: "click", elementId: action.elementId };
}

function applyFill(action, vault, options) {
  var found = requireNode(action.elementId, options);
  if (!found.ok) {
    return found;
  }
  var node = found.node;
  var tag = node.tagName.toLowerCase();
  if (tag !== "input" && tag !== "textarea" && !node.isContentEditable) {
    return { ok: false, error: "Element " + action.elementId + " does not accept text." };
  }
  if (isCredentialControl(node, snapshotElementFor(action.elementId, options && options.elements), options && options.elements)) {
    return { ok: false, error: "Refusing to fill a password, OTP, or CVV field." };
  }
  var placeholders = BrowserAgent.agent ? BrowserAgent.agent.placeholdersIn(action.text) : [];
  var grounded =
    placeholders.length > 0 ||
    (BrowserAgent.agent &&
      BrowserAgent.agent.textIsGrounded &&
      BrowserAgent.agent.textIsGrounded("fill", action.text, options && options.goal));
  if (!grounded) {
    return skipFill(action, "Refusing to invent a value that is not a profile token or text from your goal.");
  }
  var expanded = refuseMismatchedProfileTokens(action, Object.assign({}, options || {}, { vault: vault }));
  if (!expanded.ok) {
    return expanded;
  }
  if (expanded.skipped) {
    return expanded;
  }
  var snapshotElement = snapshotElementFor(action.elementId, options && options.elements);
  if (isSecurityPinControl(node, snapshotElement, options && options.elements)) {
    applySecurityPinValue(node, expanded.text);
  } else {
    setNativeValue(node, expanded.text);
    dispatchEdit(node, expanded.text);
  }
  return {
    ok: true,
    type: "fill",
    elementId: action.elementId,
    placeholders: expanded.placeholders
  };
}

function applySelect(action, vault, options) {
  var found = requireNode(action.elementId, options);
  if (!found.ok) {
    return found;
  }
  var node = found.node;
  if (node.tagName.toLowerCase() !== "select") {
    return { ok: false, error: "Element " + action.elementId + " is not a select." };
  }
  var expanded = refuseMismatchedProfileTokens(action, Object.assign({}, options || {}, { vault: vault }));
  if (!expanded.ok) {
    return expanded;
  }
  if (expanded.skipped) {
    return expanded;
  }
  var wanted = expanded.text;
  var selectOptions = node.options || [];
  var index = -1;
  for (var i = 0; i < selectOptions.length; i++) {
    if (optionMatchesWanted(selectOptions[i], wanted)) {
      index = i;
      break;
    }
  }
  if (index < 0) {
    return { ok: false, error: "No matching option for " + action.elementId + "." };
  }
  node.selectedIndex = index;
  dispatchEdit(node);
  return {
    ok: true,
    type: "select",
    elementId: action.elementId,
    placeholders: expanded.placeholders
  };
}

function applyCheck(action, checked, options) {
  var found = requireNode(action.elementId, options);
  if (!found.ok) {
    return found;
  }
  var node = found.node;
  var type = String(node.type || "").toLowerCase();
  if (node.tagName.toLowerCase() !== "input" || (type !== "checkbox" && type !== "radio")) {
    return { ok: false, error: "Element " + action.elementId + " is not a checkbox or radio." };
  }
  node.checked = Boolean(checked);
  dispatchEdit(node);
  return {
    ok: true,
    type: checked ? "check" : "uncheck",
    elementId: action.elementId
  };
}

function applyPress(action, options) {
  var found = requireNode(action.elementId, options);
  if (!found.ok) {
    return found;
  }
  var spec = PRESS_KEYS[action.key];
  if (!spec) {
    return { ok: false, error: "Unsupported key." };
  }
  var node = found.node;
  if (typeof node.focus === "function") {
    try {
      node.focus();
    } catch (error) {
      // ignore
    }
  }
  var init = {
    bubbles: true,
    cancelable: true,
    key: spec.key,
    code: spec.code,
    keyCode: spec.keyCode,
    which: spec.keyCode
  };
  node.dispatchEvent(new KeyboardEvent("keydown", init));
  node.dispatchEvent(new KeyboardEvent("keyup", init));
  if (action.key === "Enter" && (node.tagName.toLowerCase() === "button" || node.type === "submit")) {
    node.click();
  }
  return { ok: true, type: "press", elementId: action.elementId, key: action.key };
}

function applyScroll(action) {
  var x = Number(action.x || 0);
  var y = Number(action.y || 0);
  if (!isFinite(x) || !isFinite(y) || Math.abs(x) > 1600 || Math.abs(y) > 1600) {
    return { ok: false, error: "Scroll distance is invalid." };
  }
  window.scrollBy({ left: Math.round(x), top: Math.round(y), behavior: "auto" });
  return { ok: true, type: "scroll", x: Math.round(x), y: Math.round(y) };
}

function applyAction(action, vault, options) {
  if (!action || !action.type) {
    return { ok: false, error: "Missing action type." };
  }
  var opts = Object.assign({ vault: vault }, options || {});
  if (action.type === "click") {
    return applyClick(action, opts);
  }
  if (action.type === "fill") {
    return applyFill(action, vault, opts);
  }
  if (action.type === "select") {
    return applySelect(action, vault, opts);
  }
  if (action.type === "check") {
    return applyCheck(action, true, opts);
  }
  if (action.type === "uncheck") {
    return applyCheck(action, false, opts);
  }
  if (action.type === "press") {
    return applyPress(action, opts);
  }
  if (action.type === "scroll") {
    return applyScroll(action);
  }
  if (action.type === "done") {
    return { ok: true, type: "done", reason: action.reason || "" };
  }
  return { ok: false, error: "Unknown action type: " + action.type + "." };
}

function collectInputs(root, out) {
  out = out || [];
  if (!root || !root.querySelectorAll) {
    return out;
  }
  var list = root.querySelectorAll("input");
  var i;
  for (i = 0; i < list.length; i++) {
    out.push(list[i]);
  }
  var all = root.querySelectorAll("*");
  for (i = 0; i < all.length; i++) {
    if (all[i].shadowRoot) {
      collectInputs(all[i].shadowRoot, out);
    }
  }
  return out;
}

function pageLooksLikeSecurityPin() {
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

function isLiveDigitBox(el) {
  if (!el || String(el.tagName || "").toLowerCase() !== "input") {
    return false;
  }
  if (el.disabled || el.readOnly) {
    return false;
  }
  var type = String(el.type || "").toLowerCase();
  if (type === "hidden" || type === "checkbox" || type === "radio" || type === "submit" || type === "button" || type === "email" || type === "search") {
    return false;
  }
  var max = Number(el.getAttribute("maxlength") || 0);
  var mode = String(el.getAttribute("inputmode") || "").toLowerCase();
  var auto = String(el.getAttribute("autocomplete") || "").toLowerCase();
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

function findLiveSecurityPinBoxes() {
  if (!pageLooksLikeSecurityPin()) {
    return [];
  }
  var inputs = collectInputs(document, []);
  var boxes = [];
  var i;
  for (i = 0; i < inputs.length; i++) {
    if (isLiveDigitBox(inputs[i])) {
      boxes.push(inputs[i]);
    }
  }
  if (boxes.length >= 4 && boxes.length <= 8) {
    return boxes;
  }
  if (boxes.length === 1) {
    return boxes;
  }
  return [];
}

function fillSavedSecurityPin(profileMap) {
  var value =
    (profileMap && profileMap["<PROFILE_SECURITY_PIN>"]) ||
    (profileMap && profileMap["<PROFILE_PIN>"]);
  var digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 4) {
    return { ok: false, filled: false, reason: "no-pin" };
  }
  var boxes = findLiveSecurityPinBoxes();
  if (!boxes.length) {
    return { ok: false, filled: false, reason: "no-boxes" };
  }
  if (boxes.length === 1) {
    applySecurityPinValue(boxes[0], digits);
    return { ok: true, filled: true, boxes: 1 };
  }
  applySecurityPinValue(boxes[0], digits);
  return { ok: true, filled: true, boxes: boxes.length };
}

function applyActions(actions, vault, options) {
  var results = [];
  for (var i = 0; i < (actions || []).length; i++) {
    var result = applyAction(actions[i], vault, options);
    results.push(result);
    if (!result.ok) {
      break;
    }
  }
  return {
    ok: results.length > 0 && results.every(function (item) {
      return item.ok;
    }),
    results: results
  };
}

BrowserAgent.agentApply = {
  expandText: expandText,
  applyAction: applyAction,
  applyActions: applyActions,
  fillSavedSecurityPin: fillSavedSecurityPin,
  findLiveSecurityPinBoxes: findLiveSecurityPinBoxes
};

globalThis.BrowserAgent = BrowserAgent;
