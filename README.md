# Privacy-Preserving Browser Agent

A Chrome Manifest V3 extension for a privacy-preserving browser agent. The DOM extractor is the first source of context, and identifiers found in it are verified by checksum rather than guessed from labels. A **local vision baseline** (YOLOS-Tiny via Transformers.js) runs only when you click **Analyze current screen**. Screenshots are never uploaded.

`ROADMAP.md` tracks what is built and what comes next.

## Architecture

```text
popup  →  service worker  →  content script  →  page DOM
                |                    |
                |                    +---- DOM snapshot
                |
                +-- offscreen document (VisionEngine)
                       YOLOS-Tiny baseline + optional Tesseract OCR
                       WebGPU, with WASM fallback
```

- **Popup** (`src/popup/`): the only UI. Clicking **Analyze Current Page** asks the service worker to inspect the active tab. Results stay in the popup.
- **Service worker** (`src/background/serviceWorker.js`): a Manifest V3 background script. It cannot see the page DOM. It injects the content script on demand, then forwards the snapshot back to the popup.
- **Content script** (`src/content/`): runs in Chrome's *isolated world*. It can read the page DOM, but it does not share JavaScript with the page. Extraction logic lives in `domExtractor.js`.
- **Utils** (`src/utils/`): visibility checks, the sensitivity catalog and classifier, identifier validators, text cleanup, and stable element ids.
- **Models** (`src/models/`): the snapshot schema for later phases. There is no ML model here.

### Why on-demand injection?

The extension uses `activeTab` and `scripting`. The content script is injected **only when you click Analyze**, not on every page load. That is a privacy choice: the extension does not silently scrape browsing history.

### Manifest V3 notes that matter here

1. **Popups cannot read a tab's DOM.** Only a content script (or `scripting.executeScript`) running in that tab can.
2. **The service worker is event-driven.** It may stop when idle. Do not store page snapshots there.
3. **`activeTab` covers DOM extraction.** Vision also needs `offscreen` plus Hugging Face host permissions so the **model weights** can download once. Screenshots are not uploaded.
4. **Chrome internal pages are off-limits.** `chrome://`, the Chrome Web Store, and similar URLs cannot be inspected.
5. **Content scripts cannot see cross-origin iframe documents.** They also do not pierce closed Shadow DOM. Phase 1 does not pretend otherwise.

DOM analysis does not call a remote API. The vision layer may **download model weights once** from Hugging Face and cache them in the browser. It does not send screenshots or page HTML anywhere.

## 1. Install locally in Chrome

1. Install Node.js, then in this folder run `npm install` (this also bundles the offscreen vision host).
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked**.
5. Select this folder (`browser_based_agent`), the one that contains `manifest.json`.

You should see **Privacy-Preserving Browser Agent** in the extensions list. Pin it from the puzzle-piece menu so the icon is easy to click.

## 2. Load it using chrome://extensions

If you edit the code:

1. Return to `chrome://extensions`.
2. Click **Reload** on this extension.
3. Close and reopen the popup (the old popup still runs the previous scripts).

If Analyze fails on a local HTML file (`file://...`), open the extension **Details** on `chrome://extensions` and enable **Allow access to file URLs**.

## 3. How the content script accesses the DOM

1. You open the popup on a normal `http:` or `https:` page and click **Analyze Current Page**.
2. The popup sends `{ type: "ANALYZE_PAGE" }` to the service worker.
3. The service worker injects these files into the tab, in order:
   - `src/models/messages.js`
   - `src/utils/text.js`
   - `src/utils/visibility.js`
   - `src/utils/sensitivityCatalog.js`
   - `src/utils/validators.js`
   - `src/utils/sensitivity.js`
   - `src/utils/identifiers.js`
   - `src/content/domExtractor.js`
   - `src/content/redaction.js`
   - `src/content/content.js`
4. `content.js` listens for `EXTRACT_DOM`, calls `BrowserAgent.extractPage()`, and returns a JSON-serializable snapshot.
5. The popup displays counts, a readable list, and the JSON.

The content script uses normal DOM APIs (`querySelectorAll`, `getBoundingClientRect`, `getComputedStyle`, `checkVisibility` when available). It does **not** take a screenshot.

By default the snapshot's `elements` array is **only rendered-visible nodes**. Hidden leftovers stay in `counts.found` for debugging and are not sent as agent context.

## Context modes

The popup has a single **Context mode** control:

| Mode | What goes into `elements` |
| --- | --- |
| **Visible DOM** (default) | Rendered/visible on the page, including content below the current scroll position |
| **Current Viewport** | The Visible DOM subset whose bounding box intersects the browser viewport |

