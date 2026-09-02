/**
 * Phase 1 data schema for a page snapshot.
 *
 * This file is documentation for developers. It is not injected at runtime.
 * The live extractor in src/content/domExtractor.js produces objects that
 * match these shapes.
 *
 * @typedef {"unknown" | "potentially_sensitive" | "sensitive"} Sensitivity
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
 * @property {ExtractionLimits} limits
 */
