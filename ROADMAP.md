# Roadmap

Phases 1 and 2 are done. This document plans the rest and records *why* each
piece exists, so a later phase does not undo a deliberate decision.

Keep the same honesty rule as the README: state what a layer does, and state
what it cannot do. Do not claim accuracy we have not measured.

## Where we are

| Phase | Scope | State |
| --- | --- | --- |
| 1 | DOM extraction, three-tier visibility, sensitivity checklist | Done |
| 2 | On-device vision baseline (YOLOS-Tiny), optional OCR, hybrid gate | Done |
| 3 | Value-level detection for structured identifiers | Done |
| 4 | Evaluation harness and per-category metrics | Done |
| 5 | Safe snapshot / redaction pipeline | Done |
| 6 | NER model for unstructured PII | Done |
| 7 | Purpose-built visual detector | Done |
| 8 | Address word senses, Hindi keywords | Done (pulled forward) |
| 8 | Field-purpose classifier, DOM coverage gaps | Backlog |

## The problem this roadmap solves

The original sensitivity layer was a hand-written catalog in
`src/utils/sensitivityCatalog.js`, matched by `matchesAny()` in
`src/utils/sensitivity.js`. The Phase 2 YOLOS-Tiny baseline contributed only
one signal to the privacy decision: whether a COCO `person` box was found.

That is not uniformly wrong. It is wrong in three specific places.

### 1. We detect field purpose, not values

`classifySensitivity()` builds a haystack from `name`, `id`, `placeholder`,
`aria-label`, `autocomplete`, `type`, and the accessible name, then matches
category patterns against it. The Aadhaar patterns are `/aadhaar/i`,
`/aadhar/i`, `/uidai/i` — they match the *word*, and `fieldOnly: true`
restricts them to form controls.

So `Aadhaar: 2345 6789 0123` rendered in a `<div>` is missed twice: once
because no pattern describes the number's shape, and again because the
category never looks at non-field elements.

Most PII on a real screen is already-submitted data being displayed, not an
empty form. This is the largest gap in the project.

There is a partial exception worth noting, because it shows the asymmetry.
`textMatchesCategory()` does hold genuine value regexes, but only for `email`
and `phone`, and it is wired only into the OCR path via
`annotatePixelSensitivity()`. Result: we can currently find an email painted
into an image but not the same email sitting in plain HTML text.

> **Resolved by Phase 3.** `utils/validators.js` scans rendered text and
> control values, and a second extractor pass admits `div`/`span`/`td`/`dd`
> elements when they carry an identifier. Both paths now share one validator
> layer, so an email read off pixels is held to the same rule as one in HTML.

### 2. Obfuscated attributes defeat keyword matching

A minified app renders `name="f_7a2b"` with no label text and no
`autocomplete`. All 21 categories score zero. Keyword matching has no
fallback signal.

### 3. Every pattern is English-only

A field labelled `आधार संख्या` matches nothing. For an India-focused privacy
tool this is a correctness problem, not a nice-to-have.

> **Resolved for the catalog** in the Phase 8 interim pass: every category now
> carries Devanagari patterns alongside its English ones, and
> `hindi-labels.html` went from two misses to clean. This is keyword coverage,
> not language understanding — a Hindi *value* in prose still needs Phase 6.

## Design principle: layers, not one model

Adopt this ordering explicitly and defend it rather than apologising for it:

| Layer | Handles | Method | Why |
| --- | --- | --- | --- |
| Declared DOM facts | `type=password`, `autocomplete=cc-number` | Equality checks | Author-declared. A model would be slower, larger, and less accurate. |
| Format validation | Aadhaar, PAN, IFSC, GSTIN, card, phone | Regex + checksums | Exact. A checksum is a stronger claim than a confidence score. |
| Learned models | Names, addresses, organisations, faces | ONNX inference | Regex fundamentally cannot do these. |

"We use a model only where a model is necessary, and we report accuracy per
layer" is a stronger position than "we run a neural network on everything."

---

## Phase 3 — Value-level detection for structured identifiers — DONE

**Goal:** recognise PII by its shape, anywhere in the snapshot, not just by
the label on a field.

**Outcome.** Shipped as `src/utils/validators.js` plus a rewritten
`classifySensitivity()`. Two findings changed the plan while implementing it:

