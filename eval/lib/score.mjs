/**
 * Scoring for the evaluation harness.
 *
 * A prediction is one (element, category, source) triple. Labels list the
 * triples a page should produce; anything else the extractor reports on that
 * page is a false positive. That is deliberate — the harness exists as much to
 * catch over-flagging as under-flagging, and precision is the metric a
 * keyword-driven classifier tends to fail.
 *
 * Label syntax is "category/source" or "category/source/confidence", e.g.
 *   "aadhaar/value/checksum"
 *   "email/field-purpose"
 * Confidence is optional. When given, a mismatch is reported as a warning
 * rather than a miss: the category was still found, just with different
 * evidence than expected, and that deserves attention without polluting the
 * precision figure.
 */

export function parseLabel(label) {
  const [category, via, confidence] = String(label).split("/");
  if (!category || !via) {
    throw new Error(`Malformed label "${label}" (want "category/source[/confidence]")`);
  }
  return { category, via, confidence: confidence || null };
}

function keyOf(triple) {
  return `${triple.element}|${triple.category}|${triple.via}`;
}

/**
 * Every element that produces a signal must carry an HTML id, otherwise the
 * label file has nothing stable to key on. Rather than silently skipping such
 * an element we surface it, so a corpus page can be fixed.
 */
export function collectPredictions(snapshot) {
  const predictions = [];
  const unkeyed = [];

  for (const element of snapshot.elements) {
    const signals = element.sensitivitySignals || [];
    if (!signals.length) {
      continue;
    }
    if (!element.htmlId) {
      unkeyed.push({
        selectorHint: element.selectorHint,
        kind: element.kind,
        tag: element.tag,
        text: element.text,
        signals: signals.map((s) => `${s.category}/${s.via}`)
      });
      continue;
    }
    for (const signal of signals) {
      predictions.push({
        element: element.htmlId,
        category: signal.category,
        via: signal.via,
        confidence: signal.confidence
      });
    }
  }

  return { predictions, unkeyed };
}

export function scorePage(snapshot, expect) {
  const { predictions, unkeyed } = collectPredictions(snapshot);

  const expected = [];
  for (const [element, labels] of Object.entries(expect || {})) {
    for (const label of labels) {
      expected.push({ element, ...parseLabel(label) });
    }
  }

  const expectedByKey = new Map(expected.map((e) => [keyOf(e), e]));
  const predictedByKey = new Map(predictions.map((p) => [keyOf(p), p]));

  const truePositives = [];
  const falsePositives = [];
  const falseNegatives = [];
  const confidenceWarnings = [];

  for (const [key, prediction] of predictedByKey) {
    const match = expectedByKey.get(key);
    if (!match) {
      falsePositives.push(prediction);
      continue;
    }
    truePositives.push(prediction);
    if (match.confidence && match.confidence !== prediction.confidence) {
      confidenceWarnings.push({
        ...prediction,
        expectedConfidence: match.confidence
      });
    }
  }

  for (const [key, want] of expectedByKey) {
    if (!predictedByKey.has(key)) {
      falseNegatives.push(want);
    }
  }

  return { truePositives, falsePositives, falseNegatives, confidenceWarnings, unkeyed };
}

function metrics(tp, fp, fn) {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    tp,
    fp,
    fn,
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1: Number(f1.toFixed(4))
  };
}

/** Roll page results up into overall and per-category metrics. */
export function aggregate(pageResults) {
  const byCategory = new Map();
  let tp = 0;
  let fp = 0;
  let fn = 0;

  function bump(category, field) {
    if (!byCategory.has(category)) {
      byCategory.set(category, { tp: 0, fp: 0, fn: 0 });
    }
    byCategory.get(category)[field] += 1;
  }

  for (const result of pageResults) {
    for (const item of result.truePositives) {
      tp += 1;
      bump(item.category, "tp");
    }
    for (const item of result.falsePositives) {
      fp += 1;
      bump(item.category, "fp");
    }
    for (const item of result.falseNegatives) {
      fn += 1;
      bump(item.category, "fn");
    }
  }

  const categories = {};
  for (const [category, counts] of [...byCategory.entries()].sort()) {
    categories[category] = metrics(counts.tp, counts.fp, counts.fn);
  }

  return { overall: metrics(tp, fp, fn), categories };
}