A button 2000px below the fold is included in Visible DOM and excluded in Current Viewport.

These three ideas stay separate in code:

1. **DOM existence** — `counts.found`
2. **Visibility** — `counts.visible` and each element's `visible`
3. **Viewport** — `counts.inViewport` and each element's `inViewport`

The popup also shows:

- Total DOM elements found
- Visible elements
- Current viewport elements
- Interactive visible elements
- Identifier values found
- Checksum verified


For later targeting, the extractor writes `data-browser-agent-id="element_N"` onto each collected node. That is a local DOM mutation so a future phase can find the same node with a selector such as `[data-browser-agent-id="element_4"]`. Those attributes are not uploaded.

## 4. What we currently extract

For the page:

- title, URL, `lang`
- viewport size and scroll position
- iframe count (not iframe contents)
- a `limits` object that records what this phase does not cover

For each relevant element (buttons, links, inputs, selects, textareas, images, headings, labels, a few ARIA roles, and a small number of visible paragraphs):

| Field | Meaning |
| --- | --- |
| `id` | Extension id (`element_1`, …), reused on later analyzes |
| `selectorHint` | `#htmlId` or `[data-browser-agent-id="…"]` |
| `kind` | Semantic category (`heading`, `button`, `link`, `input`, …) |
| `tag` | Lowercase tag name |
| `text` | Accessible / visible name, truncated |
| `ariaLabel`, `role`, `placeholder`, `name`, `htmlId` | When present |
| `inputType` | For `<input>` |
| `href` | For links |
| `alt` | For images |
| `autocomplete` | Browser autocomplete token, when set |
| `visible` | CSS/layout visibility (returned context is already filtered to `true`) |
| `inViewport` | Bounding box intersects the viewport |
| `disabled` | `disabled`, `aria-disabled`, or disabled fieldset |
| `boundingBox` | Document coordinates from `getBoundingClientRect` |
| `sensitivity` | `unknown` \| `potentially_sensitive` \| `sensitive` |
| `sensitivityCategories` | Enabled catalog ids that matched |
| `sensitivitySignals` | Why each one matched — see **Value-level detection** below |
| `interactive` | Whether a future agent might click/type into it |

The snapshot also has `mode` (`visible` or `viewport`) and comparison counts (`found`, `visible`, `inViewport`, `interactiveVisible`, `valueMatched`, `checksumVerified`, `valueOnlyElements`).

`found`, `visible`, and `inViewport` describe the candidates matched by the extractor's main selector list. `valueOnlyElements` counts text containers admitted separately because they held an identifier, and is deliberately excluded from those three so the visibility comparison keeps meaning what it always did.

**Sensitivity is local and rule-based**, not a trained PII model and not YOLOS. It answers two separate questions, and the snapshot reports which one fired:

1. **Field purpose** — does this control *ask* for sensitive data? Input type, autocomplete token, and words in name/id/placeholder/label, in English and Hindi.
2. **Value** — does this text *contain* a sensitive identifier? Format and checksum validation, described under **Value-level detection**.

Keyword matching is where a rule-based classifier loses precision, so two senses of a word are handled explicitly. "Address" is postal in *street address* and *address line 2*, and is not postal in *email address*, *IP address*, or *please address your complaint* — the pattern rejects those in place rather than suppressing the whole element, so text containing both an email address and a street address still flags for the second. Hindi `पता` gets the same treatment against its "to know" sense (`पता है`), and bare `नाम` is excluded from person-name matching because it is a substring of `उपयोगकर्ता नाम` (username).

Field purpose alone misses the common case: data that was submitted earlier and is now displayed as ordinary page text.

Open **Sensitive data categories** in the popup to enable or disable each aspect (passwords, email, Aadhaar, faces in photos, canvas text, and so on). Unchecked categories are not flagged. Choices are stored locally in `chrome.storage`.

Defaults (all on):

- `input[type=password]` → `sensitive`
- `input[type=email]` / `input[type=tel]` → `potentially_sensitive`
- names/placeholders such as password, card number, Aadhaar, PAN, phone, address → flagged

We **do not** copy live field values into the snapshot. A field's value is read only to test it against the validators below, and the result is a category plus a confidence — never the string.

## Value-level detection

Field purpose tells us a form is *asking* for an Aadhaar number. It says nothing about a profile page that is *displaying* one. Most PII on a real screen is already-submitted data, so `src/utils/validators.js` matches identifiers by their shape and arithmetic instead of by nearby words.

