/** Console reporting for the evaluation harness. */

function pad(value, width, right = false) {
  const text = String(value);
  if (text.length >= width) {
    return text;
  }
  return right ? " ".repeat(width - text.length) + text : text + " ".repeat(width - text.length);
}

function pct(value) {
  return (value * 100).toFixed(1).padStart(5) + "%";
}

/**
 * Precision over zero predictions is undefined, not perfect. Printing 100%
 * there reads as "this category is solved" when it means the opposite: the
 * detector never fired. Categories awaiting a model sit in exactly that state,
 * so they are shown as "n/a" rather than flattered.
 */
function precisionCell(m) {
  return m.tp + m.fp === 0 ? "    n/a" : pct(m.precision);
}

export function printMetrics(title, aggregated) {
  console.log(`\n${title}`);
  console.log(
    `  ${pad("category", 20)}${pad("TP", 5, true)}${pad("FP", 5, true)}${pad("FN", 5, true)}` +
      `${pad("prec", 8, true)}${pad("recall", 8, true)}${pad("F1", 8, true)}`
  );
  console.log(`  ${"-".repeat(59)}`);

  for (const [category, m] of Object.entries(aggregated.categories)) {
    const flag = m.fp > 0 || m.fn > 0 ? "  <" : "";
    console.log(
      `  ${pad(category, 20)}${pad(m.tp, 5, true)}${pad(m.fp, 5, true)}${pad(m.fn, 5, true)}` +
        `${pad(precisionCell(m), 8, true)}${pad(pct(m.recall), 8, true)}${pad(pct(m.f1), 8, true)}${flag}`
    );
  }

  const o = aggregated.overall;
  console.log(`  ${"-".repeat(59)}`);
  console.log(
    `  ${pad("OVERALL", 20)}${pad(o.tp, 5, true)}${pad(o.fp, 5, true)}${pad(o.fn, 5, true)}` +
      `${pad(pct(o.precision), 8, true)}${pad(pct(o.recall), 8, true)}${pad(pct(o.f1), 8, true)}`
  );
}

export function printPageDetail(page, result) {
  const issues =
    result.falsePositives.length + result.falseNegatives.length + result.unkeyed.length;
  if (!issues && !result.confidenceWarnings.length) {
    return;
  }

  console.log(`\n  ${page}`);
  for (const item of result.falseNegatives) {
    console.log(`    MISSED    #${item.element}  ${item.category}/${item.via}`);
  }
  for (const item of result.falsePositives) {
    console.log(
      `    EXTRA     #${item.element}  ${item.category}/${item.via} (${item.confidence})`
    );
  }
  for (const item of result.confidenceWarnings) {
    console.log(
      `    EVIDENCE  #${item.element}  ${item.category}/${item.via} ` +
        `got "${item.confidence}", label says "${item.expectedConfidence}"`
    );
  }
  for (const item of result.unkeyed) {
    console.log(
      `    NO ID     ${item.selectorHint} <${item.tag}> "${item.text || ""}" ` +
        `-> ${item.signals.join(", ")}  (add an id so it can be labelled)`
    );
  }
}

/**
 * Compare against the committed baseline. A drop in F1 or a rise in false
 * positives fails the run; improvements are reported and require --update to
 * become the new baseline.
 */
export function compareBaseline(current, baseline, tolerance = 0.0005) {
  if (!baseline) {
    return { status: "missing", regressions: [], improvements: [] };
  }

  const regressions = [];
  const improvements = [];

  function compare(name, now, before) {
    if (!before) {
      improvements.push(`${name}: new category (F1 ${now.f1})`);
      return;
    }
    if (now.f1 < before.f1 - tolerance) {
      regressions.push(`${name}: F1 ${before.f1} -> ${now.f1}`);
    } else if (now.f1 > before.f1 + tolerance) {
      improvements.push(`${name}: F1 ${before.f1} -> ${now.f1}`);
    }
    if (now.fp > before.fp) {
      regressions.push(`${name}: false positives ${before.fp} -> ${now.fp}`);
    }
    if (now.fn > before.fn) {
      regressions.push(`${name}: misses ${before.fn} -> ${now.fn}`);
    }
  }

  compare("overall", current.overall, baseline.overall);
  for (const [category, m] of Object.entries(current.categories)) {
    compare(category, m, baseline.categories[category]);
  }
  for (const category of Object.keys(baseline.categories)) {
    if (!current.categories[category]) {
      regressions.push(`${category}: category disappeared from results`);
    }
  }

  return {
    status: regressions.length ? "regressed" : improvements.length ? "improved" : "unchanged",
    regressions,
    improvements
  };
}
