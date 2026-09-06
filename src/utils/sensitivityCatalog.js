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
    patterns: [/password/i, /passwd/i, /पासवर्ड/, /कूटशब्द/]
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
    patterns: [/\botp\b/i, /one[-\s]?time/i, /one[-\s]?time[-\s]?code/i, /ओटीपी/, /एकबारीय/]
  },
  {
    id: "security_pin",
    group: "credentials",
    groupLabel: "Credentials",
    label: "DigiLocker security PIN",
    description: "Saved login PIN (DigiLocker / mPIN). Not an SMS OTP and not a postal PIN code.",
    source: "dom",
    level: "sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    patterns: [
      /security\s*pin/i,
      /6[\s-]?digit\s+(?:security\s+)?pin/i,
      /\b(?:m[\s-]?pin|mpin)\b/i,
      /digilocker.{0,32}\bpin\b/i,
      /(?:login|unlock|account)\s*pin/i
    ]
  },
  {
    id: "authentication_secret",
    group: "credentials",
    groupLabel: "Credentials",
    label: "Authentication / session secrets",
    description: "API keys, bearer tokens, access tokens and session identifiers.",
    source: "dom",
    level: "sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    patterns: [
      /api[-_\s]?key/i,
      /access[-_\s]?token/i,
      /auth(?:orization)?[-_\s]?token/i,
      /bearer[-_\s]?token/i,
      /session[-_\s]?(?:id|token)/i
    ]
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
    patterns: [
      /(?<!\bcard\s)user\s*name/i,
      /(?<!\bcard\s)username/i,
      /\buser\s*id\b/i,
      /(?:उपयोगकर्ता|प्रयोगकर्ता)\s*नाम/
    ]
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
    patterns: [
      /card\s*(number|no\.?|num)/i,
      /credit\s*card/i,
      /debit\s*card/i,
      /कार्ड\s*(?:संख्या|नंबर|नम्बर)/,
      /(?:क्रेडिट|डेबिट)\s*कार्ड/
    ]
  },
  {
    id: "card_type",
    group: "payments",
    groupLabel: "Payments & banking",
    label: "Credit card type",
    description: "Visa / Mastercard / Amex style card-type fields.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    autocomplete: ["cc-type"],
    patterns: [/(?:credit\s*)?card\s*type/i, /\bcc[-_]?type\b/i]
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
    patterns: [/\bcvv\b|\bcvc\b|\bcvv2\b/i, /security\s*code/i, /सीवीवी/]
  },
  {
    id: "card_holder_name",
    group: "payments",
    groupLabel: "Payments & banking",
    label: "Card user / holder name",
    description: "Name printed on a payment card.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    autocomplete: ["cc-name"],
    patterns: [
      /card\s*(?:user|holder)\s*name/i,
      /name\s*on\s*(?:the\s*)?card/i,
      /cardholder/i
    ]
  },
  {
    id: "card_issuing_bank",
    group: "payments",
    groupLabel: "Payments & banking",
    label: "Card issuing bank",
    description: "Bank that issued a payment card.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    patterns: [/card\s*issuing\s*bank/i, /issuing\s*bank/i]
  },
  {
    id: "card_service_phone",
    group: "payments",
    groupLabel: "Payments & banking",
    label: "Card customer service phone",
    description: "Issuer customer-service numbers on card forms.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    patterns: [/customer\s*service\s*phone/i, /card\s*customer\s*service/i]
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
    patterns: [
      /ifsc/i,
      /iban/i,
      /swift/i,
      /account\s*(number|no\.?)/i,
      /खाता\s*(?:संख्या|नंबर|नम्बर)/,
      /बैंक\s*खाता/,
      /आईएफएससी/
    ]
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
    patterns: [/\bupi\b/i, /यूपीआई/]
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
    patterns: [/e-?mail/i, /ई-?मेल/]
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
    // /फ़?ोन/ covers both फ़ोन and फोन: the nukta is a separate combining mark.
    patterns: [
      /(?<!\b(?:customer\s*service|service)\s+)phone/i,
      /mobile/i,
      /\btel\b/i,
      /whatsapp/i,
      /मोबाइल/,
      /फ़?ोन/,
      /दूरभाष/
    ]
  },
  {
    id: "fax",
    group: "contact",
    groupLabel: "Contact details",
    label: "Fax",
    description: "Fax number fields.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    patterns: [/\bfax\b/i, /[_-]fax\b/i]
  },
  {
    id: "website",
    group: "contact",
    groupLabel: "Contact details",
    label: "Website",
    description: "Personal or company website fields.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    inputTypes: ["url"],
    autocomplete: ["url"],
    patterns: [/web\s*site/i, /\bwebsite\b/i, /\bhomepage\b/i]
  },
  {
    id: "address",
    group: "contact",
    groupLabel: "Contact details",
    label: "Address",
    description: "Street address, city, locality, and landmark fields.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    autocomplete: [
      "street-address",
      "address-line1",
      "address-line2",
      "address-level1",
      "address-level2"
    ],
    // "address" is the most overloaded word in the catalog: an email address,
    // an IP address and "address your complaint to us" are all non-postal, and
    // a bare /address/i flagged all three. Qualified forms match outright; the
    // bare word carries lookarounds so the wrong senses are rejected in place
    // rather than vetoing the whole element. PIN / ZIP live in pin_code.
    patterns: [
      /\b(?:street|postal|mailing|billing|shipping|delivery|residential|permanent|correspondence|registered|home|office)\s+address\b/i,
      /\baddress\s*(?:line)?\s*[12]\b/i,
      // Digit-prefixed names such as RoboForm's 10address1 have no word
      // boundary before "address" (\d is a word character), so the spaced
      // "address line 1" pattern above never sees them.
      /address(?:[-_]?line)?[-_]?[12]\b/i,
      /(?<!\b(?:e-?mail|ip|mac|web|url|wallet|crypto)\s{0,2})\baddress\b(?!\s+(?:your|the|this|my|our|its|their|a|any|all|it|them|these|those)\b)/i,
      /\blocality\b/i,
      /\blandmark\b/i,
      // Hindi. Same split: qualified forms, then the bare word guarded against
      // the "पता है / पता नहीं" (to know) sense.
      /(?:डाक|पूरा|स्थायी|वर्तमान|निवास|पत्राचार)\s*पता/,
      /पता(?!\s*(?:है|हैं|नहीं|नही|चला|चल|लगा|लगाना|करें|कर|करना))/
    ]
  },
  {
    id: "pin_code",
    group: "contact",
    groupLabel: "Contact details",
    label: "PIN code",
    description: "Indian PIN, ZIP, and postal-code fields.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    autocomplete: ["postal-code"],
    patterns: [
      /\bpincode\b/i,
      /\bpin\s*code\b/i,
      /\bpostal\s*code\b/i,
      /\bzip\s*code\b/i,
      /\bzip\b(?!\s*(?:file|archive|folder|download|drive))/i,
      /पिन\s*कोड/
    ]
  },
  {
    id: "country",
    group: "contact",
    groupLabel: "Contact details",
    label: "Country",
    description: "Country fields on address forms.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    autocomplete: ["country", "country-name"],
    patterns: [/\bcountry\b/i]
  },
  {
    id: "person_name",
    group: "identity",
    groupLabel: "Personal identity",
    label: "Person name",
    description: "Name fields, plus names in English prose via the local NER model. Hindi names in running text are not covered by the current checkpoint.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    autocomplete: ["name", "given-name", "family-name"],
    // Bare नाम is deliberately absent: it is a substring of उपयोगकर्ता नाम
    // (username) and of ordinary prose, so only qualified forms count.
    patterns: [
      /first\s*name/i,
      /last\s*name/i,
      /full\s*name/i,
      /surname/i,
      /given\s*name/i,
      /(?:पूरा|पहला|अंतिम|प्रथम)\s*नाम/,
      /उपनाम/
    ]
  },
  {
    id: "person_title",
    group: "identity",
    groupLabel: "Personal identity",
    label: "Title (Mr/Ms)",
    description: "Honorific title fields such as Mr, Ms, or Dr. Not a job title.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    autocomplete: ["honorific-prefix"],
    patterns: [
      /(?<![A-Za-z])(?<!(?:job|page|document|post|working)\s)title\b/i,
      /\b(?:honorific|salutation)\b/i
    ]
  },
  {
    id: "middle_initial",
    group: "identity",
    groupLabel: "Personal identity",
    label: "Middle initial",
    description: "Middle name or middle-initial fields.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    autocomplete: ["additional-name"],
    patterns: [/middle\s*initial/i, /middle[-_\s]?name/i, /middle_i\b/i]
  },
  {
    id: "company",
    group: "identity",
    groupLabel: "Personal identity",
    label: "Company",
    description: "Employer or organization name fields.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    autocomplete: ["organization"],
    patterns: [
      /(?<![A-Za-z])company(?:\s*name)?\b(?!\.(?:co|com|org|net|io|in)\b)/i,
      /\b(?:employer|organi[sz]ation)\b/i
    ]
  },
  {
    id: "position",
    group: "identity",
    groupLabel: "Personal identity",
    label: "Position / job title",
    description: "Job title, position, and designation fields.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    autocomplete: ["organization-title"],
    patterns: [/(?<![A-Za-z])position\b/i, /\bjob\s*title\b/i, /\b(?:designation|occupation)\b/i]
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
    patterns: [
      /date\s*of\s*birth/i,
      /\bdob\b/i,
      /birthday/i,
      /जन्म\s*(?:तिथि|दिनांक)/,
      /जन्म\s*की\s*तारीख/
    ]
  },
  {
    id: "sex",
    group: "identity",
    groupLabel: "Personal identity",
    label: "Sex / gender",
    description: "Sex and gender fields.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    patterns: [/\b(?:sex|gender)\b/i]
  },
  {
    id: "age",
    group: "identity",
    groupLabel: "Personal identity",
    label: "Age",
    description: "Age fields.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    patterns: [/\bage\b/i]
  },
  {
    id: "birth_place",
    group: "identity",
    groupLabel: "Personal identity",
    label: "Birth place",
    description: "Place of birth fields.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    patterns: [/birth\s*place/i, /place\s*of\s*birth/i, /जन्म\s*स्थान/]
  },
  {
    id: "income",
    group: "identity",
    groupLabel: "Personal identity",
    label: "Income",
    description: "Income and salary fields.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    patterns: [/\bincome\b/i, /\bsalary\b/i]
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
    patterns: [/aadhaar/i, /aadhar/i, /uidai/i, /आधार/]
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
    patterns: [/\bpan\b/i, /permanent\s*account/i, /पैन/]
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
    patterns: [/passport/i, /पासपोर्ट/]
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
    patterns: [/voter/i, /ration\s*card/i, /मतदाता/, /राशन\s*कार्ड/]
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
    patterns: [/gstin/i, /\bgst\b/i, /जीएसटी/]
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
    id: "driver_license",
    group: "gov_id",
    groupLabel: "Government IDs",
    label: "Driver license",
    description: "Driver license number fields.",
    source: "dom",
    level: "sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    patterns: [/driver'?s?\s*licen[cs]e/i]
  },
  {
    id: "custom_message",
    group: "form_extras",
    groupLabel: "Other form fields",
    label: "Custom message",
    description: "Custom message fields on long test forms.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    patterns: [/custom\s*message/i]
  },
  {
    id: "comments",
    group: "form_extras",
    groupLabel: "Other form fields",
    label: "Comments",
    description: "Comments and notes fields.",
    source: "dom",
    level: "potentially_sensitive",
    defaultEnabled: true,
    fieldOnly: true,
    patterns: [/\bcomments?\b/i]
  },
  {
    id: "faces_people",
    group: "visual",
    groupLabel: "Visual / pixels",
    label: "Faces / people in photos",
    description: "Faces found by the compact local YuNet detector.",
    source: "vision",
    level: "potentially_sensitive",
    defaultEnabled: true
  },
  {
    id: "image_embedded_text",
    group: "visual",
    groupLabel: "Visual / pixels",
    label: "Text inside images",
    description: "Marks identifier values OCR reads inside screenshots or <img> pixels. Ordinary labels and slogans stay visible.",
    source: "ocr",
    level: "potentially_sensitive",
    defaultEnabled: true
  },
  {
    id: "canvas_text",
    group: "visual",
    groupLabel: "Visual / pixels",
    label: "Text painted on canvas",
    description: "Marks identifier values OCR reads on a <canvas>. Ordinary painted UI text stays visible.",
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
