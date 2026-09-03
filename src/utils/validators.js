/**
 * Value-level detection for structured identifiers.
 *
 * The catalog in sensitivityCatalog.js answers "is this field *asking* for an
 * Aadhaar number?" by matching keywords against DOM attributes. This file
 * answers a different question: "is this string *actually* an Aadhaar number?"
 *
 * Structured identifiers do not need a model. They need format validation,
 * which is a stronger claim than a confidence score: a Verhoeff check digit
 * either passes or it does not. Bare digit-counting flags every 12-digit
 * number on the page; a checksum removes nearly all of those false positives.
 *
 * Confidence levels, weakest to strongest:
 *
 *   "shape"     — pattern only, high false-positive rate. Requires a
 *                 corroborating keyword nearby before we report it.
 *   "structure" — pattern plus a structural rule that random strings fail
 *                 (fixed characters, valid charset, plausible ranges).
 *   "checksum"  — pattern plus an arithmetic check digit.
 *
 * This module never retains a matched value. Callers receive the category,
 * the confidence, and optionally an offset and length so Phase 5 can replace
 * the substring with a placeholder. The value itself stays where it was.
 */
var BrowserAgent = globalThis.BrowserAgent || {};

/** Bound regex work on very long text nodes. */
var MAX_SCAN_LENGTH = 4000;

var CONFIDENCE_RANK = {
  checksum: 3,
  structure: 2,
  shape: 1,
  keyword: 0
};

/* ------------------------------------------------------------------ *
 * Checksums
 * ------------------------------------------------------------------ */

/** Dihedral group D5 multiplication table. */
var VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
];

/** Permutation table, applied cyclically by digit position. */
var VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
];

/**
 * Verhoeff check-digit validation. UIDAI uses this for Aadhaar, so a
 * mistyped or randomly generated 12-digit number fails with probability ~0.9.
 */
function verhoeffValid(digits) {
  if (!/^\d+$/.test(digits)) {
    return false;
  }
  var c = 0;
  for (var i = 0; i < digits.length; i++) {
    var digit = Number(digits.charAt(digits.length - 1 - i));
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][digit]];
  }
  return c === 0;
}

/** Luhn mod-10, used by payment card numbers. */
function luhnValid(digits) {
  if (!/^\d+$/.test(digits)) {
    return false;
  }
  var sum = 0;
  var double = false;
  for (var i = digits.length - 1; i >= 0; i--) {
    var digit = Number(digits.charAt(i));
    if (double) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

var GSTIN_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** GSTIN mod-36 check character over the first 14 characters. */
function gstinChecksumValid(value) {
  if (value.length !== 15) {
    return false;
  }
  var factor = 2;
  var sum = 0;
  var base = GSTIN_CHARSET.length;
  for (var i = 13; i >= 0; i--) {
    var codePoint = GSTIN_CHARSET.indexOf(value.charAt(i));
    if (codePoint < 0) {
      return false;
    }
    var product = factor * codePoint;
    factor = factor === 2 ? 1 : 2;
    sum += Math.floor(product / base) + (product % base);
  }
  var expected = GSTIN_CHARSET.charAt((base - (sum % base)) % base);
  return expected === value.charAt(14);
}

/* ------------------------------------------------------------------ *
 * Structural rules
 * ------------------------------------------------------------------ */

/**
 * PAN has no checksum, but the 4th character encodes the holder type and
 * only a fixed set of letters is issued. That alone rejects most random
 * 5-letter/4-digit/1-letter strings.
 */
var PAN_ENTITY_TYPES = "ABCFGHJLPTK";

function panValid(value) {
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(value)) {
    return false;
  }
  return PAN_ENTITY_TYPES.indexOf(value.charAt(3)) !== -1;
}

/** IFSC is 11 characters and the 5th is always "0". */
function ifscValid(value) {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(value);
}

/** Aadhaar is never issued starting with 0 or 1. */
function aadhaarValid(digits) {
  if (!/^[2-9]\d{11}$/.test(digits)) {
    return false;
  }
  return verhoeffValid(digits);
}

function cardValid(digits) {
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }
  return luhnValid(digits);
}

function gstinValid(value) {
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(value)) {
    return false;
  }
  var stateCode = Number(value.slice(0, 2));
  if (stateCode < 1 || stateCode > 38) {
    return false;
  }
  if (!panValid(value.slice(2, 12))) {
    return false;
  }
  return gstinChecksumValid(value);
}

/* ------------------------------------------------------------------ *
 * Matchers
 * ------------------------------------------------------------------ */

function digitsOnly(raw) {
  return raw.replace(/\D/g, "");
}