Structured identifiers do not need a model. They need format validation, which is a stronger claim than a confidence score: a Verhoeff check digit either passes or it does not.

| Identifier | Rule | Confidence |
| --- | --- | --- |
| Aadhaar | 12 digits, first digit 2–9, Verhoeff check digit | `checksum` |
| Payment card | 13–19 digits, Luhn | `checksum` |
| GSTIN | state code + PAN + `Z` + mod-36 check character | `checksum` |
| PAN | `AAAAA9999A` with a valid entity-type letter in 4th position | `structure` |
| IFSC | `AAAA0XXXXXX`, 5th character always `0` | `structure` |
| Email | local part, `@`, dotted domain | `structure` |
| UPI handle | `name@handle` with no dotted domain | `structure` |
| Indian mobile | optional `+91`, then `[6-9]` and 9 digits | `structure` |
| Voter ID (EPIC) | `AAA9999999` | `shape` |
| Passport | `A9999999` | `shape` |

`shape` matchers are too loose to trust on their own, so they are reported only when nearby text also names the category. That is the one place value detection still leans on the keyword catalog.

Each element carries a `sensitivitySignals` array explaining every match:

```json
"sensitivitySignals": [
  { "category": "aadhaar", "via": "value", "confidence": "checksum", "start": 9, "length": 14 },
  { "category": "email", "via": "field-purpose", "confidence": "keyword" }
]
```

- `via: "field-purpose"` — the control asks for this data.
- `via: "value"` — an identifier was found in text the page renders. `start` and `length` index into the element's own normalized text.
- `via: "control-value"` — an identifier was found in a value the user typed. No offsets: such a field is masked whole, so position and length are not needed.

Two design notes worth knowing:

- **We scan the string we serialise.** Whatever text ends up in an element's snapshot fields is the text that gets scanned, which is what keeps detection and redaction from disagreeing. An earlier version scanned only an element's own child text nodes while serialising its accessible name — so a value split across inline children (`<span>2345</span><span>6789 0124</span>`) was reported as absent from a paragraph whose serialised text contained the joined number. Redaction re-scans and replaced it anyway, so nothing leaked, but the element was redacted with no signal explaining why. The consequence of the fix is that a wrapper and its child can both report the same identifier; they share one placeholder, so an agent sees one value rather than two.
- **Text containers are scanned but not collected.** Rendered PII usually sits in a `div`, `span`, `td`, or `dd`, none of which belong in the agent context wholesale. Those are scanned for values and admitted only when something is found.

Overlapping matches are resolved strongest-first, so a Luhn-valid 16-digit card is reported as a card rather than as the phone-shaped digit run inside it.

## Safe snapshot

Detection is not redaction. Finding an Aadhaar number and then serialising it anyway achieves nothing, so `src/content/redaction.js` turns one snapshot into two objects:

- **`agentContext`** — the snapshot with every detected value replaced by a typed placeholder (`<AADHAAR_1>`, `<EMAIL_2>`). This is the only object that is serialised, displayed, or copied. It is what the JSON view shows and what **Copy JSON** puts on your clipboard.
- **`vault`** — placeholder to original value. Session only, never written to `chrome.storage`, never logged, never part of `agentContext`.

Both are built **in the content script's isolated world**, so there is no code path that sends an unredacted snapshot anywhere. The service worker only ever relays an already-redacted object.

```text
element_3  dd  #gp-1   text="<AADHAAR_1>"   [aadhaar]
element_5  dd  #gp-3   text="<VOTER_ID_1>"  [voter_id]
```

A few properties worth stating plainly:

**One value, one placeholder.** The same email in a heading and in a link gets the same token, so an agent can tell it is one entity rather than two.

**Credentials are one-way.** A password, CVV, or OTP gets a placeholder so an agent knows the field is occupied, but no vault entry. Reading one back is never a legitimate operation, so the capability does not exist.

**Filled fields are referable without being exposed.** A control's value was never in the snapshot to begin with. If it is sensitive, the element gains a `valuePlaceholder`, so an agent can reason about and move a value it cannot read.

**De-referencing happens locally.** `FILL_FROM_VAULT` takes an element id and a placeholder — never a value — and does the substitution inside the isolated world. It can only write values already in that page's vault, so it cannot inject arbitrary text and cannot restore a credential.

**Masks and payload cannot disagree.** The canvas mask set is built from the same redaction records, so a blacked-out region is exactly a region where something was replaced.

### What is not redacted

Redaction is scoped to what detection found, which means the gaps measured in `eval/` are also a direct measure of what still leaks. Nothing recognises a person's name, a Hindi-labelled field, or a bank account number with no check digit, so those pass through in plain text.