1. The extractor's main selector list contains no text containers — no `div`,
   `span`, `td`, or `dd` — so scanning "rendered text" would have found almost
   nothing. Added a second pass that scans those containers and admits one to
   `elements` only when a value is actually found.
2. Scanning `innerText` would let a wrapper and its child both report the same
   identifier, and forces layout on every candidate. Switched to immediate
   child text nodes only, so each text node is scanned exactly once.

Verified with 25 validator unit checks, 17 end-to-end checks against
`examples/pii-values.html`, and 11 regression checks on the older fixtures.
jsdom works for this if `getBoundingClientRect` is stubbed — it has no layout
engine, so the visibility layer rejects everything otherwise. Phase 4 should
reuse that trick.

Structured Indian identifiers do not need a model. They need format
validation, which is *better* than a model because it is exact. Bare
digit-counting produces false positives on any 12-digit number; checksums
remove nearly all of them.

### Work

1. Add `src/utils/validators.js` with shape plus checksum validation:

   | Identifier | Shape | Check |
   | --- | --- | --- |
   | Aadhaar | 12 digits, first digit 2–9 | Verhoeff check digit |
   | PAN | `[A-Z]{5}[0-9]{4}[A-Z]` | 4th char is a valid entity-type code |
   | Payment card | 13–19 digits | Luhn |
   | IFSC | `[A-Z]{4}0[A-Z0-9]{6}` | 5th char is always `0` |
   | GSTIN | 15 chars, state code + PAN + entity + `Z` + checksum | mod-36 checksum |
   | Indian mobile | optional `+91`, then `[6-9]\d{9}` | leading digit range |
   | Voter ID (EPIC) | `[A-Z]{3}[0-9]{7}` | shape only |
   | Passport (IN) | `[A-Z][0-9]{7}` | shape only |
   | UPI handle | `[\w.\-]{2,256}@[a-z]{2,64}` | must **not** have a dot after `@`, to separate it from email |

2. Promote `textMatchesCategory()` out of the OCR-only path. It should be the
   single shared value matcher used by the DOM path, the OCR path, and later
   the NER path.

3. Run value matching over rendered text content of collected elements, not
   only over attributes. Relax `fieldOnly` where a value match is possible.

4. Keep field-purpose matching as-is. Report both signals separately on each
   element so we can tell *why* something was flagged:

   ```
   sensitivitySignals: [
     { category: "aadhaar", via: "value", confidence: "checksum" },
     { category: "email",   via: "field-purpose" }
   ]
   ```

5. Never store the matched value itself — only the category, the offset, and
   the length. The existing `hasUserValue` discipline (boolean only, never the
   string) extends here.

### Acceptance

- A page displaying a checksum-valid Aadhaar in a `<div>` is flagged.
- A random 12-digit number that fails Verhoeff is **not** flagged.
- Existing `examples/sample-page.html` results do not regress.
- No PII value appears anywhere in the serialised snapshot.

### Cost

About a day. No new dependencies. Do this before anything involving a model.

---

## Phase 4 — Evaluation harness — DONE

**Goal:** be able to say what our accuracy is, per category, before we start
adding components whose entire value proposition is accuracy.

**Outcome.** `npm run eval`. See `eval/README.md` for the full write-up.
Baseline: 14 synthetic pages, precision 93.2%, recall 93.2%, F1 93.2%.

It found a real bug on the first run. `getAccessibleName()` applied
`inferNearbyLabel()` to every element, not just form controls, so a paragraph
inherited the preceding heading's text as its own accessible name. That
mislabelled the `text` field for text elements *and* fed the wrong words to
keyword matching — a paragraph following an "Email address" heading was itself
flagged as an email field. Restricting the inference to form controls and
contenteditable hosts took overall precision from 77.1% to 92.5%. Weak-shape
corroboration now receives the neighbouring text explicitly, so a `<dd>` can
still be identified from its `<dt>` without inheriting its meaning.

It also caught a methodological error in my own corpus: several element ids
contained category keywords, and since the classifier reads the `id`
attribute, those pages appeared to detect values that were really being
matched from their ids. Corpus ids are now neutral, and `eval/README.md`
records the rule.

Two decisions worth keeping:

- The injected script list is parsed out of `serviceWorker.js`, so the harness
  cannot drift from what the extension actually loads.
- Some labels describe behaviour that is currently wrong, so a gap shows up as
  a number rather than a comment. Three known gaps account for every remaining
  error in the baseline.

**Scope limit, stated loudly:** jsdom has no layout engine, so the harness
stubs `getBoundingClientRect` and the visibility layer is bypassed rather than
tested. A green eval run says nothing about visibility filtering.

We currently have three manual fixture pages and zero metrics. That is also
why nobody has noticed that `/address/i` matches "IP address" and "email
address", or that `/\bgst\b/i` will fire on unrelated copy.

### Work

1. Add `eval/corpus/` with 30–50 saved pages: Indian government portals,
   banking and UPI flows, e-commerce checkout, social profiles, dashboards
   displaying submitted data, and deliberately obfuscated SPA forms.
2. Add `eval/labels/*.json` — ground truth per page, keyed by the extractor's
   `selectorHint` plus character offsets for text matches.
3. Add `eval/run.mjs`: load each page, run the extractor headless, diff
   against labels, print precision / recall / F1 **per category** and overall.
4. Commit a baseline result for the current dictionary so later phases have
   something to beat.
5. Add a false-positive watchlist for the patterns most likely to over-match.

### Acceptance

- `npm run eval` prints a per-category table and exits non-zero on regression
  beyond a configured tolerance.
- Baseline numbers for Phases 1–2 are committed.

### Why this ranks above the model work

For a hackathon, "recall went from 0.61 to 0.93, here is the table" is worth
more than another feature, and it is the only way to prove the model in
Phase 6 actually helped.

---

## Phase 5 — Safe snapshot / redaction pipeline — DONE

**Goal:** change the deliverable from "extension that highlights PII" to
"privacy proxy between a page and an agent."

**Outcome.** `src/content/redaction.js`. The split happens inside the content
script, so no code path can send an unredacted snapshot anywhere; the service
worker only relays an already-redacted object. 39 checks in
`eval/checks/redaction.mjs`, the central one being mechanical: take every
vault value, serialise the agentContext, require that none appears.

Decisions taken while building it:

- **Redaction re-scans the serialised string fields** rather than reusing the
  offsets recorded during detection. Those offsets index into the element's
  direct text, while `text` holds the accessible name — related but not
  identical strings. Re-scanning makes "no matched value survives
  serialisation" a property we can assert directly.
- **`findValues` gained `admitShapes`.** During redaction, detection has
  already decided; the only job left is to locate. The corroborating keyword
  for a weak shape often lived in a neighbouring element the snapshot does not
  carry, so pre-approved categories bypass the corroboration gate.
- **Corroboration during redaction spans the whole element.** A control's
  `text` is its *label*, so "Voter ID ABC1234567" as a label puts the
  identifier into the input's record too. Without the label as corroboration
  that second copy survived. Found by writing the test, not by reading code.
- **Credentials are one-way.** Password, CVV, and OTP get a placeholder but no
  vault entry. The capability to read one back simply does not exist.
- **One value maps to one placeholder**, so an agent can tell that the same
  email in a heading and a link is one entity.
- **Masks are driven by redaction records.** Previously the canvas decided
  independently, so the picture and the payload could disagree.

**Known gaps, deliberately left:** redaction is scoped to what detection
found, so the numbers in `eval/` are also a measure of what leaks — a person's
name, a Hindi-labelled field, and a checksum-free account number all pass
through. `text` is truncated at 280 characters, so a value straddling that
boundary can leave a fragment.

**Vault lifetime** is the popup session, per an explicit product decision. The
content script keeps its own copy for local de-referencing, which dies on
navigation. That means values do transit the service worker on the
ANALYZE_PAGE relay; the screen-analysis path forwards records only and never
the vault. Moving the vault entirely into the isolated world would remove that
transit at the cost of the reveal-to-verify affordance.

Today's masks are painted onto a canvas in `popup.js`. That is a
*visualisation* of redaction, not redaction. Nothing currently produces a
snapshot that is actually safe to hand to a model.

### Work