function upperCompact(raw) {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * Each matcher maps onto a category id already present in the catalog, so
 * the popup's existing checkboxes keep governing whether it runs at all.
 *
 * `source` is a string rather than a literal RegExp so every scan gets a
 * fresh object and there is no shared lastIndex to reset.
 */
var MATCHERS = [
  {
    category: "password",
    confidence: "structure",
    source: "\\b(?:password|passwd|passcode)\\s*(?:is|[:=])\\s*\\S+",
    flags: "gi",
    normalize: function (raw) {
      return raw;
    },
    validate: function (value) {
      return value.length <= 1024;
    }
  },
  {
    category: "otp",
    confidence: "structure",
    source: "\\b(?:otp|one[-\\s]?time\\s*code|verification\\s*code)\\s*(?:is|[:=])\\s*\\d{4,8}\\b",
    flags: "gi",
    normalize: function (raw) {
      return raw;
    },
    validate: function () {
      return true;
    }
  },
  {
    category: "cvv",
    confidence: "structure",
    source: "\\b(?:cvv2?|cvc|security\\s*code)\\s*(?:is|[:=])\\s*\\d{3,4}\\b",
    flags: "gi",
    normalize: function (raw) {
      return raw;
    },
    validate: function () {
      return true;
    }
  },
  {
    category: "aadhaar",
    confidence: "checksum",
    source: "\\b[2-9]\\d{3}[\\s-]?\\d{4}[\\s-]?\\d{4}\\b",
    flags: "g",
    normalize: digitsOnly,
    validate: aadhaarValid
  },
  {
    category: "payment_card",
    confidence: "checksum",
    source: "\\b\\d(?:[\\s-]?\\d){12,18}\\b",
    flags: "g",
    normalize: digitsOnly,
    validate: cardValid
  },
  {
    category: "gstin",
    confidence: "checksum",
    source: "\\b\\d{2}[A-Za-z]{5}\\d{4}[A-Za-z][A-Za-z\\d][Zz][A-Za-z\\d]\\b",
    flags: "g",
    normalize: upperCompact,
    validate: gstinValid
  },
  {
    category: "pan",
    confidence: "structure",
    source: "\\b[A-Za-z]{5}\\d{4}[A-Za-z]\\b",
    flags: "g",
    normalize: upperCompact,
    validate: panValid
  },
  {
    category: "bank_account",
    confidence: "structure",
    source: "\\b[A-Za-z]{4}0[A-Za-z\\d]{6}\\b",
    flags: "g",
    normalize: upperCompact,
    validate: ifscValid
  },
  {
    category: "authentication_secret",
    confidence: "structure",
    source: "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b",
    flags: "g",
    normalize: function (raw) {
      return raw;
    },
    validate: function (value) {
      return value.length <= 4096;
    }
  },
  {
    category: "authentication_secret",
    confidence: "structure",
    source:
      "\\b(?:Bearer\\s+|access[_-]?token[=:]|session(?:id|token)[=:]|api[_-]?key[=:])[A-Za-z0-9._~+/-]{8,}",
    flags: "gi",
    normalize: function (raw) {
      return raw;
    },
    validate: function (value) {
      return value.length <= 4096;
    }
  },
  {
    category: "email",
    confidence: "structure",
    source: "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+",
    flags: "g",
    normalize: function (raw) {
      return raw;
    },
    validate: function (value) {
      return value.length <= 254;
    }
  },
  {
    // A UPI handle looks like an email without a dotted domain. The second
    // lookahead rejects a dot only when a domain label continues after it,
    // so "user@gmail" inside "user@gmail.com" is skipped while a handle at
    // the end of a sentence ("pay kartik@paytm.") still matches.
    category: "upi",
    confidence: "structure",
    source: "[A-Za-z0-9.\\-_]{2,64}@[A-Za-z]{2,64}(?![A-Za-z])(?!\\.[A-Za-z])",
    flags: "g",
    normalize: function (raw) {
      return raw;
    },
    validate: function (value) {
      return /^[A-Za-z0-9.\-_]{2,64}@[A-Za-z]{2,64}$/.test(value);
    }
  },
  {
    category: "phone",
    confidence: "structure",
    source: "(?<!\\d)(?:\\+?91[\\s-]?)?[6-9]\\d{4}[\\s-]?\\d{5}(?!\\d)",
    flags: "g",
    normalize: digitsOnly,
    validate: function (digits) {
      var local = digits.length === 12 && digits.indexOf("91") === 0 ? digits.slice(2) : digits;
      return /^[6-9]\d{9}$/.test(local);
    }
  },
  {
    category: "voter_id",
    confidence: "shape",
    source: "\\b[A-Za-z]{3}\\d{7}\\b",
    flags: "g",
    normalize: upperCompact,
    validate: function (value) {
      return /^[A-Z]{3}\d{7}$/.test(value);
    }
  },
  {
    category: "passport",
    confidence: "shape",
    source: "\\b[A-Za-z]\\d{7}\\b",
    flags: "g",
    normalize: upperCompact,
    validate: function (value) {
      return /^[A-PR-WYa-pr-wy]\d{7}$/i.test(value);
    }
  }
];

var MATCHERS_BY_CATEGORY = {};
MATCHERS.forEach(function (matcher) {
  MATCHERS_BY_CATEGORY[matcher.category] = matcher;
});

/**
 * "shape" matchers are too loose to stand alone, so they only count when the
 * surrounding DOM already mentions the category. This is the one place where
 * value detection still leans on the keyword catalog.
 */
function hasCorroboration(category, corroborationText) {
  if (!corroborationText) {
    return false;
  }
  var catalog = BrowserAgent.SENSITIVITY_CATEGORIES || [];
  for (var i = 0; i < catalog.length; i++) {
    if (catalog[i].id !== category) {
      continue;
    }
    var patterns = catalog[i].patterns || [];
    for (var j = 0; j < patterns.length; j++) {
      if (patterns[j].test(corroborationText)) {
        return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * Greedy non-overlapping selection, strongest evidence first. A 16-digit
 * Luhn-valid card contains 10-digit runs that look like phone numbers; the
 * checksum match wins and the weaker overlap is dropped.
 */
function resolveOverlaps(candidates) {
  var ordered = candidates.slice().sort(function (a, b) {
    var byConfidence = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
    if (byConfidence !== 0) {
      return byConfidence;
    }
    if (b.length !== a.length) {
      return b.length - a.length;
    }
    return a.start - b.start;
  });

  var accepted = [];
  ordered.forEach(function (candidate) {
    var end = candidate.start + candidate.length;
    for (var i = 0; i < accepted.length; i++) {
      var other = accepted[i];
      if (candidate.start < other.start + other.length && other.start < end) {
        return;
      }
    }
    accepted.push(candidate);
  });

  return accepted.sort(function (a, b) {
    return a.start - b.start;
  });
}

/**
 * Scan text for identifier values.
 *
 * @param {string} text Text to scan. Truncated to MAX_SCAN_LENGTH.
 * @param {object} policy Normalized sensitivity policy; gates each category.
 * @param {object} [options]
 * @param {string} [options.corroborationText] Attribute/label text used to
 *   admit low-confidence "shape" matches.
 * @param {string[]} [options.admitShapes] Categories whose "shape" matchers
 *   are admitted without corroboration. Used by the redaction pass, where
 *   detection has already decided and the only remaining job is to locate the
 *   value — the corroborating text may have lived in a neighbouring element
 *   that the snapshot does not carry.
 * @param {boolean} [options.offsets] Include start/length. Pass false for
 *   values the user typed, where even a length is more than we need.
 * @returns {Array<{category: string, confidence: string, start?: number, length?: number}>}
 */
function findValues(text, policy, options) {
  var scanText = BrowserAgent.text
    ? BrowserAgent.text.normalizeText(text)
    : String(text == null ? "" : text);
  if (!scanText) {
    return [];
  }
  if (scanText.length > MAX_SCAN_LENGTH) {
    scanText = scanText.slice(0, MAX_SCAN_LENGTH);
  }

  var opts = options || {};
  var includeOffsets = opts.offsets !== false;
  var candidates = [];

  MATCHERS.forEach(function (matcher) {
    if (policy && !policy[matcher.category]) {
      return;
    }
    if (matcher.confidence === "shape") {
      var preApproved = opts.admitShapes && opts.admitShapes.indexOf(matcher.category) !== -1;
      if (!preApproved && !hasCorroboration(matcher.category, opts.corroborationText)) {
        return;
      }
    }

    var regex = new RegExp(matcher.source, matcher.flags);
    var match = regex.exec(scanText);
    while (match) {
      var raw = match[0];
      var normalized = matcher.normalize(raw);
      if (matcher.validate(normalized)) {
        candidates.push({
          category: matcher.category,
          confidence: matcher.confidence,
          start: match.index,
          length: raw.length
        });
      }
      if (regex.lastIndex === match.index) {
        regex.lastIndex += 1;
      }
      match = regex.exec(scanText);
    }
  });

  var resolved = resolveOverlaps(candidates);
  if (includeOffsets) {
    return resolved;
  }
  return resolved.map(function (item) {
    return { category: item.category, confidence: item.confidence };
  });
}

/**
 * Scan a value the user typed. Returns one entry per distinct category and
 * deliberately drops offsets, so nothing about the value's position or
 * length survives the call.
 */
function scanControlValue(value, policy, corroborationText) {
  var found = findValues(value, policy, {
    corroborationText: corroborationText,
    offsets: false
  });
  var seen = {};
  var out = [];
  found.forEach(function (item) {
    if (seen[item.category]) {
      return;
    }
    seen[item.category] = true;
    out.push(item);
  });
  return out;
}

BrowserAgent.validators = {
  MAX_SCAN_LENGTH: MAX_SCAN_LENGTH,
  CONFIDENCE_RANK: CONFIDENCE_RANK,
  MATCHERS_BY_CATEGORY: MATCHERS_BY_CATEGORY,
  verhoeffValid: verhoeffValid,
  luhnValid: luhnValid,
  gstinChecksumValid: gstinChecksumValid,
  aadhaarValid: aadhaarValid,
  cardValid: cardValid,
  gstinValid: gstinValid,
  panValid: panValid,
  ifscValid: ifscValid,
  findValues: findValues,
  scanControlValue: scanControlValue
};

globalThis.BrowserAgent = BrowserAgent;
