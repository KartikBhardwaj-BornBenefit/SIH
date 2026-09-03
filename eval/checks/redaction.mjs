/**
 * The safe-snapshot contract.
 *
 * The central assertion is negative and mechanical: take every value in the
 * vault, serialise the agentContext, and require that none of them appears.
 * That is the property the whole phase exists to provide, so it is checked
 * against real corpus pages rather than a hand-built object.
 */
import fs from "fs";
import path from "path";
import { extractFromFile, contentScriptFiles } from "../lib/dom.mjs";

/** Pages with enough variety to exercise text, control values, and credentials. */
const PAGES = [
  "eval/corpus/gov-portal-profile.html",
  "eval/corpus/obfuscated-spa.html",
  "eval/corpus/social-profile.html",
  "eval/corpus/checkout-filled.html",
  "eval/corpus/login-simple.html",
  "eval/corpus/table-records.html",
  "examples/pii-values.html"
];

export function run(root, t) {
  // The redaction module must actually be injected in production, not just
  // exist on disk. This is the kind of thing that silently breaks.
  t.eq(
    "redaction.js is in the injected script list",
    contentScriptFiles(root).includes("src/content/redaction.js"),
    true
  );

  let totalVaulted = 0;
  let totalOneWay = 0;

  for (const page of PAGES) {
    const { agent, snapshot } = extractFromFile(root, path.join(root, page));
    const safe = agent.redaction.build(snapshot, null);
    const serialized = JSON.stringify(safe.agentContext);
    const values = Object.values(safe.vault);
    const name = path.basename(page);

    totalVaulted += values.length;
    totalOneWay += safe.redaction.records.filter((r) => r.oneWay).length;

    // The contract.
    const leaked = values.filter((value) => serialized.includes(value));
    t.eq(`${name}: no vaulted value appears in agentContext`, leaked, []);

    // Placeholders must actually be present, otherwise "no leak" is trivially
    // satisfied by an empty snapshot.
    const placeholders = Object.keys(safe.vault);
    const missing = placeholders.filter(
      (p) => !serialized.includes(p) && !safe.redaction.records.some((r) => r.placeholder === p && r.field === "value")
    );
    t.eq(`${name}: every placeholder is reachable`, missing, []);

    t.eq(`${name}: agentContext is marked redacted`, safe.agentContext.redacted, true);

    // Credentials get a placeholder but no way back.
    for (const record of safe.redaction.records) {
      if (record.oneWay) {
        t.eq(
          `${name}: ${record.category} is not recoverable`,
          Object.prototype.hasOwnProperty.call(safe.vault, record.placeholder),
          false
        );
      }
    }
  }

  t.eq("corpus produced recoverable placeholders", totalVaulted > 0, true);
  t.eq("corpus produced one-way credential placeholders", totalOneWay > 0, true);

  // --- specific behaviours -------------------------------------------
  const gov = extractFromFile(root, path.join(root, "eval/corpus/gov-portal-profile.html"));
  const govSafe = gov.agent.redaction.build(gov.snapshot, null);
  const govText = JSON.stringify(govSafe.agentContext);

  t.eq("aadhaar value is replaced", /789012345674|7890 1234 5674/.test(govText), false);
  t.eq("aadhaar placeholder is present", govText.includes("<AADHAAR_1>"), true);
  t.eq("pan placeholder is present", govText.includes("<PAN_1>"), true);
  t.eq(
    "a weak shape detected earlier is still located and replaced",
    govText.includes("<VOTER_ID_1>"),
    true
  );
  t.eq("voter id value is gone", govText.includes("ABC1234567"), false);

  // The same value in two places must reuse one placeholder, so an agent can
  // tell it is one entity.
  const dupHtml = `<!doctype html><html><body>
    <p id="a">Write to asha.menon@example.com today.</p>
    <p id="b">Confirmation goes to asha.menon@example.com as well.</p>
    <p id="c">Second contact is r.iyer@company.co.in.</p>
  </body></html>`;
  const dupPath = path.join(root, "eval", ".tmp-dup.html");
  fs.writeFileSync(dupPath, dupHtml);
  try {
    const dup = extractFromFile(root, dupPath);
    const dupSafe = dup.agent.redaction.build(dup.snapshot, null);
    t.eq(
      "one value gets one placeholder however often it appears",
      Object.keys(dupSafe.vault).sort(),
      ["<EMAIL_1>", "<EMAIL_2>"]
    );
    const dupText = JSON.stringify(dupSafe.agentContext);
    t.eq("the repeated value reuses its placeholder", (dupText.match(/<EMAIL_1>/g) || []).length, 2);
  } finally {
    fs.unlinkSync(dupPath);
  }

  // A control's `text` is its label, so an identifier written into a label
  // lands in the input's record too. Both copies must be replaced.
  const labelHtml = `<!doctype html><html><body>
    <form>
      <label id="lbl" for="fld">Voter ID ABC1234567</label>
      <input id="fld" name="q_1" type="text">
    </form>
  </body></html>`;
  const labelPath = path.join(root, "eval", ".tmp-label.html");
  fs.writeFileSync(labelPath, labelHtml);
  try {
    const carried = extractFromFile(root, labelPath);
    const carriedSafe = carried.agent.redaction.build(carried.snapshot, null);
    const carriedText = JSON.stringify(carriedSafe.agentContext);
    t.eq("a value carried into a label is replaced everywhere", carriedText.includes("ABC1234567"), false);
    t.eq("both copies point at one placeholder", (carriedText.match(/<VOTER_ID_1>/g) || []).length, 2);
  } finally {
    fs.unlinkSync(labelPath);
  }

  // De-referencing writes a vaulted value back without handing it out.
  const spa = extractFromFile(root, path.join(root, "eval/corpus/obfuscated-spa.html"));
  const spaSafe = spa.agent.redaction.build(spa.snapshot, null);
  const target = spa.snapshot.elements.find((el) => el.htmlId === "o-f5");
  const placeholder = Object.keys(spaSafe.vault)[0];

  const filled = spa.agent.redaction.fillFromVault(spaSafe.vault, target.id, placeholder);
  t.eq("de-reference reports success", filled.ok, true);
  t.eq(
    "de-reference wrote the real value into the page",
    spa.window.document.getElementById("o-f5").value,
    spaSafe.vault[placeholder]
  );

  t.eq(
    "de-reference refuses an unknown placeholder",
    spa.agent.redaction.fillFromVault(spaSafe.vault, target.id, "<EMAIL_999>").ok,
    false
  );
  t.eq(
    "de-reference refuses a missing element",
    spa.agent.redaction.fillFromVault(spaSafe.vault, "element_99999", placeholder).ok,
    false
  );
  t.eq(
    "de-reference refuses an element that cannot take text",
    spa.agent.redaction.fillFromVault(
      spaSafe.vault,
      spa.snapshot.elements.find((el) => el.tag === "button").id,
      placeholder
    ).ok,
    false
  );
}