1. Split the extractor output into two objects:

   - **`agentContext`** — the snapshot with every detected value replaced by a
     typed placeholder (`<EMAIL_1>`, `<AADHAAR_1>`, `<CARD_2>`). This is the
     only object that may ever be serialised, copied, or sent anywhere.
   - **`vault`** — an in-memory map from placeholder to original value. Held
     for the session only. Never written to `chrome.storage`, never logged,
     never included in the JSON view or the Copy JSON button.

2. Add de-referencing on the content-script side, so a future agent phase can
   say "type `<EMAIL_1>` into `element_4`" and the substitution happens
   locally in the isolated world.

3. Make the popup's JSON view and Copy JSON render `agentContext` only. Add a
   test that asserts no vault value can appear in either.

4. Keep the canvas masks, but drive them from the same redaction records so
   the picture and the payload cannot disagree.

### Acceptance

- Copying JSON from the popup on a filled sensitive form yields placeholders.
- A round trip (`agentContext` out, placeholder in, real value typed) works
  without the value leaving the isolated world.

---

## Phase 6 — NER model for unstructured PII — DONE

**Goal:** catch what regex fundamentally cannot — person names in prose — and
do it on device, after the rule pass has already replaced every identifier it
recognises.

This is where a model genuinely earns its place. The checkpoint is English
only; that limitation is measured rather than hidden.

### Outcome

`src/nlp/` mirrors the vision layer: `NerAdapter` contract, DistilBERT NER
(`onnx-community/distilbert-NER-ONNX`, q8, WASM only — 66 MB). BERT-base was
the first pick and was too slow: its q8 file is 108 MB, WebGPU can pull the
431 MB fp32 sibling, and one WASM pass per snapshot field made a finished
download look hung. Packing plus skipping `href`/`src` is what makes Analyze
return. Same CoNLL-03 PER labels, still English-only.

Redaction is two passes. `build` still runs entirely in the content script.
`textsForModel` / `applyEntities` mint into the **same** vault, so one value
keeps one placeholder across both. The ordering is a privacy decision: the
strings that cross into the offscreen document already have checksum-verified
identifiers replaced. The vault never moves.

`LOC` is **not** mapped to `address`. CoNLL location tags fire on any place
name in prose ("Bengaluru", "Whitefield"), which is not a postal address, and
the address category already scores from autocomplete tokens and postal-code
patterns. Mapping it would have traded a large amount of precision for recall
the catalog already has.

The model loads only when `person_name` is enabled and a page is analysed.
Opening the popup does not fetch the weights.

`npm run eval` still does **not** run the ONNX model. It tests grouping,
chunking, placeholder splicing, and the policy gate. Corpus scores remain
rule-only: `unstructured-names.html` and `devanagari-names.html` are expected
misses in the harness. A live Analyze click is what exercises the checkpoint.
The Devanagari page is expected to stay at zero even then — that is the cost
of the English checkpoint, written as a number so an IndicNER conversion can
be justified later.

### Work

1. New `src/nlp/` mirroring the vision layer's shape: `NerEngine` facade plus
   a `NerAdapter` contract, so the checkpoint can be swapped without touching
   callers. Reuse the offscreen document and the existing Transformers.js /
   ONNX runtime — no new inference stack.
2. Run `token-classification` over the extracted text only, not raw page
   HTML. Chunk to the model's 512-token limit with overlap so entities are not
   split at boundaries.
3. Map entity labels onto existing catalog categories. Only `PER` →
   `person_name` is enabled. `LOC` / `ORG` / `MISC` stay unmapped on purpose.
4. Feed results through the Phase 5 redaction records so NER hits are masked
   and placeholdered like everything else.

### Checkpoint selection — DECIDED

**`onnx-community/distilbert-NER-ONNX`, q8, WASM only.** BERT-base was the
first pick and failed the size constraint in practice: q8 is 108 MB, WebGPU
can fetch the 431 MB fp32 file, and one WASM pass per field made a finished
download look hung. DistilBERT q8 is 66 MB, same CoNLL-03 PER labels, still
English-only.

The cost is real and should be stated rather than discovered later: this
checkpoint is **English-only and CoNLL-03 trained**, so it will not read a
Hindi name and it has never seen an Indian name distribution. For an
India-focused tool that is a significant limitation, and the Devanagari
keyword work above does nothing to help here — keywords match field labels,
not names in prose.

