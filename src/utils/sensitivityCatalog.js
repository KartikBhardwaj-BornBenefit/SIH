/**
 * Catalog of sensitive-data aspects.
 *
 * The extension does not train a PII model. It matches DOM attributes
 * (and optionally vision/OCR outputs) against this list. Users can turn
 * each aspect on or off from the popup form.
 */
var BrowserAgent = globalThis.BrowserAgent || {};

var SENSITIVITY_STORAGE_KEY = "browserAgent.sensitivityPolicy";

var SENSITIVITY_CATEGORIES = [
  {
    id: "password",
    group: "credentials",
    groupLabel: "Credentials",
    label: "Passwords",
    description: "Password inputs and current/new-password autocomplete.",
    source: "dom",
    level: "sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    inputTypes: ["password"],
    autocomplete: ["current-password", "new-password"],
    patterns: [/password/i, /passwd/i]
  },
  {
    id: "otp",
    group: "credentials",
    groupLabel: "Credentials",
    label: "OTP / one-time codes",
    description: "OTP, 2FA, and one-time-code fields.",
    source: "dom",
    level: "sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    autocomplete: ["one-time-code"],
    patterns: [/\botp\b/i, /one[-\s]?time/i, /one[-\s]?time[-\s]?code/i]
  },
  {
    id: "username",
    group: "credentials",
    groupLabel: "Credentials",
    label: "Usernames",
    description: "Username fields and autocomplete=username.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    autocomplete: ["username"],
    patterns: [/user\s*name/i, /username/i]
  },
  {
    id: "payment_card",
    group: "payments",
    groupLabel: "Payments & banking",
    label: "Card number",
    description: "Credit/debit card number fields.",
    source: "dom",
    level: "sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    autocomplete: ["cc-number", "cc-exp", "cc-exp-month", "cc-exp-year"],
    patterns: [/card\s*(number|no\.?|num)/i, /credit\s*card/i, /debit\s*card/i]
  },
  {
    id: "cvv",
    group: "payments",
    groupLabel: "Payments & banking",
    label: "CVV / security code",
    description: "Card CSC/CVV fields.",
    source: "dom",
    level: "sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    autocomplete: ["cc-csc"],
    patterns: [/\bcvv\b|\bcvc\b|\bcvv2\b/i, /security\s*code/i]
  },
  {
    id: "bank_account",
    group: "payments",
    groupLabel: "Payments & banking",
    label: "Bank account / IFSC / IBAN",
    description: "Account numbers and bank routing identifiers.",
    source: "dom",
    level: "sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    patterns: [/ifsc/i, /iban/i, /swift/i, /account\s*(number|no\.?)/i]
  },
  {
    id: "upi",
    group: "payments",
    groupLabel: "Payments & banking",
    label: "UPI IDs",
    description: "UPI handles and related fields.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    patterns: [/\bupi\b/i]
  },
  {
    id: "email",
    group: "contact",
    groupLabel: "Contact details",
    label: "Email addresses",
    description: "Email inputs and email-like labels.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    inputTypes: ["email"],
    autocomplete: ["email"],
    patterns: [/e-?mail/i]
  },
  {
    id: "phone",
    group: "contact",
    groupLabel: "Contact details",
    label: "Phone numbers",
    description: "Telephone inputs and phone/mobile labels.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    inputTypes: ["tel"],
    autocomplete: ["tel", "tel-national", "tel-local"],
    patterns: [/phone/i, /mobile/i, /\btel\b/i, /whatsapp/i]
  },
  {
    id: "address",
    group: "contact",
    groupLabel: "Contact details",
    label: "Address / PIN code",
    description: "Street address, city, and postal code fields.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    autocomplete: [
      "street-address",
      "address-line1",
      "address-line2",
      "address-level1",
      "address-level2",
      "postal-code"
    ],
    patterns: [/address/i, /pincode/i, /pin\s*code/i, /\bzip\b/i, /postal/i]
  },
  {
    id: "person_name",
    group: "identity",
    groupLabel: "Personal identity",
    label: "Person name",
    description: "Full name, first name, last name, surname.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    autocomplete: ["name", "given-name", "family-name"],
    patterns: [/first\s*name/i, /last\s*name/i, /full\s*name/i, /surname/i, /given\s*name/i]
  },
  {
    id: "date_of_birth",
    group: "identity",
    groupLabel: "Personal identity",
    label: "Date of birth",
    description: "DOB and birthday fields.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    autocomplete: ["bday", "bday-day", "bday-month", "bday-year"],
    patterns: [/date\s*of\s*birth/i, /\bdob\b/i, /birthday/i]
  },
  {
    id: "aadhaar",
    group: "gov_id",
    groupLabel: "Government IDs",
    label: "Aadhaar",
    description: "Aadhaar / UIDAI number fields.",
    source: "dom",
    level: "sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    patterns: [/aadhaar/i, /aadhar/i, /uidai/i]
  },
  {
    id: "pan",
    group: "gov_id",
    groupLabel: "Government IDs",
    label: "PAN",
    description: "Permanent Account Number fields.",
    source: "dom",
    level: "sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    patterns: [/\bpan\b/i, /permanent\s*account/i]
  },
  {
    id: "passport",
    group: "gov_id",
    groupLabel: "Government IDs",
    label: "Passport",
    description: "Passport number fields.",
    source: "dom",
    level: "sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    patterns: [/passport/i]
  },
  {
    id: "voter_id",
    group: "gov_id",
    groupLabel: "Government IDs",
    label: "Voter / ration card",
    description: "Voter ID and ration card fields.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    patterns: [/voter/i, /ration\s*card/i]
  },
  {
    id: "gstin",
    group: "gov_id",
    groupLabel: "Government IDs",
    label: "GSTIN",
    description: "GST identification numbers.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    patterns: [/gstin/i, /\bgst\b/i]
  },
  {
    id: "ssn",
    group: "gov_id",
    groupLabel: "Government IDs",
    label: "SSN / social security",
    description: "Social-security-style identifiers.",
    source: "dom",
    level: "sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    patterns: [/\bssn\b/i, /social\s*security/i]
  },
  {
    id: "faces_people",
    group: "visual",
    groupLabel: "Visual / pixels",
    label: "Faces / people in photos",
    description: "Treat YOLOS 'person' boxes as potentially sensitive. Not a dedicated face model.",
    source: "vision",
    level: "potentially_sensitive",
    defaultEnabled: true
  },
  {
    id: "image_embedded_text",
    group: "visual",
    groupLabel: "Visual / pixels",
    label: "Text inside images",
    description: "OCR text found in screenshots or <img> pixels.",
    source: "ocr",
    level: "potentially_sensitive",
    defaultEnabled: true
  },
  {
    id: "canvas_text",
    group: "visual",
    groupLabel: "Visual / pixels",
    label: "Text painted on canvas",
    description: "OCR text when the page has a <canvas>.",
    source: "ocr",
    level: "potentially_sensitive",
    defaultEnabled: true
  }
];

