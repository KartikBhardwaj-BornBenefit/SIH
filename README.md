# Privacy-Preserving Browser Agent

A Chrome Manifest V3 extension for a privacy-preserving browser agent. The DOM extractor is the first source of context, and identifiers found in it are verified by checksum rather than guessed from labels. English person names in prose are found by a **local NER model** after those identifiers have already been replaced. A compact **local face detector** (OpenCV YuNet) runs only when you click **Analyze current screen**. Page content and screenshots are never uploaded.

`ROADMAP.md` tracks what is built and what comes next.

## Architecture

```text
popup  →  service worker  →  content script  →  page DOM
                |                    |
                |                    +-- extract, then rule-redact
                |                    +-- ask offscreen for NER spans
                |                    +-- apply name placeholders; vault stays here
                |
                +-- offscreen document (VisionEngine + NerEngine)
                       OpenCV YuNet + optional Tesseract OCR
                       DistilBERT NER (English, q8), loaded on first analysis
                       local WASM inference
```

- **Popup** (`src/popup/`): the main UI. Clicking **Analyze Current Page** asks the service worker to inspect the active tab. After an agent run, **View all screens** opens a local window with every sanitized screenshot from that task.
- **Service worker** (`src/background/serviceWorker.js`): a Manifest V3 background script. It cannot see the page DOM. It injects the content script on demand, then forwards the snapshot back to the popup.
- **Content script** (`src/content/`): runs in Chrome's *isolated world*. It can read the page DOM, but it does not share JavaScript with the page. Extraction logic lives in `domExtractor.js`. Redaction lives in `redaction.js`.
- **Utils** (`src/utils/`): visibility checks, the sensitivity catalog and classifier, identifier validators, text cleanup, and stable element ids.
- **NLP** (`src/nlp/`): on-device named-entity recognition. The popup and content script never import this; only the offscreen host does.
- **Models** (`src/models/`): the snapshot schema for later phases. There is no ML checkpoint here.

### Why on-demand injection?

The extension uses `activeTab` and `scripting`. The content script is injected **only when you click Analyze or Run agent**, not on every page load. That is a privacy choice: the extension does not silently scrape browsing history. Multi-step runs declare the `<all_urls>` host permission so a later turn can still read the page **and** capture a sanitized screenshot after navigation. `activeTab` alone only covers the tab that was active when you clicked the icon. Chrome will show that as access to websites; the script still only runs when you start an analysis.

### Manifest V3 notes that matter here

1. **Popups cannot read a tab's DOM.** Only a content script (or `scripting.executeScript`) running in that tab can.
2. **The service worker is event-driven.** It may stop when idle. Do not store page snapshots there.
3. **`activeTab` covers DOM extraction.** Vision also needs `offscreen` plus Hugging Face host permissions so the **model weights** can download once. Screenshots are not uploaded.
4. **Chrome internal pages are off-limits.** `chrome://`, the Chrome Web Store, and similar URLs cannot be inspected.
5. **Content scripts cannot see cross-origin iframe documents.** They also do not pierce closed Shadow DOM. Phase 1 does not pretend otherwise.

DOM analysis does not call a remote API. The vision and NER layers may **download model weights once** from Hugging Face and cache them in the browser. They do not send screenshots or page HTML anywhere. NER runs on strings that have already had checksum-verified identifiers replaced by placeholders.

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

Both are built **in the content script's isolated world**. The rule pass finishes there. The NER pass is the one exception: already-redacted strings are sent to the offscreen document, entity spans come back, and placeholders are minted in the tab. The vault never leaves the isolated world. The service worker only ever relays an already-redacted object plus those spans.

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

Redaction is scoped to what detection found, which means the gaps measured in `eval/` are close to a measure of what still leaks. `npm run eval` does **not** run the NER model (that needs a browser and a weight download), so names in prose still show as misses in the harness even though a live Analyze click will try to catch English ones. Hindi names in running text, and a bank account number with no check digit, still pass through in plain text.

Sensitive `name`, `htmlId`, accessible-name, URL and label values are now scanned like visible text. Stable `element_N` ids—not page selectors—are used remotely. Truncated text is replaced by a one-way `<TRUNCATED_N>` token so truncation cannot expose half of an otherwise detectable secret.

The raw mapping is intentionally not exposed to the popup. It remains in the tab-scoped isolated world and can only be resolved locally when an approved placeholder is applied.

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

## Agent trust boundary

Local analysis mode performs no network request. Agent mode sends a compact redacted DOM snapshot to the local agent server. **Sanitized image + structured context** mode may also send a second, newly rendered JPEG containing padded black masks for secrets and faces. The original PNG, OCR text, content-script vault, passwords, OTPs, CVVs and authentication/session tokens are never accepted by network code.

Before `fetch`, `src/agent/protocol.js` requires `sanitized: true`, a redacted context, a sanitizer-branded image when image mode is selected, bounded payload size, and no raw-data fields. It also scans the outbound structure for exact and reformatted vault values while the vault is still available inside the content script. The server repeats structural validation and has no vault API.