The mitigation is architectural, not model-side: keep `NerAdapter` a genuine
contract so the checkpoint is swappable, and treat IndicNER conversion as a
follow-up that reuses the whole pipeline.

### Other candidates, for when the swap happens

| Candidate | Coverage | Caveat |
| --- | --- | --- |
| `Xenova/bert-base-NER` | English, CoNLL-03 | Ready-made ONNX. ~110M params; needs int8 to be a reasonable extension download. |
| DistilBERT multilingual NER (`hrl`) | 10 languages | Despite the name, **does not include Hindi** — check the language list before committing. |
| `ai4bharat/IndicNER` | 11 Indic languages | Best coverage for our use case, but no published ONNX build; would need conversion via `optimum`. Size and latency unmeasured. |

Do not assume an Indic ONNX NER model exists off the shelf. Treat conversion
and quantisation as a research task with a measured outcome, not a given.

### Constraints to respect

- **Download size is a product constraint.** DistilBERT q8 is 66 MB. Do not
  retry WebGPU for this model; it pulls the 261 MB fp32 file and can stall on
  shader compile.
- Load lazily, only when the user enables an unstructured-PII category.

### Acceptance

- Plumbing ships behind the same policy checkbox. Disabling Person name means
  the model is never fetched.
- Grouping, chunking, and `applyEntities` are pinned by `eval/checks/ner.mjs`.
- Corpus headroom for names is labelled and recorded; the English checkpoint's
  Indic gap is a page (`devanagari-names.html`), not a comment.
- Live Analyze is what runs the checkpoint. `npm run eval` stays rule-only so
  the harness does not need a 65 MB download.

---

## Phase 7 — Purpose-built visual detector

**Goal:** make the vision layer answer a privacy question instead of a COCO
question.

YOLOS-Tiny fires on a full-body photo of a stranger's back and misses a
cropped face. The adapter's own header already says it is not a privacy
model. Replace it rather than defend it.

### Outcome

OpenCV YuNet is now the default vision adapter. Its roughly 232 KB ONNX model
is packaged by `npm run build` and reuses the ONNX runtime already needed by
NER, so screen analysis performs no face-model download and screenshots stay
inside the extension. Face detections are labelled `face`, flow through the
existing `faces_people` policy, and are masked in the screenshot preview when
enabled.

`YolosTinyAdapter` remains in the tree unchanged as the Phase 2 benchmark; it
is no longer the production default.

The OCR over-redaction bug is fixed by mapping `<img>` and `<canvas>` viewport
boxes into screenshot pixels. Generic OCR text gets
`image_embedded_text`/`canvas_text` only when its box falls inside one of those
regions. Structured identifiers found by OCR still use the shared validator
layer regardless of region. The evaluation harness pins these policy rules;
live browser testing is still required for WASM inference and visual box
alignment.

### Work

1. Swap in a face detector. Done with OpenCV YuNet: it is purpose-built,
   compact, and keeps a single ONNX runtime instead of packaging MediaPipe's
   additional module WASM.
2. Optional and more differentiated: fine-tune a small detector on ID-card and
   document imagery. This is the strongest visual story for an Indian privacy
   project, but it needs a dataset plan first.
3. Keep `YolosTinyAdapter` registered as the benchmark baseline so Phase 2
   measurements stay reproducible.

### Fix while here — DONE

`annotatePixelSensitivity()` pushes `image_embedded_text` onto **every** OCR
item whenever that policy is on, which is the default. Everything then gets a
non-`unknown` sensitivity, and `drawDetections()` masks rather than highlights
it. Enabling OCR therefore blacks out the whole screenshot instead of
redacting selectively. Scope that category to text found inside image or
canvas regions.

---

## Phase 8 — Backlog

**Field-purpose classifier for obfuscated DOM.** The real "model instead of
dictionary" answer for the form side. Features are already cheap to compute:
input type, the accessible name the extractor derives, preceding and sibling
label text, position within the form, neighbouring field purposes. A small
classifier — logistic regression or a gradient-boosted tree exported to ONNX
— would generalise past keyword matching and stay explainable. Valuable
precisely because it is small.