function defaultSensitivityPolicy() {
  var policy = {};
  SENSITIVITY_CATEGORIES.forEach(function (category) {
    policy[category.id] = category.defaultEnabled !== false;
  });
  return policy;
}

function normalizeSensitivityPolicy(policy) {
  var defaults = defaultSensitivityPolicy();
  if (!policy || typeof policy !== "object") {
    return defaults;
  }
  var out = {};
  SENSITIVITY_CATEGORIES.forEach(function (category) {
    out[category.id] = Object.prototype.hasOwnProperty.call(policy, category.id)
      ? Boolean(policy[category.id])
      : defaults[category.id];
  });
  return out;
}

function groupedSensitivityCategories() {
  var groups = [];
  var index = {};
  SENSITIVITY_CATEGORIES.forEach(function (category) {
    if (!index[category.group]) {
      index[category.group] = {
        id: category.group,
        label: category.groupLabel,
        items: []
      };
      groups.push(index[category.group]);
    }
    index[category.group].items.push(category);
  });
  return groups;
}

BrowserAgent.SENSITIVITY_STORAGE_KEY = SENSITIVITY_STORAGE_KEY;
BrowserAgent.SENSITIVITY_CATEGORIES = SENSITIVITY_CATEGORIES;
BrowserAgent.defaultSensitivityPolicy = defaultSensitivityPolicy;
BrowserAgent.normalizeSensitivityPolicy = normalizeSensitivityPolicy;
BrowserAgent.groupedSensitivityCategories = groupedSensitivityCategories;

globalThis.BrowserAgent = BrowserAgent;
