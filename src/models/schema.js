/**
 * Phase 1 data schema for a page snapshot.
 *
 * This file is documentation for developers. It is not injected at runtime.
 * The live extractor in src/content/domExtractor.js produces objects that
 * match these shapes.
 *
 * @typedef {"unknown" | "potentially_sensitive" | "sensitive"} Sensitivity
 *
 * The extractor's output is not safe to send anywhere. src/content/redaction.js
 * turns one snapshot into two objects, and only the first may leave the
 * isolated world's trust boundary in serialised form:
 *
 * @typedef {object} RedactionResult
 * @property {PageSnapshot} agentContext Snapshot with every detected value
 *   replaced by a typed placeholder such as `<AADHAAR_1>`. The only object
 *   that may be serialised, copied, or displayed.
 * @property {Object<string,string>} vault Placeholder to original value.
 *   Session only. Never written to chrome.storage, never logged, never part
 *   of agentContext. Credentials are absent from it on purpose.
 * @property {object} redaction Records and counts describing what was
 *   replaced. Carries placeholders and element ids but no values, so it is
 *   safe to pass around for drawing masks.
 *
 * @typedef {object} RedactionRecord
 * @property {string} placeholder e.g. `<EMAIL_2>`
 * @property {string} category Catalog id
 * @property {SensitivityConfidence} confidence Evidence behind the detection
 * @property {string|null} elementId Extractor id, or null for page-level fields
 * @property {string} field Which field was rewritten: `text`, `href`,
 *   `options`, `value`, `page.title`, …
 * @property {boolean} [reused] The value had already been seen, so an existing
 *   placeholder was reused. One value always maps to one placeholder.
 * @property {boolean} [oneWay] A credential: placeholder minted, no vault entry
 *
 * @typedef {"field-purpose" | "value" | "control-value"} SensitivitySource
 *   field-purpose — keyword/attribute match: the control *asks* for this data
 *   value         — an identifier was found in text the page renders
 *   control-value — an identifier was found in a value the user typed
 *
 * @typedef {"keyword" | "shape" | "structure" | "checksum"} SensitivityConfidence
 *   keyword   — attribute or label wording only
 *   shape     — pattern only; admitted just with a corroborating keyword
 *   structure — pattern plus a structural rule (fixed chars, valid charset)
 *   checksum  — pattern plus an arithmetic check digit (Verhoeff, Luhn, mod-36)
 *
 * @typedef {object} SensitivitySignal
 * @property {string} category Catalog id that matched
 * @property {SensitivitySource} via How it matched
 * @property {SensitivityConfidence} confidence Strength of the evidence
 * @property {number} [start] Offset into the element's normalized rendered
 *   text. Present only for `via: "value"`. The text itself is not stored; a
 *   later phase recomputes it from the live DOM to apply a redaction.
 * @property {number} [length] Length of the match in that same string
 *
 * @typedef {"heading" | "button" | "link" | "input" | "textarea" | "select"
 *   | "checkbox" | "radio" | "image" | "label" | "text" | "canvas" | "video"} ElementKind
 *
 * @typedef {object} BoundingBox
 * @property {number} x Document X (viewport left + scrollX), CSS pixels
 * @property {number} y Document Y (viewport top + scrollY), CSS pixels
 * @property {number} width
 * @property {number} height
 *
 * @typedef {object} ExtractedElement
 * @property {string} id Stable-enough id assigned by this extension (element_N)
 * @property {string} selectorHint Selector the extension can use later to find the node
 * @property {ElementKind} kind Semantic kind for a future agent
 * @property {string} tag Lowercase HTML tag name
 * @property {boolean} interactive
 * @property {boolean} visible CSS/layout visibility, not screenshot visibility
 * @property {boolean} inViewport Whether the rendered box intersects the viewport
 * @property {boolean} disabled
 * @property {Sensitivity} sensitivity Heuristic only; not a complete PII detector
 * @property {string[]} [sensitivityCategories] Enabled catalog ids that matched
 * @property {SensitivitySignal[]} [sensitivitySignals] Why each category
 *   matched, so field purpose and verified values stay distinguishable
 * @property {string} [valuePlaceholder] Present on a filled sensitive control.
 *   The value itself was never in the snapshot; this is the token an agent
 *   uses to refer to it. Recoverable through the vault unless the category is
 *   a credential, in which case there is no way back by design.
 * @property {string} [role]
 * @property {string} [inputType]
 * @property {string} [text] Visible / accessible text, truncated
 * @property {string} [ariaLabel]
 * @property {string} [placeholder]
 * @property {string} [name]
 * @property {string} [htmlId] The element's own HTML id attribute, if any
 * @property {string} [href]
 * @property {string} [alt]
 * @property {string} [src] Image URL with query string dropped; data URLs omitted
 * @property {string} [autocomplete]
 * @property {string} [labelFor] For `<label>`, the associated control id
 * @property {number} [headingLevel]
 * @property {boolean} [checked]
 * @property {string[]} [options] Compact option labels for <select>
 * @property {BoundingBox} [boundingBox] Document coordinates (viewport + scroll)
 * @property {BoundingBox} [viewportBox] CSS viewport coordinates from getBoundingClientRect; maps onto captureVisibleTab
 * @property {boolean} [hasUserValue] True when the control currently holds a user-entered value. The value itself is never stored.
 *
 * @typedef {object} PageInfo
 * @property {string} title
 * @property {string} url
 * @property {string} [lang]
 *
 * @typedef {object} ExtractionLimits
 * @property {number} iframeCount Iframes exist but are not descended into
 * @property {boolean} shadowDomNotPierced Open/closed shadow roots are not walked
 * @property {boolean} visibilityIsCssNotVisual Occlusion and contrast are not measured
 *
 * @typedef {object} PageSnapshot
 * @property {number} schemaVersion
 * @property {string} extractedAt ISO timestamp
 * @property {"visible" | "viewport"} mode Which filter produced `elements`
 * @property {PageInfo} page
 * @property {object} viewport
 * @property {number} viewport.width
 * @property {number} viewport.height
 * @property {number} viewport.scrollX
 * @property {number} viewport.scrollY
 * @property {number} [viewport.devicePixelRatio]
 * @property {ExtractedElement[]} elements Filtered agent context only
 * @property {object} counts
 * @property {number} counts.found Relevant DOM candidates, including hidden ones
 * @property {number} counts.visible Rendered-visible candidates
 * @property {number} counts.inViewport Visible candidates currently in the viewport
 * @property {number} counts.interactiveVisible Interactive and rendered-visible
 * @property {number} counts.elements Length of the filtered `elements` array
 * @property {number} counts.interactive Interactive nodes in the filtered context
 * @property {number} counts.sensitive
 * @property {number} counts.potentiallySensitive
 * @property {number} counts.valueMatched Elements holding a detected identifier
 *   value, as opposed to merely asking for one
 * @property {number} counts.checksumVerified Subset of the above where an
 *   arithmetic check digit passed
 * @property {number} counts.valueOnlyElements Text containers (div, span, td,
 *   dd, …) admitted to `elements` only because they held an identifier value.
 *   Excluded from `found`/`visible`/`inViewport`, which continue to describe
 *   the RELEVANT_SELECTOR candidate set.
 * @property {boolean} [redacted] Set by the redaction pass. A snapshot without
 *   it has not been through src/content/redaction.js and must not be
 *   serialised or sent anywhere.
 * @property {object} [redactionCounts] Copy of RedactionResult.counts
 * @property {ExtractionLimits} limits
 */