The server returns only a closed action vocabulary. Both server and extension reject unknown fields, ids and actions. Password/OTP/CVV/token fields cannot be filled. Submit, continue, send, purchase and delete actions require explicit user approval.

## How to test

### Automated

```bash
npm run eval
npm run test:safety
npm run test:server
npx playwright install chromium # once, for browser automation
npm run test:e2e
```

`npm run eval` preserves the scored rule/DOM baseline. The safety suite covers leak gates, malformed model output, action bounds, credential refusal and placeholder handling. The server suite exercises request validation and the deterministic mock provider. The E2E suite launches the unpacked extension in test Chromium, creates a real sanitized screenshot with local YuNet/OCR, runs the mock agent and verifies that the password stays empty.

Current baseline: 16 pages, rule-only scoring (the ONNX name model is not loaded here), precision 100%, recall in the high 80s, with every remaining miss a `person_name` on `unstructured-names.html` or `devanagari-names.html`. Those pages exist so the English-only checkpoint has a number to miss rather than a comment to hide behind. See `eval/README.md` for the recorded counts.

The scored corpus remains deliberately separate from real-model measurements: its headline precision/recall/F1 describe deterministic DOM/value rules, not YuNet, OCR or NER. Real browser inference is exercised by `npm run test:e2e`; model-specific benchmark claims require a labelled pixel corpus and are not invented here.

### Manual

Reload the unpacked extension after pulling these changes (`chrome://extensions` → **Reload**), then close and reopen the popup.

### Agent screenshot gallery

1. Run a Hybrid or **Sanitized image** task that visits more than one page.
2. In the popup, use the thumbnail strip under **Sanitized screenshots**, or click **View all screens** (or the preview image) to open a larger window you can move to another monitor.
3. Reopening the popup restores the last task's captures from memory. They are not written to disk, and they disappear if Chrome restarts the service worker.

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

Then check the redaction: switch to **JSON** and confirm every detected value reads as a placeholder rather than a number. Press **Copy JSON**, paste it somewhere, and search it for `234567890124` — it must not be there. The password field in section F appears only as a one-way placeholder with no recoverable value.

### SIH website

Open the live SIH site, analyze with **Visible DOM**, and confirm old/hidden navigation links with `0 × 0` boxes no longer appear in the readable list or JSON `elements` array. They may still inflate **Total DOM elements found**. Then switch to **Current Viewport** and confirm the context shrinks to what is on screen.

## Local vision layer

OpenCV YuNet is the production vision adapter. Its tiny face-specific model handles small and printed portraits better than the previous selfie-oriented BlazeFace adapter. `YolosTinyAdapter` remains available in the source tree as the reproducible Phase 2 benchmark.

- **Where it runs:** an offscreen document (`src/offscreen/`), not the service worker and not the page.
- **Screenshot:** `chrome.tabs.captureVisibleTab` from a button click. The PNG stays in memory and is passed to the offscreen host.
- **Model:** OpenCV YuNet 2023mar, a roughly 232 KB ONNX model packaged into `vendor/vision` by `npm run build`.
- **Backend:** ONNX Runtime Web on local WASM/CPU, shared with the NER stack.
- **Adapter boundary:** `VisionEngine` + `ModelAdapter`. `YuNetFaceAdapter` is the default; `YolosTinyAdapter` remains the benchmark and `YoloAdapter` is a stub.
- **OCR:** Tesseract.js in the same offscreen host. Screen analysis enables it
  automatically when the viewport DOM contains an image, canvas, or video.
  **Always run local OCR** is an override for pixel surfaces the DOM cannot
  identify, such as CSS background images or inaccessible frames.
- **Hybrid rules:** deterministic. Password/email/buttons are DOM. Images/canvas/video may need vision. Face detection runs on the full visible screenshot.
- **Outbound sanitizer:** a new canvas black-boxes structured/OCR secrets and faces with padding. The sanitizer also supports pixelation, but the extension defaults to the clearer black mask. Only its branded JPEG may enter image-mode network code.

### How to test vision

1. `npm install` then reload the unpacked extension.
2. Open `examples/vision-benchmark.html`.
3. Click **Analyze current screen** (the packaged face model loads on demand).
4. Confirm boxes on the screenshot, metrics (backend, load ms, inference ms), and the DOM vs vision table.
5. OCR should run automatically on Test F / Test G. Enable **Always run local
   OCR** to test the manual override.

Expected direction of results (not accuracy scores):

| Signal | DOM | Vision / OCR |
| --- | --- | --- |
| Password field | YES | NO |
| Email input | YES | MAYBE (OCR on pixels) |
| Face in a photo | NO (image tag only) | YES if YuNet finds a face |
| Email painted in an image | NO | YES with OCR |
| Canvas text | tag only | YES with OCR |
| Normal button | YES | NO |

### Measurements recorded

Each run stores model, backend, image size, model load time, inference time, detection count, and confidences. We do not invent precision/recall here.

