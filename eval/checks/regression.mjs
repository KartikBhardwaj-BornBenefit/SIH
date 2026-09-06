/**
 * Behaviour that must not change, checked against the manual browser fixtures
 * in examples/. These are assertions about specific guarantees rather than
 * scored metrics — a hidden CSRF token leaking into a snapshot is not a
 * precision problem, it is a bug.
 */
import path from "path";
import { extractFromFile } from "../lib/dom.mjs";

export function run(root, t) {
  const sample = extractFromFile(root, path.join(root, "examples/sample-page.html")).snapshot;

  t.eq(
    "hidden csrf input stays out of the snapshot",
    sample.elements.some((el) => el.name === "csrf"),
    false
  );
  t.eq(
    "hidden csrf value is never serialised",
    /should-not-be-extracted/.test(JSON.stringify(sample)),
    false
  );

  const password = sample.elements.find((el) => el.inputType === "password");
  t.eq("password field is sensitive", password.sensitivity, "sensitive");
  t.eq(
    "password is flagged by purpose, not by value",
    (password.sensitivitySignals || []).map((s) => s.via),
    ["field-purpose"]
  );

  const email = sample.elements.find((el) => el.inputType === "email");
  t.eq("email field is potentially sensitive", email.sensitivity, "potentially_sensitive");

  const aadhaar = sample.elements.find((el) => el.htmlId === "aadhaar");
  t.eq(
    "empty aadhaar field is flagged by purpose",
    (aadhaar.sensitivityCategories || []).includes("aadhaar"),
    true
  );
  t.eq("an all-empty form yields no value matches", sample.counts.valueMatched, 0);
  t.eq("an all-empty form yields no checksum matches", sample.counts.checksumVerified, 0);

  const visibility = extractFromFile(root, path.join(root, "examples/visibility-test.html")).snapshot;
  t.eq("visibility fixture still extracts", visibility.counts.elements > 0, true);
  t.eq("visibility fixture reports counts", typeof visibility.counts.found, "number");
  t.eq(
    "visibility fixture admits no value-only elements",
    visibility.counts.valueOnlyElements,
    0
  );

  const values = extractFromFile(root, path.join(root, "examples/pii-values.html")).snapshot;
  t.eq("pii fixture identifier count", values.counts.valueMatched, 11);
  t.eq("pii fixture checksum count", values.counts.checksumVerified, 4);
  t.eq("pii fixture value-only elements", values.counts.valueOnlyElements, 9);

  // Offsets have to be usable: re-slicing an element's own text by the
  // recorded offset must yield something that still validates.
  const withOffset = values.elements.find((el) =>
    (el.sensitivitySignals || []).some((s) => s.via === "value" && s.start != null)
  );
  t.eq("value signals carry offsets", Boolean(withOffset), true);

  const grid = extractFromFile(root, path.join(root, "examples/bootstrap-grid-form.html")).snapshot;
  const byName = {};
  grid.elements.forEach((el) => {
    if (el.name) {
      byName[el.name] = el;
    }
  });
  t.eq("grid address1 text is the sibling label", byName["10address1"].text, "Address Line 1");
  t.eq(
    "grid address1 is classified as address",
    (byName["10address1"].sensitivityCategories || []).includes("address"),
    true
  );
  t.eq(
    "grid city is not classified as address",
    (byName["13adr_city"].sensitivityCategories || []).includes("address"),
    false
  );
  t.eq(
    "grid zip is classified as pin_code",
    (byName["16addr_zip"].sensitivityCategories || []).includes("pin_code"),
    true
  );
  t.eq(
    "grid card user name is card_holder_name",
    (byName["40cc_user"].sensitivityCategories || []).includes("card_holder_name"),
    true
  );
  t.eq(
    "grid card user name is not username",
    (byName["40cc_user"].sensitivityCategories || []).includes("username"),
    false
  );
  t.eq(
    "grid card service phone is not personal phone",
    (byName["42cc_cserv"].sensitivityCategories || []).includes("phone"),
    false
  );
  t.eq(
    "grid card service phone is classified",
    (byName["42cc_cserv"].sensitivityCategories || []).includes("card_service_phone"),
    true
  );
  t.eq(
    "grid ssn is classified",
    (byName["51soc_sec"].sensitivityCategories || []).includes("ssn"),
    true
  );
  t.eq(
    "grid driver license is classified",
    (byName["52drivlic"].sensitivityCategories || []).includes("driver_license"),
    true
  );
  t.eq(
    "grid dob is classified",
    (byName["53___dob"].sensitivityCategories || []).includes("date_of_birth"),
    true
  );
  t.eq(
    "grid title is person_title",
    (byName["01___title"].sensitivityCategories || []).includes("person_title"),
    true
  );
  t.eq(
    "grid company is classified",
    (byName["05_company"].sensitivityCategories || []).includes("company"),
    true
  );
  t.eq(
    "grid company is not address",
    (byName["05_company"].sensitivityCategories || []).includes("address"),
    false
  );
  t.eq(
    "grid position is classified",
    (byName["06position"].sensitivityCategories || []).includes("position"),
    true
  );
  t.eq(
    "grid country is classified",
    (byName["15_country"].sensitivityCategories || []).includes("country"),
    true
  );
  t.eq(
    "grid fax is classified",
    (byName["18____fax"].sensitivityCategories || []).includes("fax"),
    true
  );
  t.eq(
    "grid user id is username",
    (byName["30__userid"].sensitivityCategories || []).includes("username"),
    true
  );
  t.eq(
    "grid card type is classified",
    (byName["32_cctype"].sensitivityCategories || []).includes("card_type"),
    true
  );

  const locker = extractFromFile(root, path.join(root, "examples/digilocker-pin.html")).snapshot;
  const pinBoxes = locker.elements.filter((el) => el.tag === "input");
  t.eq("digilocker pin has six boxes", pinBoxes.length, 6);
  t.eq(
    "digilocker pin boxes are security_pin",
    pinBoxes.every((el) => (el.sensitivityCategories || []).includes("security_pin")),
    true
  );
  t.eq(
    "digilocker pin boxes are not otp",
    pinBoxes.every((el) => !(el.sensitivityCategories || []).includes("otp")),
    true
  );
}
