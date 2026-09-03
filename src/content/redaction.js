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
 * Redaction runs in two passes. The rule pass (`build`) replaces everything
 * the validators recognise. The model pass (`applyEntities`) then replaces
 * what only NER can find, minting into the same vault so one value keeps one
 * placeholder across both. The ordering is a privacy decision and is
 * explained above `collectTexts`.
 *
 * Two deliberate limits:
 *
 * - Redaction is still scoped to what detection found. An identifier neither
 *   the validators nor the model recognise — a bank account number with no
 *   check digit, a Devanagari name the English checkpoint cannot read — is
 *   *not* redacted. The metrics in eval/ are therefore close to a direct
 *   measure of what leaks.
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
  image_embedded_text: "IMAGE_TEXT",
  truncated_text: "TRUNCATED"
};

/** Categories that get a placeholder but never a vault entry. */
var NEVER_REVEAL = {
  password: true,
  cvv: true,
  otp: true,
  authentication_secret: true,
  truncated_text: true
};

/** Snapshot string fields that can carry a rendered value. */
var TEXT_FIELDS = [
  "text",
  "ariaLabel",
  "placeholder",
  "name",
  "htmlId",
  "labelFor",
  "alt",
  "href",
  "src"
];

/** Fields that cannot hold a person name. Sending them to NER is wasted WASM. */
var SKIP_MODEL_FIELDS = { href: true, src: true };

