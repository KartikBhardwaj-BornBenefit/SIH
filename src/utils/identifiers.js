/**
 * Identifiers the extension can later use to refer back to a DOM node.
 *
 * We write data-browser-agent-id onto the live element. That is a local DOM
 * mutation so a future agent can query the node again. Nothing is uploaded.
 */
var BrowserAgent = globalThis.BrowserAgent || {};

var ID_ATTRIBUTE = "data-browser-agent-id";
var ID_PREFIX = "element_";

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function nextNumericId() {
  var max = 0;
  var nodes = document.querySelectorAll("[" + ID_ATTRIBUTE + "]");
  for (var i = 0; i < nodes.length; i++) {
    var value = nodes[i].getAttribute(ID_ATTRIBUTE) || "";
    var match = /^element_(\d+)$/.exec(value);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return ID_PREFIX + (max + 1);
}

function getOrCreateId(element) {
  var existing = element.getAttribute(ID_ATTRIBUTE);
  if (existing) {
    return existing;
  }
  var id = nextNumericId();
  element.setAttribute(ID_ATTRIBUTE, id);
  return id;
}

function selectorHint(element, agentId) {
  var htmlId = element.getAttribute("id");
  if (htmlId && document.getElementById(htmlId) === element) {
    return "#" + cssEscape(htmlId);
  }
  return "[" + ID_ATTRIBUTE + "=\"" + cssEscape(agentId) + "\"]";
}

BrowserAgent.identifiers = {
  ID_ATTRIBUTE: ID_ATTRIBUTE,
  getOrCreateId: getOrCreateId,
  selectorHint: selectorHint
};

globalThis.BrowserAgent = BrowserAgent;
