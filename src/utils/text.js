/**
 * Small text helpers for compact, readable snapshots.
 */
var BrowserAgent = globalThis.BrowserAgent || {};

var MAX_TEXT_LENGTH = 280;

function normalizeText(value) {
  if (value == null) {
    return "";
  }
  return String(value).replace(/\s+/g, " ").trim();
}

function truncateText(value, maxLength) {
  var text = normalizeText(value);
  var limit = maxLength || MAX_TEXT_LENGTH;
  if (text.length <= limit) {
    return text;
  }
  return text.slice(0, limit - 1) + "…";
}

function compactRecord(record) {
  var out = {};
  Object.keys(record).forEach(function (key) {
    var value = record[key];
    if (value === undefined || value === null || value === "") {
      return;
    }
    if (Array.isArray(value) && value.length === 0) {
      return;
    }
    out[key] = value;
  });
  return out;
}

BrowserAgent.text = {
  MAX_TEXT_LENGTH: MAX_TEXT_LENGTH,
  normalizeText: normalizeText,
  truncateText: truncateText,
  compactRecord: compactRecord
};

globalThis.BrowserAgent = BrowserAgent;
