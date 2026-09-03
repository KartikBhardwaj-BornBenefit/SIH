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

function expandText(text, vault) {
  var placeholders = BrowserAgent.agent
    ? BrowserAgent.agent.placeholdersIn(text)
    : [];
  var unknown = [];
  var oneWay = [];
  placeholders.forEach(function (placeholder) {
    if (isOneWayPlaceholder(placeholder)) {
      oneWay.push(placeholder);
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
  if (incomingContainsVaultValue(text, vault)) {
    return { ok: false, error: "Refusing to apply: the instruction already contains a vault value." };
  }
  var expanded = text;
  placeholders.forEach(function (placeholder) {
    expanded = expanded.split(placeholder).join(vault[placeholder]);
  });
  return { ok: true, text: expanded, placeholders: placeholders };
}

function setNativeValue(node, value) {
  if (node.isContentEditable) {
    node.textContent = value;
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

function dispatchEdit(node) {
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
}

function isDisabled(node) {
  return Boolean(
    node.disabled ||
      node.getAttribute("aria-disabled") === "true" ||
      (node.closest && node.closest("fieldset[disabled]"))
  );
}

function isCredentialControl(node) {
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
  ].filter(Boolean).join(" ");
  return (
    autocomplete === "cc-csc" ||
    autocomplete === "one-time-code" ||
    autocomplete === "current-password" ||
    autocomplete === "new-password" ||
    /\b(?:password|passcode|otp|one.?time|verification.?code|cvv|cvc|security.?code)\b/i.test(purpose)
  );
}

function requireNode(agentId) {
  var node = findNode(agentId);
  if (!node) {
    return { ok: false, error: "No element with id " + agentId + "." };
  }
  if (isDisabled(node)) {
    return { ok: false, error: "Element " + agentId + " is disabled." };
  }
  return { ok: true, node: node };
}

function applyClick(action) {
  var found = requireNode(action.elementId);
  if (!found.ok) {
    return found;
  }
  if (typeof found.node.scrollIntoView === "function") {
    try {
      found.node.scrollIntoView({ block: "center", inline: "nearest" });
    } catch (error) {
      // jsdom and some embedded views do not implement this.
    }
  }
  found.node.click();
  return { ok: true, type: "click", elementId: action.elementId };
}

function applyFill(action, vault) {
  var found = requireNode(action.elementId);
  if (!found.ok) {
    return found;
  }
  var node = found.node;
  var tag = node.tagName.toLowerCase();
  if (tag !== "input" && tag !== "textarea" && !node.isContentEditable) {
    return { ok: false, error: "Element " + action.elementId + " does not accept text." };
  }
  if (isCredentialControl(node)) {
    return { ok: false, error: "Refusing to fill a password, OTP, or CVV field." };
  }
  var expanded = expandText(action.text, vault);
  if (!expanded.ok) {
    return expanded;
  }
  setNativeValue(node, expanded.text);
  dispatchEdit(node);
  return {
    ok: true,
    type: "fill",
    elementId: action.elementId,
    placeholders: expanded.placeholders
  };
}

function applySelect(action, vault) {
  var found = requireNode(action.elementId);
  if (!found.ok) {
    return found;
  }
  var node = found.node;
  if (node.tagName.toLowerCase() !== "select") {
    return { ok: false, error: "Element " + action.elementId + " is not a select." };
  }
  var expanded = expandText(action.text, vault);
  if (!expanded.ok) {
    return expanded;
  }
  var wanted = expanded.text;
  var options = node.options || [];
  var index = -1;
  for (var i = 0; i < options.length; i++) {
    if (options[i].text === wanted || options[i].value === wanted) {
      index = i;
      break;
    }
  }
  if (index < 0) {
    var lower = wanted.toLowerCase();
    for (var j = 0; j < options.length; j++) {
      if (options[j].text.toLowerCase() === lower || String(options[j].value).toLowerCase() === lower) {
        index = j;
        break;
      }
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

function applyCheck(action, checked) {
  var found = requireNode(action.elementId);
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

function applyPress(action) {
  var found = requireNode(action.elementId);
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

function applyAction(action, vault) {
  if (!action || !action.type) {
    return { ok: false, error: "Missing action type." };
  }
  if (action.type === "click") {
    return applyClick(action);
  }
  if (action.type === "fill") {
    return applyFill(action, vault);
  }
  if (action.type === "select") {
    return applySelect(action, vault);
  }
  if (action.type === "check") {
    return applyCheck(action, true);
  }
  if (action.type === "uncheck") {
    return applyCheck(action, false);
  }
  if (action.type === "press") {
    return applyPress(action);
  }
  if (action.type === "scroll") {
    return applyScroll(action);
  }
  if (action.type === "done") {
    return { ok: true, type: "done", reason: action.reason || "" };
  }
  return { ok: false, error: "Unknown action type: " + action.type + "." };
}

function applyActions(actions, vault) {
  var results = [];
  for (var i = 0; i < (actions || []).length; i++) {
    var result = applyAction(actions[i], vault);
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
  applyActions: applyActions
};

globalThis.BrowserAgent = BrowserAgent;
