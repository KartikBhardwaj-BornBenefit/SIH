/**
 * Unit checks for the identifier validators.
 *
 * These are the arithmetic guarantees the corpus scores depend on. If a
 * checksum implementation breaks, corpus precision collapses in a way that is
 * hard to read; these fail loudly instead.
 *
 * Reference values are public test constants: 4111111111111111 is the standard
 * Visa test number, 27AAPFU0939F1ZV a well-formed GSTIN. Aadhaar numbers here
 * are constructed to satisfy or fail Verhoeff and belong to nobody.
 */
export function run(BA, t) {
  const V = BA.validators;
  const policy = BA.defaultSensitivityPolicy();

  // --- checksums -----------------------------------------------------
  t.eq("verhoeff accepts valid", V.verhoeffValid("234567890124"), true);
  t.eq("verhoeff rejects one digit off", V.verhoeffValid("234567890123"), false);
  t.eq("aadhaar rejects leading 1", V.aadhaarValid("123456789012"), false);
  t.eq("aadhaar accepts valid", V.aadhaarValid("789012345674"), true);
  t.eq("luhn accepts visa test number", V.luhnValid("4111111111111111"), true);
  t.eq("luhn rejects corrupted", V.luhnValid("4111111111111112"), false);
  t.eq("card rejects too short", V.cardValid("411111111111"), false);
  t.eq("gstin accepts valid", V.gstinValid("27AAPFU0939F1ZV"), true);
  t.eq("gstin rejects bad check char", V.gstinValid("27AAPFU0939F1ZA"), false);
  t.eq("gstin rejects bad state code", V.gstinValid("99AAPFU0939F1ZV"), false);
  t.eq("pan accepts valid entity char", V.panValid("AAPFU0939F"), true);
  t.eq("pan rejects bad entity char", V.panValid("AAPZU0939F"), false);
  t.eq("ifsc accepts valid", V.ifscValid("SBIN0000691"), true);
  t.eq("ifsc rejects missing fixed zero", V.ifscValid("HDFC1001234"), false);

  // --- scanning ------------------------------------------------------
  const blob =
    "Contact kartik@example.com or pay to kartik@paytm. " +
    "Aadhaar 2345 6789 0124. Card 4111 1111 1111 1111. " +
    "Phone +91 98765 43210. PAN AAPFU0939F. " +
    "IFSC HDFC0001234. GSTIN 27AAPFU0939F1ZV.";

  t.eq(
    "mixed blob finds every identifier",
    V.findValues(blob, policy, {}).map((f) => f.category).sort(),
    ["aadhaar", "bank_account", "email", "gstin", "pan", "payment_card", "phone", "upi"]
  );
  t.eq(
    "checksum-invalid aadhaar is ignored",
    V.findValues("Aadhaar 2345 6789 0123 on file.", policy, {}).length,
    0
  );
  t.eq(
    "email is not also reported as upi",
    V.findValues("mail me at user@gmail.com", policy, {}).map((f) => f.category),
    ["email"]
  );
  t.eq(
    "bare handle is upi",
    V.findValues("send to kartik@oksbi", policy, {}).map((f) => f.category),
    ["upi"]
  );
  t.eq(
    "handle at end of sentence still matches",
    V.findValues("pay kartik@paytm.", policy, {}).map((f) => f.category),
    ["upi"]
  );
  t.eq(
    "card outranks the aadhaar-shaped run inside it",
    V.findValues("4111 1111 1111 1111", policy, {}).map((f) => f.category),
    ["payment_card"]
  );
  t.eq(
    "synthetic JWT-shaped token is treated as an authentication secret",
    V.findValues(
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vLXVzZXIifQ.synthetic_signature",
      policy,
      {}
    ).map((f) => f.category),
    ["authentication_secret"]
  );
  t.eq(
    "labelled access token is treated as an authentication secret",
    V.findValues("access_token=synthetic_demo_token_123", policy, {}).map((f) => f.category),
    ["authentication_secret"]
  );
  t.eq(
    "labelled credentials in prose are one-way categories",
    V.findValues("password: syntheticSecret OTP is 123456 CVV=123", policy, {}).map(
      (f) => f.category
    ).sort(),
    ["cvv", "otp", "password"]
  );
  t.eq(
    "landline is not a mobile",
    V.findValues("call 0224 5678901", policy, {}).length,
    0
  );

  // --- corroboration gate for weak shapes ----------------------------
  t.eq("voter id alone is not enough", V.findValues("ABC1234567", policy, {}).length, 0);
  t.eq(
    "voter id with a nearby keyword",
    V.findValues("ABC1234567", policy, { corroborationText: "voter id" }).map((f) => f.category),
    ["voter_id"]
  );
  t.eq(
    "passport with a nearby keyword",
    V.findValues("A1234567", policy, { corroborationText: "passport number" }).map((f) => f.category),
    ["passport"]
  );

  // --- policy gating -------------------------------------------------
  t.eq(
    "a disabled category is never scanned",
    V.findValues("Aadhaar 2345 6789 0124", { ...policy, aadhaar: false }).length,
    0
  );

  // --- privacy contract ----------------------------------------------
  const control = V.scanControlValue("234567890124", policy, "aadhaar");
  t.eq("control scan reports the category", control.map((c) => c.category), ["aadhaar"]);
  t.eq("control scan omits offsets", Object.keys(control[0]).sort(), ["category", "confidence"]);
  t.eq(
    "validator output carries no matched value",
    /kartik|4111|234567890124|AAPFU/.test(JSON.stringify(V.findValues(blob, policy, {}))),
    false
  );
}
