/**
 * User-authored fill profile. Lives in chrome.storage.local on this device
 * so you do not re-enter email/Aadhaar every time the popup opens. Values
 * never leave the extension; the remote planner only sees availability tokens
 * such as <PROFILE_AADHAAR>. Expansion happens in the content script at apply
 * time, and only when the target field is asking for that category.
 *
 * Passwords, OTPs, CVVs and auth secrets cannot be stored here.
 * A DigiLocker / security PIN can: it is a user-saved login PIN, not an SMS OTP.
 */
var BrowserAgent = globalThis.BrowserAgent || {};

var STORAGE_KEY = "browserAgent.profileVault";

var TOKEN_BODY = {
  payment_card: "CARD",
  bank_account: "BANK",
  person_name: "NAME",
  person_title: "TITLE",
  middle_initial: "MIDDLE",
  pin_code: "PIN",
  card_holder_name: "CARD_NAME",
  card_issuing_bank: "CARD_BANK",
  card_service_phone: "CARD_PHONE",
  card_type: "CARD_TYPE",
  driver_license: "DL",
  custom_message: "MESSAGE",
  birth_place: "BIRTHPLACE",
  security_pin: "SECURITY_PIN"
};

var ALLOWED = {
  email: true,
  phone: true,
  fax: true,
  website: true,
  address: true,
  pin_code: true,
  country: true,
  person_name: true,
  person_title: true,
  middle_initial: true,
  company: true,
  position: true,
  sex: true,
  date_of_birth: true,
  age: true,
  birth_place: true,
  username: true,
  security_pin: true,
  upi: true,
  aadhaar: true,
  pan: true,
  passport: true,
  voter_id: true,
  gstin: true,
  ssn: true,
  driver_license: true,
  payment_card: true,
  card_type: true,
  card_holder_name: true,
  card_issuing_bank: true,
  card_service_phone: true,
  bank_account: true,
  income: true,
  custom_message: true,
  comments: true
};

var HIGH_RISK = {
  aadhaar: true,
  pan: true,
  passport: true,
  voter_id: true,
  gstin: true,
  ssn: true,
  driver_license: true,
  payment_card: true,
  bank_account: true,
  security_pin: true
};

var BLOCKED = {
  password: true,
  otp: true,
  cvv: true,
  authentication_secret: true
};

var PROFILE_RE = /^<PROFILE_([A-Z][A-Z0-9_]*)>$/;
var MAX_VALUE = 500;

