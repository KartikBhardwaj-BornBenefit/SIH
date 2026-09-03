# Evaluation harness

```bash
npm run eval                    # unit checks, fixture regressions, corpus scoring
npm run eval -- --update        # accept current numbers as the new baseline
npm run eval -- --only=bank     # score only matching corpus pages
npm run eval -- --verbose       # per-page detail even when clean
```

Exits non-zero on a failed check, an unlabelled page, or a regression against
`baseline.json`.

## What this measures, and what it does not

**Measured:** extraction, field-purpose classification, and value-level
identifier detection — everything that turns a DOM into a snapshot.

**Not measured:** visibility. jsdom has no layout engine, so
`getBoundingClientRect` returns zeros and the visibility layer would reject
every element. `lib/dom.mjs` stubs a non-zero box, which means the three-tier
logic in `src/utils/visibility.js` is *bypassed rather than tested*. Visibility
stays covered by the manual browser fixtures in `examples/`. **Do not read a
passing eval run as evidence that visibility filtering works.**

Also not scored here: the YuNet, OCR, and **ONNX NER** layers. Those need a real
browser with WASM and, for NER, a first-run weight download. `checks/ner.mjs`
covers the code around the model (grouping, chunking, splicing placeholders)
using synthetic spans. Corpus scores therefore stay rule-only: names in prose
are expected misses here.

Keep the metric families separate:

- `npm run eval` reports per-category precision/recall/F1 for deterministic DOM and validator detection.
- `npm run test:safety` tests normalized OCR/vision metadata, outbound redaction gates and action refusal without loading weights.
- `npm run test:e2e` runs real YuNet and Tesseract inference, verifies creation of a sanitizer-branded image, then completes the mock-server demo.
- A labelled face/OCR pixel corpus is still required before reporting face precision/recall, OCR-derived PII F1, region IoU, over-redaction or sensitive-pixel coverage. The UI reports timings and mask counts, not invented accuracy.

## Layout

```text
eval/
├── run.mjs            orchestrator and CLI
├── baseline.json      committed metrics; the regression gate compares to this
├── lib/
│   ├── dom.mjs        jsdom loading, extractor injection
│   ├── score.mjs      prediction/label diffing and metrics
│   └── report.mjs     console tables, baseline comparison
├── checks/
│   ├── validators.mjs unit checks for the checksum and format validators
│   ├── keywords.mjs   word-sense checks for the catalog patterns
│   ├── regression.mjs assertions against the examples/ fixtures
│   ├── redaction.mjs  the safe-snapshot contract
│   └── ner.mjs        grouping, chunking, and applyEntities (no weight download)
├── corpus/*.html      synthetic pages
└── labels/*.json      ground truth, one file per page
```

The list of scripts to inject is **parsed out of
`src/background/serviceWorker.js`** rather than duplicated here, so the harness
cannot silently test a different set of files than the extension injects.

## The redaction contract

`checks/redaction.mjs` asserts the property Phase 5 exists to provide, and the
central check is mechanical: take every value in the vault, serialise the
`agentContext`, and require that none of them appears. It runs against real
corpus pages rather than a hand-built object, and it also verifies that
placeholders are actually present — otherwise "no leak" would be trivially
satisfied by an empty snapshot.

It additionally checks that credentials get a placeholder but no vault entry,
that one value maps to one placeholder however often it appears, that
`redaction.js` is really in the injected script list, and that de-referencing
refuses an unknown placeholder, a missing element, and an element that cannot
accept text.

Because redaction is scoped to what detection found, **the metrics below are
close to a measure of what leaks** — but they are not identical to one, and the
difference is worth knowing. Redaction re-scans the serialised strings rather
than trusting the signals attached to an element, so it can catch a value that
detection reported as absent. `inline-split-value.html` was exactly that case
for a while: the paragraph carried no signal, yet its text came out
placeholdered. Read a miss as "the agent was not told", and treat "the value
was still there in plain text" as something the redaction checks assert
separately.

## Word senses

`checks/keywords.mjs` exercises the catalog patterns directly, without going
through extraction, so a failure points at the wording rather than at the DOM.
It exists because every false positive the corpus ever reported came from one
word: a bare `/address/i` matched an email address, an IP address, and "address
your complaint to us". The checks pin both halves of the fix — the senses that
must not match, and the labels that must still match, since tightening a
pattern is the easiest way to silently lose recall.

