/**
 * Checks for the NER layer.
 *
 * The model itself cannot run here — it needs a browser runtime and a 65 MB
 * download — but almost none of the risk lives in the model. It lives in the
 * code around it: grouping subword tokens into spans, chunking text without
 * losing the tail, and splicing placeholders into strings without corrupting
 * the offsets of the ones already there.
 *
 * All of that is pure, so all of it is tested here against fixtures. What is
 * left for a browser is "does the checkpoint find names", which is what the
 * --ner corpus mode measures.
 */
import path from "path";
import { groupEntities, categoryForLabel, MIN_SCORE } from "../../src/nlp/entities.js";
import { chunkText, mergeEntities, MAX_CHUNK_CHARS, packTexts, unpackEntities } from "../../src/nlp/chunk.js";
import { extractFromFile } from "../lib/dom.mjs";

/** Build a raw token as the pipeline emits them. */
function tok(entity, word, start, end, score = 0.99) {
  return { entity, word, start, end, score, index: start };
}

function categories(groups) {
  return groups.map((g) => g.category + ":" + g.text);
}

export function run(root, t) {
  /* -------------------------------------------------------------- *
   * Label mapping
   * -------------------------------------------------------------- */
  t.eq("PER maps to person_name", categoryForLabel("PER"), "person_name");
  t.eq("B- prefix is not part of the label", categoryForLabel("B-PER"), null);
  // The deliberate omissions. CoNLL LOC fires on any place name in prose, so
  // mapping it to `address` would flag "the Bengaluru office" as somebody's
  // address and cost far more precision than it buys recall.
  t.eq("LOC is deliberately unmapped", categoryForLabel("LOC"), null);
  t.eq("ORG is deliberately unmapped", categoryForLabel("ORG"), null);
  t.eq("MISC is deliberately unmapped", categoryForLabel("MISC"), null);

  /* -------------------------------------------------------------- *
   * Grouping raw tokens
   * -------------------------------------------------------------- */
  const text = "Please route it to Priya Sharma before Friday.";
  t.eq(
    "two tokens group into one person",
    categories(
      groupEntities([tok("B-PER", "Priya", 19, 24), tok("I-PER", "Sharma", 25, 31)], text)
    ),
    ["person_name:Priya Sharma"]
  );

  // The case that makes B- meaningful: two people with no O token between.
  const pair = "Priya Sharma Vikram Iyer";
  t.eq(
    "a second B- starts a second person",
    categories(
      groupEntities(
        [
          tok("B-PER", "Priya", 0, 5),
          tok("I-PER", "Sharma", 6, 12),
          tok("B-PER", "Vikram", 13, 19),
          tok("I-PER", "Iyer", 20, 24)
        ],
        pair
      )
    ),
    ["person_name:Priya Sharma", "person_name:Vikram Iyer"]
  );

  t.eq(
    "an O token closes a group",
    categories(
      groupEntities(
        [tok("B-PER", "Priya", 0, 5), tok("O", "and", 6, 9), tok("B-PER", "Vikram", 10, 16)],
        "Priya and Vikram"
      )
    ),
    ["person_name:Priya", "person_name:Vikram"]
  );

  t.eq(
    "unmapped labels produce nothing",
    groupEntities([tok("B-ORG", "Reliance", 0, 8)], "Reliance Industries").length,
    0
  );

  // A group is only as trustworthy as its weakest token, so one shaky
  // subword drags the whole span below the threshold.
  t.eq(
    "the weakest token sets the group score",
    groupEntities(
      [tok("B-PER", "Priya", 0, 5, 0.99), tok("I-PER", "Sharma", 6, 12, 0.4)],
      "Priya Sharma"
    ).length,
    0
  );
  t.eq(
    "a confident group survives",
    groupEntities(
      [tok("B-PER", "Priya", 0, 5, 0.99), tok("I-PER", "Sharma", 6, 12, 0.95)],
      "Priya Sharma"
    ).length,
    1
  );
  t.eq("threshold is high on purpose", MIN_SCORE >= 0.9, true);

  // Without offsets a span cannot be reconstructed, because subword pieces do
  // not concatenate back to the source text. Guessing would be worse.
  t.eq(
    "tokens without offsets are dropped",
    groupEntities(
      [{ entity: "B-PER", word: "Priya", score: 0.99, start: null, end: null }],
      "Priya Sharma"
    ).length,
    0
  );

  // The rule pass runs first, so the model sees its placeholders. It must not
  // "find" an entity inside a token we invented.
  t.eq(
    "entities inside a placeholder are ignored",
    groupEntities(
      [tok("B-PER", "AADHAAR", 11, 21)],
      "Reference: <AADHAAR_1> was submitted"
    ).length,
    0
  );
  t.eq(
    "a real name beside a placeholder still counts",
    categories(
      groupEntities(
        [tok("B-PER", "Priya", 0, 5), tok("I-PER", "Sharma", 6, 12)],
        "Priya Sharma sent <AADHAAR_1>"
      )
    ),
    ["person_name:Priya Sharma"]
  );

  /* -------------------------------------------------------------- *
   * Chunking
   * -------------------------------------------------------------- */
  t.eq("short text is one chunk", chunkText("hello there").length, 1);
  t.eq("empty text is no chunks", chunkText("").length, 0);
  t.eq("null text is no chunks", chunkText(null).length, 0);

  const long = ("word ".repeat(1200)).trim();
  const chunks = chunkText(long);
  t.eq("long text is split", chunks.length > 1, true);
  t.eq(
    "every chunk is within budget",
    chunks.every((c) => c.text.length <= MAX_CHUNK_CHARS),
    true
  );
  t.eq(
    "offsets locate each chunk in the original",
    chunks.every((c) => long.slice(c.offset, c.offset + c.text.length) === c.text),
    true
  );
  // The tail is the whole point: BERT would silently truncate it.
  t.eq(
    "the final chunk reaches the end",
    chunks[chunks.length - 1].offset + chunks[chunks.length - 1].text.length,
    long.length
  );
  t.eq(
    "chunks overlap so a boundary name is seen whole",
    chunks.length < 2 || chunks[1].offset < chunks[0].text.length,
    true
  );
  // A pathological overlap must not loop forever.
  t.eq(
    "progress is guaranteed when overlap exceeds the window",
    chunkText("a".repeat(500), { maxChars: 100, overlap: 500 }).length >= 5,
    true
  );

  /* -------------------------------------------------------------- *
   * Merging across chunks
   * -------------------------------------------------------------- */
  const dupes = [
    { category: "person_name", start: 10, length: 12, score: 0.91 },
    { category: "person_name", start: 10, length: 12, score: 0.99 }
  ];
  t.eq("identical spans collapse", mergeEntities(dupes).length, 1);
  t.eq("the better score wins", mergeEntities(dupes)[0].score, 0.99);

  t.eq(
    "a contained span is dropped in favour of the longer one",
    mergeEntities([
      { category: "person_name", start: 0, length: 12, score: 0.95 },
      { category: "person_name", start: 6, length: 6, score: 0.97 }
    ]).length,
    1
  );
  t.eq(
    "distinct spans both survive",
    mergeEntities([
      { category: "person_name", start: 0, length: 12, score: 0.95 },
      { category: "person_name", start: 20, length: 11, score: 0.97 }
    ]).length,
    2
  );

  /* -------------------------------------------------------------- *
   * Packing short strings into one forward pass
   * -------------------------------------------------------------- */
  const packed = packTexts([
    { key: "a", text: "Hello Priya Sharma" },
    { key: "b", text: "and Vikram Iyer" }
  ]);
  t.eq("two short strings become one pack", packed.length, 1);
  t.eq(
    "offsets locate each member in the pack",
    packed[0].text.slice(packed[0].members[0].start, packed[0].members[0].start + packed[0].members[0].length),
    "Hello Priya Sharma"
  );

  const priyaStart = packed[0].text.indexOf("Priya Sharma");
  t.eq(
    "an entity maps back to its original key and offset",
    unpackEntities(
      [{ category: "person_name", start: priyaStart, length: 12, score: 0.99, text: "Priya Sharma" }],
      packed[0].members
    ),
    [
      {
        key: "a",
        entities: [
          { category: "person_name", start: 6, length: 12, score: 0.99, text: "Priya Sharma" }
        ]
      }
    ]
  );
  t.eq(
    "an entity on the separator is dropped, not assigned to a neighbour",
    unpackEntities(
      [{ category: "person_name", start: packed[0].members[0].length, length: 2, score: 0.99 }],
      packed[0].members
    ).length,
    0
  );

  /* -------------------------------------------------------------- *
   * applyEntities, against a real page
   *
   * Uses synthetic spans rather than the model, so this tests the splicing
   * and vault bookkeeping without a download. The spans are located in the
   * real rule-redacted strings, so the offsets are genuine.
   * -------------------------------------------------------------- */
  const { window, snapshot } = extractFromFile(
    root,
    path.join(root, "eval/corpus/unstructured-names.html")
  );
  const BA = window.BrowserAgent;
  const policy = BA.defaultSensitivityPolicy();

  const safe = BA.redaction.build(snapshot, policy);
  const texts = BA.redaction.textsForModel(safe.agentContext);
  t.eq("there is text to scan", texts.length > 0, true);
  t.eq(
    "href and src are not sent to the model",
    texts.every((item) => !item.key.endsWith(".href") && !item.key.endsWith(".src")),
    true
  );
  t.eq(
    "the fixture name is still in the filtered set",
    texts.some((item) => item.text.includes("Priya Sharma")),
    true
  );

  /** Fake the model: find a literal name and return it as a PER span. */
  function spansFor(name) {
    const out = [];
    for (const item of texts) {
      const at = item.text.indexOf(name);
      if (at !== -1) {
        out.push({
          key: item.key,
          entities: [
            {
              label: "PER",
              category: "person_name",
              score: 0.98,
              start: at,
              length: name.length,
              text: name
            }
          ]
        });
      }
    }
    return out;
  }

  const priya = spansFor("Priya Sharma");
  t.eq("the fixture contains the name", priya.length > 0, true);

  const applied = BA.redaction.applyEntities(
    safe.agentContext,
    priya,
    policy,
    safe.minter
  );
  const serialised = JSON.stringify(applied.agentContext);

  t.eq("the name is gone from the context", serialised.includes("Priya Sharma"), false);
  t.eq("a NAME placeholder took its place", /<NAME_\d+>/.test(serialised), true);
  t.eq(
    "the value is recoverable from the vault",
    Object.values(applied.vault).includes("Priya Sharma"),
    true
  );
  t.eq(
    "the redaction record keeps the model score",
    applied.redaction.records.some(
      (r) => r.category === "person_name" && r.confidence === "model" && r.score === 0.98
    ),
    true
  );
  t.eq(
    "the element carries a model signal",
    applied.agentContext.elements.some((el) =>
      (el.sensitivitySignals || []).some(
        (s) => s.category === "person_name" && s.confidence === "model"
      )
    ),
    true
  );
  // One value, one placeholder — across both passes, not just within one.
  const nameTokens = new Set(
    Object.entries(applied.vault)
      .filter(([, value]) => value === "Priya Sharma")
      .map(([token]) => token)
  );
  t.eq("one name maps to one placeholder", nameTokens.size, 1);

  // Turning the category off must skip the work, not redact anyway.
  const off = Object.assign({}, policy, { person_name: false });
  const fresh = extractFromFile(
    root,
    path.join(root, "eval/corpus/unstructured-names.html")
  );
  const freshBA = fresh.window.BrowserAgent;
  const safeOff = freshBA.redaction.build(fresh.snapshot, off);
  const appliedOff = freshBA.redaction.applyEntities(
    safeOff.agentContext,
    priya,
    off,
    safeOff.minter
  );
  t.eq(
    "a disabled category is not redacted",
    JSON.stringify(appliedOff.agentContext).includes("Priya Sharma"),
    true
  );
  t.eq(
    "a disabled category mints nothing",
    appliedOff.redaction.records.some((r) => r.category === "person_name"),
    false
  );
}