function tokenBody(category) {
  if (TOKEN_BODY[category]) {
    return TOKEN_BODY[category];
  }
  return String(category).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function placeholderFor(category) {
  return "<PROFILE_" + tokenBody(category) + ">";
}

function categoryFromPlaceholder(placeholder) {
  var match = PROFILE_RE.exec(String(placeholder || ""));
  if (!match) {
    return null;
  }
  var body = match[1];
  var names = Object.keys(ALLOWED);
  for (var i = 0; i < names.length; i++) {
    if (tokenBody(names[i]) === body) {
      return names[i];
    }
  }
  return body.toLowerCase();
}

function isProfilePlaceholder(placeholder) {
  return PROFILE_RE.test(String(placeholder || ""));
}

function allowedCategories() {
  var catalog = BrowserAgent.SENSITIVITY_CATEGORIES || [];
  var byId = {};
  catalog.forEach(function (item) {
    byId[item.id] = item;
  });
  return Object.keys(ALLOWED)
    .filter(function (id) {
      return !BLOCKED[id];
    })
    .map(function (id) {
      var item = byId[id] || {};
      return {
        id: id,
        label: item.label || id.replace(/_/g, " "),
        description: item.description || "",
        highRisk: Boolean(HIGH_RISK[id]),
        placeholder: placeholderFor(id)
      };
    });
}

function validateValue(category, value) {
  if (BLOCKED[category] || !ALLOWED[category]) {
    return { ok: false, error: "That category cannot be stored in the local profile." };
  }
  var trimmed = String(value || "").trim();
  if (!trimmed) {
    return { ok: false, error: "Value is empty." };
  }
  if (trimmed.length > MAX_VALUE) {
    return { ok: false, error: "Value is too long." };
  }
  // Local test fills are not held to checksum/format rules. Page detection
  // still uses validators.js; this vault only stores what you typed.
  return { ok: true, value: trimmed };
}

function emptyStore() {
  return { values: {}, updatedAt: null };
}

function sanitizeStore(raw) {
  var out = emptyStore();
  var values = raw && raw.values && typeof raw.values === "object" ? raw.values : {};
  Object.keys(values).forEach(function (category) {
    if (!ALLOWED[category] || BLOCKED[category]) {
      return;
    }
    var checked = validateValue(category, values[category]);
    if (checked.ok) {
      out.values[category] = checked.value;
    }
  });
  out.updatedAt = raw && raw.updatedAt ? raw.updatedAt : Object.keys(out.values).length ? Date.now() : null;
  return out;
}

function publicCatalog(store) {
  var values = (store && store.values) || {};
  var available = {};
  var tokens = {};
  Object.keys(ALLOWED).forEach(function (category) {
    if (values[category]) {
      available[category] = true;
      tokens[category] = placeholderFor(category);
    }
  });
  return {
    available: available,
    tokens: tokens,
    note: "Values stay on this device. Use a token only on a field that asks for that category. If a token is absent, leave the field empty."
  };
}

function applyMap(store) {
  var values = (store && store.values) || {};
  var map = {};
  Object.keys(values).forEach(function (category) {
    map[placeholderFor(category)] = values[category];
  });
  return map;
}

function maskValue(value) {
  var text = String(value || "");
  if (text.length <= 4) {
    return "saved";
  }
  return "saved · …" + text.slice(-4);
}

function fieldAcceptsCategory(element, category) {
  if (!element || !category) {
    return false;
  }
  var cats = element.sensitivityCategories || [];
  if (cats.indexOf(category) !== -1) {
    return true;
  }
  var signals = element.sensitivitySignals || [];
  for (var i = 0; i < signals.length; i++) {
    if (signals[i].category === category && signals[i].via === "field-purpose") {
      return true;
    }
  }
  var inputType = String(element.inputType || "").toLowerCase();
  if (inputType === "email" && category === "email") {
    return true;
  }
  if (inputType === "tel" && category === "phone") {
    return true;
  }
  var autocomplete = String(element.autocomplete || "").toLowerCase();
  if (autocomplete === "email" && category === "email") {
    return true;
  }
  if ((autocomplete === "tel" || autocomplete === "tel-national") && category === "phone") {
    return true;
  }
  if ((autocomplete === "name" || autocomplete === "given-name") && category === "person_name") {
    return true;
  }
  if (
    category === "pin_code" &&
    (autocomplete === "postal-code" || /\b(?:pin(?:code)?|zip|postal[-_\s]?code)\b/i.test(haystack(element)))
  ) {
    return true;
  }
  if (category === "address") {
    if (/^(?:street-address|address-line1|address-line2|address-level1|address-level2)$/.test(autocomplete)) {
      return true;
    }
    var addressText = haystack(element);
    if (
      /address(?:[-_]?line)?[-_]?[12]\b/i.test(addressText) ||
      /(?<!\b(?:e-?mail|ip|mac|web|url|wallet|crypto)\s{0,2})\baddress\b/i.test(addressText) ||
      /\b(?:street|postal|mailing|billing|shipping|delivery|city|locality|landmark|province)\b/i.test(addressText) ||
      /\bstate\b/i.test(addressText)
    ) {
      return true;
    }
  }
  if (category === "country" && (autocomplete === "country" || autocomplete === "country-name")) {
    return true;
  }
  if (category === "username" && /\buser\s*id\b/i.test(haystack(element))) {
    return true;
  }
  if (category === "fax" && /\bfax\b/i.test(haystack(element))) {
    return true;
  }
  if (category === "security_pin") {
    if (cats.indexOf("otp") !== -1 || cats.indexOf("cvv") !== -1) {
      return false;
    }
    var pinText = haystack(element);
    if (
      /security\s*pin/i.test(pinText) ||
      /6[\s-]?digit\s+(?:security\s+)?pin/i.test(pinText) ||
      /\b(?:m[\s-]?pin|mpin)\b/i.test(pinText) ||
      /(?:login|unlock|account)\s*pin/i.test(pinText)
    ) {
      return true;
    }
    if (inputType === "password" && /\bpin\b/i.test(pinText)) {
      return true;
    }
  }
  var catalog = BrowserAgent.SENSITIVITY_CATEGORIES || [];
  for (var c = 0; c < catalog.length; c++) {
    if (catalog[c].id !== category) {
      continue;
    }
    var autos = catalog[c].autocomplete || [];
    if (autos.indexOf(autocomplete) !== -1) {
      return true;
    }
    var patterns = catalog[c].patterns || [];
    var text = haystack(element);
    for (var p = 0; p < patterns.length; p++) {
      if (patterns[p].test(text)) {
        return true;
      }
    }
  }
  return false;
}

function haystack(element) {
  return [
    element.name,
    element.htmlId,
    element.placeholder,
    element.ariaLabel,
    element.text
  ]
    .filter(Boolean)
    .join(" ");
}

function isHighRisk(category) {
  return Boolean(HIGH_RISK[category]);
}

function storageArea() {
  return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local
    ? chrome.storage.local
    : null;
}

function readArea(area) {
  return new Promise(function (resolve) {
    if (!area) {
      resolve(emptyStore());
      return;
    }
    area.get(STORAGE_KEY, function (stored) {
      resolve(sanitizeStore(stored && stored[STORAGE_KEY]));
    });
  });
}

function load() {
  var local = storageArea();
  if (!local) {
    return Promise.resolve(emptyStore());
  }
  return readArea(local).then(function (store) {
    if (Object.keys(store.values).length) {
      return store;
    }
    if (!chrome.storage.session) {
      return store;
    }
    return readArea(chrome.storage.session).then(function (sessionStore) {
      if (!Object.keys(sessionStore.values).length) {
        return store;
      }
      return save(sessionStore).then(function (saved) {
        chrome.storage.session.remove(STORAGE_KEY);
        return saved;
      });
    });
  });
}

function save(store) {
  var clean = sanitizeStore(store);
  clean.updatedAt = Date.now();
  return new Promise(function (resolve, reject) {
    var local = storageArea();
    if (!local) {
      reject(new Error("Local storage is unavailable."));
      return;
    }
    var payload = {};
    payload[STORAGE_KEY] = clean;
    local.set(payload, function () {
      if (chrome.runtime && chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(clean);
    });
  });
}

function clear() {
  return save(emptyStore());
}

BrowserAgent.profileVault = {
  STORAGE_KEY: STORAGE_KEY,
  ALLOWED: ALLOWED,
  HIGH_RISK: HIGH_RISK,
  PROFILE_RE: PROFILE_RE,
  tokenBody: tokenBody,
  placeholderFor: placeholderFor,
  categoryFromPlaceholder: categoryFromPlaceholder,
  isProfilePlaceholder: isProfilePlaceholder,
  allowedCategories: allowedCategories,
  validateValue: validateValue,
  sanitizeStore: sanitizeStore,
  publicCatalog: publicCatalog,
  applyMap: applyMap,
  maskValue: maskValue,
  fieldAcceptsCategory: fieldAcceptsCategory,
  isHighRisk: isHighRisk,
  emptyStore: emptyStore,
  load: load,
  save: save,
  clear: clear
};

globalThis.BrowserAgent = BrowserAgent;
