# Privacy-Preserving Browser Agent

A Chrome Manifest V3 extension for a privacy-preserving browser agent. The DOM extractor is the first source of context. A **local vision baseline** (YOLOS-Tiny via Transformers.js) runs only when you click **Analyze current screen**. Screenshots are never uploaded.

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
- **Utils** (`src/utils/`): visibility checks, sensitivity heuristics, text cleanup, and stable element ids.
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
   - `src/utils/sensitivity.js`
   - `src/utils/identifiers.js`
   - `src/content/domExtractor.js`
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
| `interactive` | Whether a future agent might click/type into it |

The snapshot also has `mode` (`visible` or `viewport`) and comparison counts (`found`, `visible`, `inViewport`, `interactiveVisible`).

**Sensitivity is a local checklist**, not a trained PII model and not YOLOS. It looks at input type, autocomplete, and words in name/id/placeholder/label.

Open **Sensitive data categories** in the popup to enable or disable each aspect (passwords, email, Aadhaar, faces in photos, canvas text, and so on). Unchecked categories are not flagged. Choices are stored locally in `chrome.storage`.

Defaults (all on):

- `input[type=password]` → `sensitive`
- `input[type=email]` / `input[type=tel]` → `potentially_sensitive`
- names/placeholders such as password, card number, Aadhaar, PAN, phone, address → flagged

We **do not** copy live field values (typed passwords, emails, and similar). Placeholders and labels are enough for Phase 1.

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

Later SIH phases may add these. They are out of scope now:

- LLM / local language model
- Vision language model, screenshots as model input, OCR
- WebGPU, ONNX Runtime, Transformers.js
- Any backend or network upload of page content
- Automatic clicking, typing, or form filling
- A dedicated PII detector beyond the simple `sensitivity` field

## How to test

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

Open `examples/sample-page.html` as before. Hidden `csrf` must still be absent. Password / email / Aadhaar flags are unchanged.

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
├── examples/
│   ├── sample-page.html
│   ├── visibility-test.html
│   ├── vision-benchmark.html
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

#   S I H  
 