function looksNameBearing(text) {
  if (!text || typeof text !== "string") {
    return false;
  }
  if (!/[A-Za-z\u0900-\u097F]/.test(text)) {
    return false;
  }
  var stripped = text.replace(/<[A-Z][A-Z0-9_]*>/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length >= 2;
}

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
          reused: true,
          score: context.score
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
        oneWay: Boolean(NEVER_REVEAL[category]),
        score: context.score
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
  if (value.endsWith("…")) {
    return minter.mint("truncated_text", value, {
      confidence: "truncation-guard",
      elementId: context.elementId,
      field: context.field
    });
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
 * @param {object} snapshot
 * @param {object} policy
 * @param {object} [minter] Pass one to keep minting into the same vault
 *   across passes, so a second pass continues the numbering and reuses a
 *   placeholder for a value the first pass already saw.
 * @returns {{agentContext: object, vault: object, redaction: object, minter: object}}
 */
function build(snapshot, policy, minter) {
  var normalized = BrowserAgent.normalizeSensitivityPolicy
    ? BrowserAgent.normalizeSensitivityPolicy(policy)
    : policy || {};

  // Deep copy so the redacted object shares no structure with the original.
  var agentContext = JSON.parse(JSON.stringify(snapshot));
  minter = minter || createMinter();

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

  return finish(agentContext, minter);
}

/**
 * Recompute the redaction summary from the minter's records and stamp it onto
 * the context. Called at the end of every pass, so counts always describe all
 * of them rather than only the last.
 */
function finish(agentContext, minter) {
  var categories = {};
  var elementIds = {};
  var bySource = {};
  minter.records.forEach(function (record) {
    categories[record.category] = (categories[record.category] || 0) + 1;
    bySource[record.confidence] = (bySource[record.confidence] || 0) + 1;
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
      categories: categories,
      byConfidence: bySource
    },
    elementIds: Object.keys(elementIds)
  };

  agentContext.redacted = true;
  agentContext.redactionCounts = redaction.counts;

  return {
    agentContext: agentContext,
    vault: minter.vault,
    redaction: redaction,
    minter: minter
  };
}

/* ------------------------------------------------------------------ *
 * Model pass
 *
 * The rule pass above runs first and this one runs second, which is a
 * privacy decision rather than an implementation convenience. NER needs
 * Transformers.js, which lives in the offscreen document, so its input has
 * to cross a message boundary — and by running it second, the strings that
 * cross have already had every checksum-verified identifier replaced by a
 * placeholder. Only unstructured text is exposed to the internal hop, and
 * the vault itself never moves.
 * ------------------------------------------------------------------ */

/**
 * Every string in the context that is worth scanning, paired with a live
 * reference to where it came from.
 *
 * Deterministic in both order and key, which is what lets `applyEntities`
 * call this again to find its way back to the right field instead of the
 * caller having to carry a map through the round trip.
 *
 * @returns {Array<{key: string, text: string, owner: object, field: string, index: number|null}>}
 */
function collectTexts(agentContext) {
  var out = [];

  function push(key, owner, field, index) {
    var value = index == null ? owner[field] : owner[field][index];
    if (typeof value !== "string" || !value.trim()) {
      return;
    }
    out.push({
      key: key,
      text: value,
      owner: owner,
      field: field,
      index: index == null ? null : index
    });
  }

  if (agentContext.page) {
    push("page.title", agentContext.page, "title", null);
  }

  (agentContext.elements || []).forEach(function (element, position) {
    // Position, not element.id, so the key cannot be broken by an id that
    // happens to contain the separator.
    TEXT_FIELDS.forEach(function (field) {
      push("el." + position + "." + field, element, field, null);
    });
    if (Array.isArray(element.options)) {
      element.options.forEach(function (_option, optionIndex) {
        push("el." + position + ".options." + optionIndex, element, "options", optionIndex);
      });
    }
  });

  return out;
}

/** The strings only, for sending across a message boundary. */
function textsForModel(agentContext) {
  return collectTexts(agentContext)
    .filter(function (item) {
      if (SKIP_MODEL_FIELDS[item.field]) {
        return false;
      }
      return looksNameBearing(item.text);
    })
    .map(function (item) {
      return { key: item.key, text: item.text };
    });
}

/**
 * Apply model-detected entities to a context the rule pass already redacted.
 *
 * @param {object} agentContext Mutated in place.
 * @param {Array<{key: string, entities: Array}>} results From the NER engine.
 * @param {object} policy
 * @param {object} minter The same minter the rule pass used.
 */
function applyEntities(agentContext, results, policy, minter) {
  var normalized = BrowserAgent.normalizeSensitivityPolicy
    ? BrowserAgent.normalizeSensitivityPolicy(policy)
    : policy || {};

  var targets = {};
  collectTexts(agentContext).forEach(function (item) {
    targets[item.key] = item;
  });

  var elementByPosition = agentContext.elements || [];

  (results || []).forEach(function (result) {
    var target = targets[result.key];
    if (!target) {
      return;
    }

    var admitted = (result.entities || []).filter(function (entity) {
      return entity && entity.category && normalized[entity.category];
    });
    if (!admitted.length) {
      return;
    }

    // Right to left, so replacing a later span cannot shift an earlier one.
    admitted.sort(function (a, b) {
      return b.start - a.start;
    });

    var value = target.text;
    admitted.forEach(function (entity) {
      var raw = value.slice(entity.start, entity.start + entity.length);
      if (!raw) {
        return;
      }
      var placeholder = minter.mint(entity.category, raw, {
        confidence: "model",
        elementId: target.owner.id || null,
        field: target.index == null ? target.field : target.field + "[" + target.index + "]",
        score: entity.score
      });
      value = value.slice(0, entity.start) + placeholder + value.slice(entity.start + entity.length);
    });

    if (target.index == null) {
      target.owner[target.field] = value;
    } else {
      target.owner[target.field][target.index] = value;
    }

    // Record why, on the element, so a model redaction is as inspectable as
    // a checksum one. No offsets: the span is gone, replaced by a
    // placeholder of a different length, so publishing them would be a lie.
    var position = Number(String(result.key).split(".")[1]);
    var element = elementByPosition[position];
    if (element && String(result.key).indexOf("el.") === 0) {
      element.sensitivitySignals = element.sensitivitySignals || [];
      admitted.forEach(function (entity) {
        var already = element.sensitivitySignals.some(function (signal) {
          return signal.category === entity.category && signal.confidence === "model";
        });
        if (!already) {
          element.sensitivitySignals.push({
            category: entity.category,
            via: "value",
            confidence: "model",
            score: entity.score
          });
        }
        if ((element.sensitivityCategories || []).indexOf(entity.category) === -1) {
          element.sensitivityCategories = (element.sensitivityCategories || []).concat([
            entity.category
          ]);
        }
      });
    }
  });

  return finish(agentContext, minter);
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
  createMinter: createMinter,
  build: build,
  redactText: redactString,
  textsForModel: textsForModel,
  applyEntities: applyEntities,
  fillFromVault: fillFromVault
};

globalThis.BrowserAgent = BrowserAgent;
