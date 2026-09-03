/**
 * Word-sense checks for the keyword layer.
 *
 * The corpus measures whether a whole page comes out right. These pin the one
 * decision that produced every false positive the corpus ever reported: what
 * the bare word "address" means in context. An email address, an IP address
 * and "address your complaint to us" are not postal, and the original
 * /address/i flagged all three.
 *
 * Patterns are exercised directly rather than through classifySensitivity, so
 * a failure here points at the catalog and not at extraction. That also means
 * fieldOnly gating and input-type matching are deliberately not applied: this
 * asks only "does the wording match", which is the part that was wrong.
 */

/** Category ids whose keyword patterns match a string. */
function keywordHits(BA, text) {
  return BA.SENSITIVITY_CATEGORIES.filter((category) =>
    (category.patterns || []).some((pattern) => pattern.test(text))
  ).map((category) => category.id);
}

export function run(BA, t) {
  const hits = (text) => keywordHits(BA, text);
  const hasAddress = (text) => hits(text).includes("address");

  // --- the false positives that motivated the change -----------------
  t.eq("email address is not postal", hasAddress("Email address"), false);
  t.eq("email address is still email", hits("Email address").includes("email"), true);
  t.eq("ip address is not postal", hasAddress("Your IP address is recorded"), false);
  t.eq("mac address is not postal", hasAddress("MAC address"), false);
  t.eq("web address is not postal", hasAddress("Web address"), false);
  t.eq("wallet address is not postal", hasAddress("Wallet address"), false);
  t.eq(
    "address as a verb is not postal",
    hasAddress("Please address your complaint to the ombudsman"),
    false
  );
  t.eq("addressed to is not postal", hasAddress("The letter was addressed to me"), false);

  // --- and the recall that had to survive it -------------------------
  t.eq("bare address label is postal", hasAddress("Address"), true);
  t.eq("bare address label with id prefix", hasAddress("addr Address"), true);
  t.eq("street address is postal", hasAddress("Street address"), true);
  t.eq("billing address is postal", hasAddress("Billing address"), true);
  t.eq("address line 1 is postal", hasAddress("Address line 1"), true);
  t.eq("attribute style address-line1", hasAddress("address-line1"), true);
  t.eq("pin code is postal", hasAddress("PIN code"), true);
  t.eq("pincode is postal", hasAddress("pincode"), true);
  t.eq("postal code is postal", hasAddress("Postal code"), true);
  t.eq("zip is postal", hasAddress("Zip"), true);

  // A bare "postal" used to match on its own, which made a paragraph in
  // keyword-noise.html flag itself for describing the category.
  t.eq("bare postal is not enough", hasAddress("a postal flag on either"), false);
  t.eq("zip file is not postal", hasAddress("Download the zip file"), false);

  // --- Hindi ---------------------------------------------------------
  t.eq("aadhaar label in hindi", hits("आधार संख्या").includes("aadhaar"), true);
  t.eq("email label in hindi", hits("ईमेल").includes("email"), true);
  t.eq("mobile label in hindi", hits("मोबाइल").includes("phone"), true);
  t.eq("phone label in hindi without nukta", hits("फोन").includes("phone"), true);
  t.eq("phone label in hindi with nukta", hits("फ़ोन").includes("phone"), true);
  t.eq("password label in hindi", hits("पासवर्ड").includes("password"), true);
  t.eq("dob label in hindi", hits("जन्म तिथि").includes("date_of_birth"), true);
  t.eq("postal address in hindi", hits("डाक पता").includes("address"), true);
  t.eq("card number in hindi", hits("कार्ड संख्या").includes("payment_card"), true);
  t.eq("bank account in hindi", hits("खाता संख्या").includes("bank_account"), true);
  t.eq("full name in hindi", hits("पूरा नाम").includes("person_name"), true);

  // पता also means "to know". The same disambiguation the English side got.
  t.eq("hindi to-know sense is not postal", hasAddress("मुझे पता नहीं"), false);
  t.eq("hindi to-know sense present tense", hasAddress("पता है"), false);

  // नाम is a substring of उपयोगकर्ता नाम, so it must not stand alone.
  t.eq(
    "hindi username is not a person name",
    hits("उपयोगकर्ता नाम").includes("person_name"),
    false
  );
  t.eq("hindi username is a username", hits("उपयोगकर्ता नाम").includes("username"), true);
}
