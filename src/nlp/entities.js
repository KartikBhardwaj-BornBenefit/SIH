/**
 * Turning raw token predictions into usable entity spans.
 *
 * Kept separate from the adapter, and free of any dependency on the runtime,
 * for one reason: this is where the interesting mistakes live, and a pure
 * function can be tested against fixtures without downloading model weights.
 * The adapter needs a browser; this does not.
 *
 * We ask the pipeline for raw per-token output and group it here rather than
 * using the library's own aggregation. That keeps the grouping rules explicit
 * and pinned by tests instead of varying with a library upgrade.
 */

/**
 * CoNLL-03 entity types, mapped onto the sensitivity catalog.
 *
 * PER is the only mapping enabled, and the omissions are deliberate:
 *
 * LOC is *not* mapped to `address`, even though the roadmap originally
 * proposed it. CoNLL LOC fires on any place name in running prose, so "the
 * Bengaluru office moved to Whitefield" yields two location entities — and
 * neither is anybody's address. Mapping it would trade a large amount of
 * precision for recall on a category that already scores 100% from
 * autocomplete tokens and postal-code patterns, which are far stronger
 * evidence. A street address is a *field*, not a place name.
 *
 * ORG and MISC have no privacy meaning here. A company name is not PII, and
 * MISC is a grab bag by construction.
 */
export const ENTITY_CATEGORIES = {
  PER: "person_name",
  LOC: null,
  ORG: null,
  MISC: null
};

/**
 * Minimum grouped score to admit an entity.
 *
 * Set high on purpose. A false positive here is worse than a miss: it
 * redacts text the user can still see on screen, which reads as a bug and
 * teaches them to distrust the redaction. A miss is a documented gap.
 */
export const MIN_SCORE = 0.9;

/** Placeholders minted by an earlier redaction pass, e.g. `<AADHAAR_1>`. */
const PLACEHOLDER = /<[A-Z][A-Z0-9_]*>/g;

export function categoryForLabel(label) {
  return ENTITY_CATEGORIES[String(label).toUpperCase()] || null;
}

/** Character ranges already occupied by a placeholder. */
function placeholderRanges(text) {
  const ranges = [];
  let match;
  PLACEHOLDER.lastIndex = 0;
  while ((match = PLACEHOLDER.exec(text)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function overlapsAny(start, end, ranges) {
  return ranges.some(([from, to]) => start < to && end > from);
}

/** Strip the BIO prefix: "B-PER" and "I-PER" are both PER. */
function entityType(tag) {
  const value = String(tag || "");
  return value.replace(/^[BILUES]-/i, "").toUpperCase();
}

function isContinuation(tag) {
  return /^I-/i.test(String(tag || ""));
}

/**
 * Group raw token predictions into entity spans.
 *
 * @param {Array<{entity: string, score: number, index: number, word: string, start: number, end: number}>} tokens
 * @param {string} text The string the tokens were produced from.
 * @param {{minScore?: number}} [options]
 */
export function groupEntities(tokens, text, options = {}) {
  const minScore = options.minScore == null ? MIN_SCORE : options.minScore;
  const skip = placeholderRanges(text || "");
  const groups = [];
  let current = null;

  function flush() {
    if (!current) {
      return;
    }
    const span = current;
    current = null;
    if (span.start == null || span.end == null || span.end <= span.start) {
      return;
    }
    // An earlier pass already replaced this range with a placeholder. The
    // model is describing a token we invented, not page content.
    if (overlapsAny(span.start, span.end, skip)) {
      return;
    }
    const category = categoryForLabel(span.type);
    if (!category) {
      return;
    }
    if (span.score < minScore) {
      return;
    }
    groups.push({
      label: span.type,
      category,
      score: Number(span.score.toFixed(4)),
      start: span.start,
      length: span.end - span.start,
      text: (text || "").slice(span.start, span.end)
    });
  }

  for (const token of tokens || []) {
    const tag = token.entity || token.entity_group;
    const type = entityType(tag);

    if (!tag || tag === "O" || !type) {
      flush();
      continue;
    }

    // Offsets are the only reliable way to reconstruct a span, because a
    // word may be split into subword pieces that do not concatenate back to
    // the original text. If the tokenizer did not supply them, the token is
    // unusable rather than guessable.
    if (token.start == null || token.end == null) {
      flush();
      continue;
    }

    const continues =
      current &&
      current.type === type &&
      // A B- tag always starts a new entity, even directly after the same
      // type: "Priya Sharma Vikram Iyer" is two people, not one.
      (isContinuation(tag) || token.start <= current.end) &&
      token.start >= current.start;

    if (continues && isContinuation(tag)) {
      current.end = Math.max(current.end, token.end);
      // The group is only as trustworthy as its least confident token.
      current.score = Math.min(current.score, Number(token.score) || 0);
      continue;
    }

    flush();
    current = {
      type,
      start: token.start,
      end: token.end,
      score: Number(token.score) || 0
    };
  }
  flush();

  return groups;
}