The Hindi patterns are checked the same way, including that `पता` (address)
does not fire on `पता है` ("to know") and that `नाम` never stands alone,
because it is a substring of `उपयोगकर्ता नाम` (username).

## Corpus rules

The corpus is entirely synthetic. No page is a capture of a real site and no
value belongs to a real person; identifiers are constructed to pass or fail
their checksums on purpose. That is a deliberate choice — a privacy project
should not commit real personal data to a git repository.

Two rules keep pages honest:

1. **Every element that produces a signal must have an HTML `id`.** Labels key
   on that id, so it has to be stable. The harness fails the run and names the
   element if it finds a signal it cannot key.
2. **No `id` may contain a category keyword.** The classifier reads the `id`
   attribute, so an id like `email-field` would feed the detector the very
   signal the page is meant to test. Ids are neutral (`sp-3`, `kn-2`). This was
   a real mistake in the first draft of the corpus: several pages appeared to
   detect values that were actually being matched from their ids.

## Label format

```json
{
  "note": "why this page exists",
  "expect": {
    "gp-1": ["aadhaar/value/checksum"],
    "cf-1": ["payment_card/field-purpose", "payment_card/control-value/checksum"]
  }
}
```

A label is `category/source` or `category/source/confidence`. Confidence is
optional; when given, a mismatch is reported as an evidence warning rather than
a miss, because the category was still found.

**Anything not listed is expected to produce nothing.** That is what makes
false positives visible, and precision is the metric a keyword-driven
classifier tends to fail.

### Labelling policy

A `field-purpose` signal is expected where the wording genuinely indicates the
category — including on a `<label>`, which describes the control beside it. It
is *not* expected where the keyword match is incidental: "Email address" is an
email heading and not a postal one, and "IP address" is neither.

Some labels describe behaviour that is currently **wrong**, so the gap shows up
as a number instead of hiding in a comment. Those are called out in each
page's `note`.

## Baseline, as recorded

16 pages, 46 true positives, 0 false positives, 10 misses. Overall precision
100%. All ten misses are `person_name`: six English names in
`unstructured-names.html` and four Devanagari names in
`devanagari-names.html`. The harness does not load the NER model, so those
remain expected misses here. The Devanagari page is also expected to miss in
the browser — that is the measured cost of the English-only
`onnx-community/distilbert-NER-ONNX` checkpoint.

**Read that precision with suspicion.** Every page here was hand-written by the
same person who wrote the detector, so the corpus tests the cases we thought
of. It is a regression gate, not evidence of real-world accuracy, and the
honest claim is "no known false positives", not "no false positives".

`person_name` prints `n/a` for precision rather than 100%. Precision over zero
predictions is undefined.

The gaps fixed in the last pass, kept here because the corpus still contains
the pages that caught them:

| Gap | Effect when found | Page | Outcome |
| --- | --- | --- | --- |
| `/address/i` matched any sense of the word | 3 false positives; category precision 57.1% | `keyword-noise.html` | Fixed: qualified forms plus lookarounds |
| Catalog keywords were English only | 2 misses on Hindi-labelled fields | `hindi-labels.html` | Fixed: Devanagari patterns |
| Classifier scanned a different string than it serialised | 1 miss, no leak | `inline-split-value.html` | Fixed: scan the serialised string |

One limitation remains recorded in a page `note` rather than as a labelled
miss, because nothing in the current design could catch it: a **raw bank
account number** carries no check digit, so it cannot be verified the way an
IFSC or card number can (`bank-statement.html`). Flagging it would mean
flagging every 9-to-18-digit number on the page.

## Adding a page

1. Write `corpus/<name>.html`. Give every potentially-flagging element a
   neutral `id`.
2. Write `labels/<name>.json` with a `note` explaining what the page tests.
3. Run `npm run eval` and read the per-page detail.
4. For each difference, decide whether the label was wrong or the extractor
   was. Fix the one that is actually wrong — do not adjust a label just to make
   the run green.
5. `npm run eval -- --update` to move the baseline.

## Verifying the gate

The regression gate has been confirmed to work by deliberately removing the
Verhoeff check from `aadhaarValid`. It failed at three independent levels: the
validator unit check, the `examples/pii-values.html` count assertions, and the
corpus baseline comparison (`aadhaar` false positives 0 to 2). If a change to
detection logic leaves all three green, it genuinely changed nothing.
