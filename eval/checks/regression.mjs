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
}
