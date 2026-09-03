/**
 * Safe snapshot construction.
 *
 * Detection is not redaction. Up to now the extractor found identifiers and
 * then serialised them anyway: an element's `text`, `placeholder`, `alt`,
 * `href`, and select `options` all carry whatever the page rendered. This
 * module turns one snapshot into two objects:
 *
 *   agentContext — the snapshot with every detected value replaced by a typed
 *                  placeholder. This is the only object that may be
 *                  serialised, copied, displayed, or sent anywhere.
 *   vault        — placeholder to original value. Session only. Never written
 *                  to chrome.storage, never logged, never serialised.
 *
 * Everything here runs in the content script's isolated world, so the raw
 * snapshot never crosses a message boundary.
 *
 * Two deliberate limits:
 *
 * - Redaction is scoped to what detection found. An identifier the validators
 *   cannot recognise — a person's name, a Hindi-labelled field, a bank
 *   account number with no check digit — is *not* redacted. The metrics in
 *   eval/ are therefore also a direct measure of what leaks.
 * - Credentials are one-way. A password, CVV, or OTP gets a placeholder so an
 *   agent knows the field is occupied, but no vault entry: reading one back is
 *   never a legitimate operation, so the capability simply does not exist.
 */
var BrowserAgent = globalThis.BrowserAgent || {};

/** Shorter, more readable tokens where the category id is clumsy. */
var TOKENS = {
  payment_card: "CARD",
  bank_account: "BANK",
  person_name: "NAME",
  image_embedded_text: "IMAGE_TEXT"
};

/** Categories that get a placeholder but never a vault entry. */
var NEVER_REVEAL = {
  password: true,
  cvv: true,
  otp: true
};

/** Snapshot string fields that can carry a rendered value. */
var TEXT_FIELDS = ["text", "ariaLabel", "placeholder", "alt", "href", "src"];