Attribute *names* (`name`, `htmlId`) are also left alone, since selectors depend on them. And because `text` is truncated at 280 characters, a value straddling that boundary can leave a partial fragment behind.

Turning **Reveal what was redacted** on in the popup shows the mapping so you can check the result. That list is display-only and never reachable from Copy JSON.

## 5. What DOM extraction cannot provide

Be explicit about this; later phases should not treat the snapshot as a full understanding of the page.

- **What the page looks like.** Layout, fonts, colors, and overlapping layers are not in this snapshot.
- **Occlusion.** An element can be CSS-visible and still covered by a modal. We do not use `elementFromPoint` yet.
- **Off-canvas tricks that still have a box on the page.** `left: -9999px` outside the scrollable document is filtered; some “visually hidden” CSS patterns may still pass.
- **`content-visibility: auto`.** Below-fold content using this CSS may report a 0×0 box until the browser lays it out.
- **Whether a human would notice the control.** Contrast, size, and off-screen paint are visual questions.
- **Cross-origin iframe contents.** The parent page's DOM does not include another origin's document.
- **Closed Shadow DOM.** Open shadow roots are also not walked in Phase 1 (kept simple on purpose).
- **Canvas / canvas-drawn UI / `<video>` pixels.** Those are not HTML elements with text.
- **Computed “intent” of the page.** The extractor does not know that a button *logs you in*; it only knows it is a button whose text is “Login”.
- **Freshness after navigation.** The snapshot is a point-in-time copy. IDs persist on the current document until reload.

## 6. What we are deliberately not implementing yet

See `ROADMAP.md` for the phased plan. Still out of scope:

- LLM or vision language model, local or remote
- Any backend, or network upload of page content or screenshots
- Automatic clicking, typing, or form filling
- A learned model for unstructured PII (person names, free-text addresses)
- Automatic clicking or form filling driven by anything other than an explicit
  placeholder de-reference

Already shipped, and no longer on this list: OCR, Transformers.js, ONNX
Runtime, WebGPU, screenshots as model input, checksum-backed detection of
structured identifiers, and placeholder redaction with a session vault.

## How to test

### Automated

```bash
npm run eval
```

Runs validator unit checks, regression assertions against the fixtures in `examples/`, and scored detection over a synthetic corpus, then compares the result against a committed baseline. Exits non-zero on any regression. See `eval/README.md`.

Current baseline: 15 pages, 117 checks, precision 100%, recall 88.5%, F1 93.9%.

Read that precision as "no *known* false positives". Every corpus page was hand-written by the same person who wrote the detector, so it tests the cases we thought of; it is a regression gate, not a measurement of real-world accuracy. All six remaining misses are `person_name` on `unstructured-names.html`, which is deliberate — the corpus had saturated at 100%, and a benchmark with no headroom cannot show whether Phase 6's NER model helped.

This covers extraction and detection only. **Visibility is not exercised** — jsdom has no layout engine, so the harness stubs element boxes. Visibility, vision, and OCR need the manual checks below.

### Manual

Reload the unpacked extension after pulling these changes (`chrome://extensions` → **Reload**), then close and reopen the popup.

### Visibility filter page

1. Open `examples/visibility-test.html` in Chrome (enable **Allow access to file URLs** if needed).
2. Keep the window at a normal height so the green “Below the viewport” block is off-screen.
3. Analyze with **Visible DOM**.
4. Analyze again with **Current Viewport**.

Expect:

- **Included in both:** “Visible submit”, “Visible link”, the email field, “Collapsed section” summary, “Dismiss modal”
- **Included in Visible DOM only:** “Below-fold button” and its heading
- **Included in neither:** display:none, visibility:hidden, zero-size, hidden inputs, old SIH nav links, collapsed menu link, content inside the closed `<details>`

The comparison stats should show `found` larger than `visible`, and `visible` larger than `inViewport` while you are scrolled to the top.

### Sample form page

Open `examples/sample-page.html` as before. Hidden `csrf` must still be absent. Password / email / Aadhaar flags are unchanged, and all three should report `asks` rather than a value match, since every field is empty.

### Value-level PII page

Open `examples/pii-values.html` and analyze with **Visible DOM**. The page is built around a false-positive control, so read it section by section.