## Agent server

The extension defaults to `http://127.0.0.1:4317/agent`. Paste a cloud key only in **`server/.env`** (never in the extension). A template is `server/.env.example`.

```bash
# server/.env  — paste the OpenRouter key (sk-or-...) on the AGENT_API_KEY line
AGENT_PROVIDER=openrouter
AGENT_ENDPOINT=https://openrouter.ai/api/v1/chat/completions
AGENT_MODEL=qwen/qwen3.7-flash
AGENT_FALLBACK_MODELS=openai/gpt-4o-mini
AGENT_API_KEY=
npm run server
```

With no `server/.env` (or `AGENT_PROVIDER=mock`), the offline demo provider is used. Gemini, OpenAI, Ollama, or another OpenAI-compatible host still work if you change `AGENT_ENDPOINT` and `AGENT_MODEL` in that same file. Only already-sanitized input reaches the provider. `AGENT_ALLOWED_ORIGINS` can be a comma-separated extension-origin allowlist for a fixed demo installation. The server exposes `GET /health` and validated `POST /agent`; request bodies default to a 6 MB maximum and provider calls time out.

## Reproducible SIH demonstration

1. Run `npm install`, `npm run build`, and `npm run server`.
2. Load/reload this folder at `chrome://extensions` and enable file access only if opening examples through `file://`.
3. Open `http://127.0.0.1:4317/demo/sih-demo.html`.
4. Open the extension. Optionally run **Analyze current screen** to show face/OCR/PII detection and the truly sanitized preview.
5. Use goal: “Fill the contact form using the approved email placeholder, choose Student and continue, but do not fill or reveal the password.”
6. Select **Hybrid DOM + local vision**, enable the submit/continue confirmation, and run.
7. Confirm the privacy summary, redacted context, validated action log and latency stages. The page ends at **Demo complete** and the password remains empty.

The generated participant portrait and every identifier in the page are synthetic demonstration fixtures.

## Threat model

- **Malicious page / prompt injection:** page text is explicitly untrusted data; it cannot expand the action vocabulary, supply selectors/URLs/code, or override the system policy.
- **Accidental PII leakage:** rules, checksums, local NER/OCR/vision, one-way credential tokens, screenshot masks and two mechanical payload gates reduce risk. Detection is imperfect, so this is not a claim of anonymity or zero leakage.
- **Malicious model output:** strict parsing rejects unknown keys/actions, stale or unknown ids, oversized replies, excessive waits/scrolls, credential fills and unapproved destructive controls.
- **Stale DOM:** every turn extracts a fresh snapshot; application fails closed when its `element_N` no longer exists.
- **Logs:** progress records categories, ids, counts and timings only. Raw values, OCR text, screenshots and vault contents are not logged.
- **Network/provider:** HTTPS protects cloud transport; a third-party provider can retain sanitized data under its own policy. Prefer the local mock or self-hosted model for the strongest boundary.
- **Detection limits:** cross-origin frames, closed shadow DOM, unusual scripts/languages, low-quality OCR and novel identifiers can still evade detection.

## Browser compatibility

Chrome and Edge Manifest V3 are the supported targets. Automated Chromium coverage loads the unpacked extension. Firefox is **not claimed as supported**: `chrome.offscreen`, `captureVisibleTab` permission behavior and MV3 service-worker differences require a hidden-page/background compatibility target that is not implemented or tested.

### Known limitations

- YuNet detects faces, not identity, full bodies, ID-card type, or document boundaries.
- YuNet runs once on the full screenshot, then retries a miss with overlapping regions on large captures.
- The face model is packaged locally; the English NER checkpoint still downloads on first use.
- Stop cancels the active server request, but it cannot interrupt a synchronous model pass already running in the offscreen document.
- OCR is slower on large screenshots and supports English text in the packaged build.
- Indic/Devanagari person-name recall remains measured at 0% in the rule-only corpus; a browser-sized multilingual NER replacement is not shipped.
- Browser heap reporting is optional and displayed only as an estimate when Chromium exposes it.

## Project layout

```text
browser_based_agent/
├── manifest.json
├── package.json
├── README.md
├── scripts/build-vision.mjs
├── server/          (privacy gateway, mock and OpenAI-compatible providers)
├── ROADMAP.md
├── eval/            (npm run eval: corpus, labels, baseline, checks)
├── test/            (safety, server and unpacked-extension integration)
├── examples/
│   ├── sih-demo.html
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
│   ├── nlp/
│   │   ├── NerEngine.js
│   │   ├── chunk.js
│   │   ├── entities.js
│   │   └── adapters/
│   ├── popup/
│   ├── privacy/sanitizer.js
│   ├── utils/
│   └── vision/
│       ├── VisionEngine.js
│       ├── adapters/
│       ├── hybrid/decisionLayer.js
│       └── ocr/OCREngine.js
└── vendor/          (created by npm run build)
```

The DOM extractor remains vanilla JavaScript. Only the offscreen host (vision, OCR, NER) is bundled.