function tokenFor(category) {
  if (TOKENS[category]) {
    return TOKENS[category];
  }
  return String(category).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function createMinter() {
  var counters = {};
  var byValue = {};
  var vault = {};
  var records = [];

  return {
    vault: vault,
    records: records,

    /**
     * The same value always gets the same placeholder, so an email appearing
     * in a heading and again in a link is recognisably one entity rather than
     * two unrelated redactions.
     */
    mint: function (category, value, context) {
      var token = tokenFor(category);
      var key = category + "\u0000" + value;

      if (value && byValue[key]) {
        records.push({
          placeholder: byValue[key],
          category: category,
          confidence: context.confidence,
          elementId: context.elementId,
          field: context.field,
          reused: true
        });
        return byValue[key];
      }

      counters[token] = (counters[token] || 0) + 1;
      var placeholder = "<" + token + "_" + counters[token] + ">";

      if (value) {
        byValue[key] = placeholder;
      }
      if (value && !NEVER_REVEAL[category]) {
        vault[placeholder] = value;
      }

      records.push({
        placeholder: placeholder,
        category: category,
        confidence: context.confidence,
        elementId: context.elementId,
        field: context.field,
        oneWay: Boolean(NEVER_REVEAL[category])
      });

      return placeholder;
    }
  };
}

/**
 * Replace every detected value in one string.
 *
 * Matches are applied right to left so that rewriting a later span cannot
 * shift the offsets of an earlier one.
 */
function redactString(value, policy, minter, context) {
  if (!value || typeof value !== "string") {
    return value;
  }
  var validators = BrowserAgent.validators;
  if (!validators) {
    return value;
  }

  var hits = validators.findValues(value, policy, {
    corroborationText: context.corroborationText,
    admitShapes: context.admitShapes
  });
  if (!hits.length) {
    return value;
  }

  var out = value;
  for (var i = hits.length - 1; i >= 0; i--) {
    var hit = hits[i];
    var raw = value.slice(hit.start, hit.start + hit.length);
    var placeholder = minter.mint(hit.category, raw, {
      confidence: hit.confidence,
      elementId: context.elementId,
      field: context.field
    });
    out = out.slice(0, hit.start) + placeholder + out.slice(hit.start + hit.length);
  }
  return out;
}

/** Categories already detected on an element, used to locate weak shapes. */
function detectedCategories(element) {
  var out = [];
  (element.sensitivitySignals || []).forEach(function (signal) {
    if (out.indexOf(signal.category) === -1) {
      out.push(signal.category);
    }
  });
  return out;
}

/**
 * The category to use for a filled control's placeholder. A value-level match
 * is more specific than the field's declared purpose, so it wins.
 */
function controlCategory(element) {
  var signals = element.sensitivitySignals || [];
  for (var i = 0; i < signals.length; i++) {
    if (signals[i].via === "control-value") {
      return signals[i];
    }
  }
  for (var j = 0; j < signals.length; j++) {
    if (signals[j].via === "field-purpose") {
      return signals[j];
    }
  }
  return null;
}

function findNode(agentId) {
  try {
    return document.querySelector('[data-browser-agent-id="' + agentId + '"]');
  } catch (error) {
    return null;
  }
}

/**
 * @returns {{agentContext: object, vault: object, redaction: object}}
 */
function build(snapshot, policy) {
  var normalized = BrowserAgent.normalizeSensitivityPolicy
    ? BrowserAgent.normalizeSensitivityPolicy(policy)
    : policy || {};

  // Deep copy so the redacted object shares no structure with the original.
  var agentContext = JSON.parse(JSON.stringify(snapshot));
  var minter = createMinter();

  if (agentContext.page) {
    // A URL or a document title can carry an address or a phone number in a
    // query string, so neither is exempt.
    agentContext.page.title = redactString(agentContext.page.title, normalized, minter, {
      elementId: null,
      field: "page.title"
    });
    agentContext.page.url = redactString(agentContext.page.url, normalized, minter, {
      elementId: null,
      field: "page.url"
    });
  }

  (agentContext.elements || []).forEach(function (element) {
    var admitShapes = detectedCategories(element);

    // Corroboration draws on the whole element, not just its attributes.
    // A form control's `text` is its *label*, so "Voter ID ABC1234567" as a
    // label puts the identifier into the input's record even though the input
    // itself has no text of its own. Without the label as corroboration, that
    // copy of a weak-shape value would survive redaction.
    var corroborationText = TEXT_FIELDS.map(function (field) {
      return typeof element[field] === "string" ? element[field] : "";
    })
      .concat([element.name, element.htmlId, (element.options || []).join(" ")])
      .filter(Boolean)
      .join(" ");

    TEXT_FIELDS.forEach(function (field) {
      if (typeof element[field] !== "string") {
        return;
      }
      element[field] = redactString(element[field], normalized, minter, {
        elementId: element.id,
        field: field,
        admitShapes: admitShapes,
        corroborationText: corroborationText
      });
    });

    if (Array.isArray(element.options)) {
      element.options = element.options.map(function (option) {
        if (typeof option !== "string") {
          return option;
        }
        return redactString(option, normalized, minter, {
          elementId: element.id,
          field: "options",
          admitShapes: admitShapes,
          corroborationText: corroborationText
        });
      });
    }

    // A filled sensitive control never had its value in the snapshot, but the
    // agent still needs to know one is there and to be able to refer to it.
    if (element.hasUserValue) {
      var signal = controlCategory(element);
      if (signal) {
        var oneWay = Boolean(NEVER_REVEAL[signal.category]);
        var node = oneWay ? null : findNode(element.id);
        var raw = node && BrowserAgent.sensitivity.readControlValue
          ? BrowserAgent.sensitivity.readControlValue(node)
          : "";
        element.valuePlaceholder = minter.mint(signal.category, raw, {
          confidence: signal.confidence,
          elementId: element.id,
          field: "value"
        });
      }
    }
  });

  var categories = {};
  var elementIds = {};
  minter.records.forEach(function (record) {
    categories[record.category] = (categories[record.category] || 0) + 1;
    if (record.elementId) {
      elementIds[record.elementId] = true;
    }
  });

  var redaction = {
    records: minter.records,
    counts: {
      placeholders: Object.keys(minter.vault).length + minter.records.filter(function (r) {
        return r.oneWay;
      }).length,
      replacements: minter.records.length,
      elements: Object.keys(elementIds).length,
      recoverable: Object.keys(minter.vault).length,
      categories: categories
    },
    elementIds: Object.keys(elementIds)
  };

  agentContext.redacted = true;
  agentContext.redactionCounts = redaction.counts;

  return { agentContext: agentContext, vault: minter.vault, redaction: redaction };
}

/**
 * Write a vaulted value back into the page.
 *
 * This is the de-referencing half of the contract: a future agent phase says
 * "put <EMAIL_1> into element_4" and the substitution happens here, in the
 * isolated world, without the value ever being handed back out.
 *
 * The API can only write values already in this page's vault. It cannot be
 * used to inject arbitrary text, and it cannot reach a one-way placeholder,
 * so a password cannot be restored through it either.
 */
function fillFromVault(vault, agentId, placeholder) {
  if (!vault || !Object.prototype.hasOwnProperty.call(vault, placeholder)) {
    return { ok: false, error: "Unknown placeholder for this page." };
  }
  var node = findNode(agentId);
  if (!node) {
    return { ok: false, error: "No element with id " + agentId + "." };
  }

  var tag = node.tagName.toLowerCase();
  if (tag !== "input" && tag !== "textarea" && !node.isContentEditable) {
    return { ok: false, error: "Element " + agentId + " does not accept text." };
  }

  if (node.isContentEditable) {
    node.textContent = vault[placeholder];
  } else {
    node.value = vault[placeholder];
  }
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));

  return { ok: true, elementId: agentId, placeholder: placeholder };
}

BrowserAgent.redaction = {
  TOKENS: TOKENS,
  NEVER_REVEAL: NEVER_REVEAL,
  TEXT_FIELDS: TEXT_FIELDS,
  build: build,
  fillFromVault: fillFromVault
};

globalThis.BrowserAgent = BrowserAgent;