- **Section A** holds two Aadhaar-shaped numbers differing by one digit. Exactly one should be flagged — the one whose Verhoeff digit checks out.
- **Section B** renders email, mobile, UPI, PAN, IFSC, GSTIN, and a card number as plain text with no input fields. A keyword-only classifier reports nothing here; every row should be flagged.
- **Section C** is the control: right shapes, wrong arithmetic. Expect zero flags.
- **Section D** checks that weak shapes need a nearby keyword. The voter ID flags; the identically-shaped warehouse code does not.
- **Section E** has pre-filled inputs named `f_7a2b` and similar, where attributes give nothing away. Expect Aadhaar and email reported as `in value`.
- **Section F** is the opposite: labelled but empty fields, reported as `asks` with no mask.

Expect **Identifier values found** to read 11 and **Checksum verified** to read 4.

Then check the redaction: switch to **JSON** and confirm every detected value reads as a placeholder rather than a number. Press **Copy JSON**, paste it somewhere, and search it for `234567890124` — it must not be there. Finally tick **Reveal what was redacted** to see the mapping, and note that the password field in section F appears as a one-way placeholder with no recoverable value.

### SIH website

Open the live SIH site, analyze with **Visible DOM**, and confirm old/hidden navigation links with `0 × 0` boxes no longer appear in the readable list or JSON `elements` array. They may still inflate **Total DOM elements found**. Then switch to **Current Viewport** and confirm the context shrinks to what is on screen.

## Local vision layer (baseline)

YOLOS-Tiny is a **benchmark detector**, not the production privacy model. It answers: can a small object detector run inside this extension and return useful boxes?

- **Where it runs:** an offscreen document (`src/offscreen/`), not the service worker and not the page.
- **Screenshot:** `chrome.tabs.captureVisibleTab` from a button click. The PNG stays in memory and is passed to the offscreen host.
- **Model:** `Xenova/yolos-tiny` through Transformers.js. Weights download once from Hugging Face and are cached. Inference is on-device.
- **Backend:** WebGPU when the pipeline loads; WASM (`q8`) if WebGPU fails.
- **Swap later:** `VisionEngine` + `ModelAdapter`. `YolosTinyAdapter` is wired; `YoloAdapter` is a stub for YOLOv10.
- **OCR:** optional Tesseract.js experiment, same offscreen host, off by default.
- **Hybrid rules:** deterministic. Password/email/buttons are DOM. Images/canvas/video may need vision. The baseline still runs on the full screenshot so we can measure it.
- **Not implemented:** continuous capture, server LLM/VLM, auto-click, redaction.

### How to test vision

1. `npm install` then reload the unpacked extension.
2. Open `examples/vision-benchmark.html`.
3. Wait until the popup shows **Vision model: Ready** (first load can take a minute).
4. Click **Analyze current screen**.
5. Confirm boxes on the screenshot, metrics (backend, load ms, inference ms), and the DOM vs vision table.
6. Optionally enable **Also run local OCR** and repeat on Test F / Test G.

Expected direction of results (not accuracy scores):

| Signal | DOM | Vision / OCR |
| --- | --- | --- |
| Password field | YES | NO |
| Email input | YES | MAYBE (OCR on pixels) |
| Face / person in a photo | NO (image tag only) | YES if YOLOS reports `person` |
| Email painted in an image | NO | YES with OCR |
| Canvas text | tag only | YES with OCR |
| Normal button | YES | NO |

### Measurements recorded

Each run stores model, backend, image size, model load time, inference time, detection count, and confidences. We do not invent precision/recall here.

### Known limitations

- YOLOS is COCO object detection. It does not classify PII, faces vs bodies, or ID cards.
- Full-screenshot inference is the baseline, not the final region-based design.
- First model load needs network for weights only. Later loads should use the cache.
- Popup close does not stop a load already running in the offscreen document.
- OCR is slow on large screenshots; keep it optional.

## Project layout

```text
browser_based_agent/
├── manifest.json
├── package.json
├── README.md
├── scripts/build-vision.mjs
├── ROADMAP.md
├── eval/            (npm run eval: corpus, labels, baseline, checks)
├── examples/
│   ├── sample-page.html
│   ├── visibility-test.html
│   ├── vision-benchmark.html
│   ├── pii-values.html
│   └── assets/
├── src/
│   ├── background/serviceWorker.js
│   ├── content/
│   ├── models/
│   ├── offscreen/
│   ├── popup/
│   ├── utils/
│   └── vision/
│       ├── VisionEngine.js
│       ├── adapters/
│       ├── hybrid/decisionLayer.js
│       └── ocr/OCREngine.js
└── vendor/          (created by npm run build)
```

The DOM extractor remains vanilla JavaScript. Only the offscreen vision host is bundled.

#   S I H 
 
 