**DOM coverage gaps.** Open shadow-root traversal, and occlusion testing via
`elementFromPoint` so a control covered by a modal is not reported as
visible. Both are recorded honestly in `snapshot.limits` today.

**Localised patterns.** Hindi and regional-language keyword lists for the
existing catalog, as a cheap complement to multilingual NER.

### Interim pass — DONE (before Phase 6)

Pulled forward ahead of Phase 6 for one reason: Phase 6 is graded against the
Phase 4 baseline, and grading a model against a baseline with 3 known false
positives and a 57% precision category would have made the model's own
contribution unreadable. Cheap fixes first, so the expensive change is
measured cleanly.

**Address word senses.** A bare `/address/i` was the source of every false
positive in the corpus — it matched "Email address", "IP address", and
"Please address your complaint". Replaced with qualified forms
(`street|billing|postal|... address`, `address line N`, `pincode`, `zip code`)
plus a bare-word pattern carrying lookarounds that reject the non-postal
senses in place. Rejecting in place rather than vetoing the whole element
matters: an element whose text contains both an email address and a street
address must still flag for the second. Category precision 57.1% → 100%, and
corpus false positives 3 → 0.

**Localised patterns.** Devanagari keywords across every category. Two
deliberate asymmetries, both because a substring can be a different word:
`पता` (address) is guarded against the "to know" sense (`पता है`, `पता नहीं`)
exactly as the English word was, and bare `नाम` is *excluded* from
`person_name` because it is a substring of `उपयोगकर्ता नाम` (username) — only
qualified forms count. `hindi-labels.html` went from 2 misses to clean.

**Scan the string we serialise.** Found while chasing the last corpus miss,
and the most interesting result of the pass. The classifier scanned an
element's own child text nodes while the snapshot serialised its accessible
name, which folds in descendant text. A value split across inline children
(`<span>4561</span><span>2378 9011</span>`) was therefore reported as absent
from a paragraph whose serialised text contained the joined number.

Nothing leaked — redaction re-scans the serialised strings rather than
trusting the signals, so the value came out placeholdered anyway. But the
element was redacted while carrying no signal explaining why, which is a
contract we should not want: the reason for a redaction should be inspectable.
Fixed by scanning the string that actually gets serialised, which also makes
the signal offsets index into the field they claim to describe. Blast radius
was one element corpus-wide.

**A saturated corpus is not a passing grade.** These fixes took the corpus to
100% precision and 100% recall, which is a problem rather than an achievement:
a benchmark with no headroom cannot show whether Phase 6 helped. Added
`unstructured-names.html` — person names in prose, plus places, companies,
statutes and a river as distractors — labelled as expected misses. It sets
`person_name` recall to 0%, which is the honest number and the one Phase 6 has
to move. The report now prints `n/a` rather than 100% for precision over zero
predictions, because a detector that never fires is not a perfect one.

Baseline moved from 14 pages / F1 93.2% to 15 pages / F1 93.9%, with the
composition changed on purpose: 3 false positives and 3 scattered misses
became 0 false positives and 6 misses concentrated in the one category a model
is supposed to fix. Checks grew from 82 to 117.

---

## Cross-cutting cleanups

- **README and model references updated.** The architecture, server, SIH demo,
  YuNet model, trust boundaries and limitations now match the implementation.
- **`src/models/schema.js` is documentation only** and is never injected. It
  can drift from what `domExtractor.js` actually emits. Consider asserting the
  shape in the Phase 4 harness.
- **CI and linting added.** Standard CI runs lockfile install, bundle build,
  syntax checks, the unchanged evaluation baseline, safety/server tests and a
  fast unpacked-extension integration run without downloading model weights.

## SIH end-to-end agent — delivered

The shipped loop is explicit-user-action only:

1. extract and redact DOM locally;
2. optionally capture and sanitize visible pixels locally;
3. mechanically reject unbranded or leaking payloads;
4. call the local validation server (mock or OpenAI-compatible provider);
5. validate a closed action schema and current `element_N` ids;
6. refuse credential fills and unconfirmed destructive controls;
7. apply locally, refresh and stop on completion, cancellation, repetition,
   step count or runtime bounds.

Remaining non-goals are silent/background capture, arbitrary code/selectors or
model-generated navigation, server access to the vault, and untested Firefox
support.
