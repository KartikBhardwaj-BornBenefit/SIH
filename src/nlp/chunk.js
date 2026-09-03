/**
 * Splitting text to fit the model's context window.
 *
 * BERT truncates at 512 tokens and drops the rest silently, which would mean
 * a long paragraph is scanned at the front and ignored at the back — the worst
 * possible failure for a privacy tool, because it looks like it worked.
 *
 * Chunking is done in characters rather than tokens on purpose. Counting
 * tokens means loading the tokenizer, which would drag the runtime into a
 * module that is otherwise pure and testable. A conservative character budget
 * costs a little redundant work and buys a function we can pin with fixtures.
 *
 * Chunks overlap so an entity spanning a boundary is seen whole by at least
 * one chunk. That produces duplicates, which mergeEntities collapses.
 */

/**
 * Roughly 3 characters per token is pessimistic for English (~4 is typical)
 * and leaves headroom for the CLS/SEP pair and for scripts that tokenize
 * less efficiently than English.
 */
export const MAX_CHUNK_CHARS = 1200;

/** Comfortably longer than any person name that could straddle a boundary. */
export const CHUNK_OVERLAP_CHARS = 160;

/**
 * @param {string} text
 * @param {{maxChars?: number, overlap?: number}} [options]
 * @returns {Array<{text: string, offset: number}>} Offsets index into `text`.
 */
export function chunkText(text, options = {}) {
  const value = typeof text === "string" ? text : "";
  const maxChars = options.maxChars || MAX_CHUNK_CHARS;
  const overlap = options.overlap == null ? CHUNK_OVERLAP_CHARS : options.overlap;

  if (!value) {
    return [];
  }
  if (value.length <= maxChars) {
    return [{ text: value, offset: 0 }];
  }

  const chunks = [];
  let start = 0;

  while (start < value.length) {
    let end = Math.min(start + maxChars, value.length);

    // Prefer a whitespace boundary so a name is not sliced in half, but only
    // if one exists in the last quarter of the window. Otherwise take the
    // hard cut and let the overlap cover it.
    if (end < value.length) {
      const floor = start + Math.floor(maxChars * 0.75);
      const space = value.lastIndexOf(" ", end);
      if (space > floor) {
        end = space;
      }
    }

    chunks.push({ text: value.slice(start, end), offset: start });

    if (end >= value.length) {
      break;
    }
    const next = end - overlap;
    // Guarantee forward progress even if overlap >= the chunk we just took.
    start = next > start ? next : end;
  }

  return chunks;
}

/**
 * Glue several short strings into one model pass.
 *
 * BERT-base on WASM is seconds per forward pass. Sending every element's
 * `text`, `placeholder`, `alt`, and so on as its own sequence is what made
 * "first analyze" look like a hung download: the weights had arrived, and
 * then the page was being scored one field at a time. Packing keeps offsets
 * recoverable so applyEntities still keys on the original field.
 *
 * The separator is two newlines, which is not a valid person name, so an
 * entity that straddles it is dropped rather than attributed to the wrong
 * field.
 */
export const PACK_SEPARATOR = "\n\n";

/**
 * @param {Array<{key: string, text: string}>} items
 * @param {{maxChars?: number, separator?: string}} [options]
 * @returns {Array<{text: string, members: Array<{key: string, start: number, sourceStart: number, length: number}>}>}
 */
export function packTexts(items, options = {}) {
  const maxChars = options.maxChars || MAX_CHUNK_CHARS;
  const sep = options.separator || PACK_SEPARATOR;
  const packs = [];
  let current = { text: "", members: [] };

  function flush() {
    if (!current.members.length) {
      return;
    }
    packs.push(current);
    current = { text: "", members: [] };
  }

  for (const item of items || []) {
    const text = item && typeof item.text === "string" ? item.text : "";
    if (!text) {
      continue;
    }

    if (text.length > maxChars) {
      flush();
      for (const chunk of chunkText(text, { maxChars })) {
        packs.push({
          text: chunk.text,
          members: [
            {
              key: item.key,
              start: 0,
              sourceStart: chunk.offset,
              length: chunk.text.length
            }
          ]
        });
      }
      continue;
    }

    const extra = current.text ? sep.length + text.length : text.length;
    if (current.text && current.text.length + extra > maxChars) {
      flush();
    }

    const start = current.text ? current.text.length + sep.length : 0;
    current.text = current.text ? current.text + sep + text : text;
    current.members.push({
      key: item.key,
      start: start,
      sourceStart: 0,
      length: text.length
    });
  }

  flush();
  return packs;
}

/**
 * Map entities found in a packed string back onto the original items.
 *
 * @param {Array<{start: number, length: number}>} entities Offsets into the pack text.
 * @param {Array<{key: string, start: number, sourceStart: number, length: number}>} members
 */
export function unpackEntities(entities, members) {
  const byKey = new Map();

  for (const entity of entities || []) {
    const end = entity.start + entity.length;
    const owner = (members || []).find((member) => {
      const memberEnd = member.start + member.length;
      return entity.start >= member.start && end <= memberEnd;
    });
    if (!owner) {
      continue;
    }
    const mapped = Object.assign({}, entity, {
      start: entity.start - owner.start + (owner.sourceStart || 0)
    });
    const list = byKey.get(owner.key) || [];
    list.push(mapped);
    byKey.set(owner.key, list);
  }

  return Array.from(byKey.entries()).map(([key, found]) => ({
    key: key,
    entities: found
  }));
}

/**
 * Collapse entities found in overlapping chunks.
 *
 * Two entities are the same when their spans are identical, which is safe
 * because offsets have already been shifted back into the original string.
 * The higher score wins, so a boundary-straddling name scored poorly by the
 * chunk that saw half of it does not beat the chunk that saw all of it.
 *
 * @param {Array<{category: string, start: number, length: number, score: number}>} entities
 */
export function mergeEntities(entities) {
  const bySpan = new Map();

  for (const entity of entities || []) {
    const key = entity.category + ":" + entity.start + ":" + entity.length;
    const existing = bySpan.get(key);
    if (!existing || entity.score > existing.score) {
      bySpan.set(key, entity);
    }
  }

  const merged = Array.from(bySpan.values()).sort((a, b) => a.start - b.start);

  // Drop an entity fully contained in another of the same category. A chunk
  // that saw only "Sharma" must not survive alongside "Priya Sharma".
  return merged.filter((entity, index) => {
    const end = entity.start + entity.length;
    return !merged.some((other, otherIndex) => {
      if (otherIndex === index || other.category !== entity.category) {
        return false;
      }
      const otherEnd = other.start + other.length;
      const contains = other.start <= entity.start && otherEnd >= end;
      const strictlyBigger = other.length > entity.length;
      return contains && strictlyBigger;
    });
  });
}
