/**
 * Evaluation harness.
 *
 *   npm run eval                 unit checks, regression checks, corpus scoring
 *   npm run eval -- --update     accept current numbers as the new baseline
 *   npm run eval -- --only=bank  restrict corpus scoring to matching pages
 *   npm run eval -- --verbose    print per-page detail even when clean
 *
 * Exits non-zero on a failed check or a regression against eval/baseline.json.
 *
 * Scope: this measures detection, not visibility. See eval/lib/dom.mjs.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { extractFromFile, loadUtils } from "./lib/dom.mjs";
import { scorePage, aggregate } from "./lib/score.mjs";
import { printMetrics, printPageDetail, compareBaseline } from "./lib/report.mjs";
import * as validatorChecks from "./checks/validators.mjs";
import * as keywordChecks from "./checks/keywords.mjs";
import * as regressionChecks from "./checks/regression.mjs";
import * as redactionChecks from "./checks/redaction.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const corpusDir = path.join(here, "corpus");
const labelsDir = path.join(here, "labels");
const baselinePath = path.join(here, "baseline.json");

const args = process.argv.slice(2);
const update = args.includes("--update");
const verbose = args.includes("--verbose");
const onlyArg = args.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length) : null;

/* ------------------------------------------------------------------ *
 * Tiny assertion collector
 * ------------------------------------------------------------------ */
function createChecker(label) {
  const failures = [];
  let count = 0;
  return {
    label,
    eq(name, actual, expected) {
      count += 1;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures.push({ name, actual, expected });
      }
    },
    get total() {
      return count;
    },
    get failures() {
      return failures;
    }
  };
}

function reportChecker(checker) {
  if (!checker.failures.length) {
    console.log(`  ${checker.label}: ${checker.total} checks passed`);
    return true;
  }
  console.log(`  ${checker.label}: ${checker.failures.length} of ${checker.total} FAILED`);
  for (const failure of checker.failures) {
    console.log(`    FAIL  ${failure.name}`);
    console.log(`          expected ${JSON.stringify(failure.expected)}`);
    console.log(`          actual   ${JSON.stringify(failure.actual)}`);
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 1. Unit and regression checks
 * ------------------------------------------------------------------ */
console.log("Checks");

const utils = loadUtils(root);

const validatorChecker = createChecker("validators");
validatorChecks.run(utils, validatorChecker);
const validatorsOk = reportChecker(validatorChecker);

const keywordChecker = createChecker("keywords");
keywordChecks.run(utils, keywordChecker);
const keywordsOk = reportChecker(keywordChecker);

const regressionChecker = createChecker("fixtures");
regressionChecks.run(root, regressionChecker);
const regressionOk = reportChecker(regressionChecker);

const redactionChecker = createChecker("redaction");
redactionChecks.run(root, redactionChecker);
const redactionOk = reportChecker(redactionChecker);

/* ------------------------------------------------------------------ *
 * 2. Corpus scoring
 * ------------------------------------------------------------------ */
if (!fs.existsSync(corpusDir)) {
  console.error(`\nNo corpus at ${corpusDir}`);
  process.exit(1);
}

let pages = fs
  .readdirSync(corpusDir)
  .filter((name) => name.endsWith(".html"))
  .sort();

if (only) {
  pages = pages.filter((name) => name.includes(only));
}

if (!pages.length) {
  console.error("\nNo corpus pages matched.");
  process.exit(1);
}

console.log(`\nCorpus: ${pages.length} page(s)`);

const pageResults = [];
let unlabelled = 0;
let unkeyedTotal = 0;

for (const page of pages) {
  const labelPath = path.join(labelsDir, page.replace(/\.html$/, ".json"));
  if (!fs.existsSync(labelPath)) {
    console.log(`  ${page}: NO LABEL FILE (${path.relative(root, labelPath)})`);
    unlabelled += 1;
    continue;
  }

  const label = JSON.parse(fs.readFileSync(labelPath, "utf8"));
  const { snapshot } = extractFromFile(root, path.join(corpusDir, page), {
    mode: label.mode || "visible"
  });
  const result = scorePage(snapshot, label.expect);
  unkeyedTotal += result.unkeyed.length;
  pageResults.push({ page, ...result });

  const issues =
    result.falsePositives.length + result.falseNegatives.length + result.unkeyed.length;
  const status = issues === 0 ? "ok" : `${issues} issue(s)`;
  console.log(
    `  ${page.padEnd(34)} ${String(result.truePositives.length).padStart(3)} matched  ${status}`
  );
}

if (unlabelled) {
  console.error(`\n${unlabelled} corpus page(s) have no label file.`);
}

const aggregated = aggregate(pageResults);

console.log("\nPer-page detail");
let printedDetail = false;
for (const result of pageResults) {
  const before = printedDetail;
  printPageDetail(result.page, result);
  printedDetail = before || true;
}
if (
  !pageResults.some(
    (r) => r.falsePositives.length || r.falseNegatives.length || r.unkeyed.length || r.confidenceWarnings.length
  )
) {
  console.log("  (nothing to report)");
}

printMetrics("Metrics", aggregated);

/* ------------------------------------------------------------------ *
 * 3. Baseline comparison
 * ------------------------------------------------------------------ */
const baseline = fs.existsSync(baselinePath)
  ? JSON.parse(fs.readFileSync(baselinePath, "utf8"))
  : null;

const comparison = compareBaseline(aggregated, baseline && baseline.metrics);

console.log("\nBaseline");
if (comparison.status === "missing") {
  console.log("  none committed yet; run with --update to record one");
} else {
  console.log(`  ${comparison.status}`);
  for (const line of comparison.improvements) {
    console.log(`    better   ${line}`);
  }
  for (const line of comparison.regressions) {
    console.log(`    WORSE    ${line}`);
  }
}

if (update) {
  const payload = {
    recordedAt: new Date().toISOString(),
    note:
      "Detection metrics only. Visibility is not exercised here; see eval/lib/dom.mjs. " +
      "Update with: npm run eval -- --update",
    pages: pages.length,
    metrics: aggregated
  };
  fs.writeFileSync(baselinePath, JSON.stringify(payload, null, 2) + "\n");
  console.log(`  wrote ${path.relative(root, baselinePath)}`);
}

/* ------------------------------------------------------------------ *
 * 4. Exit status
 * ------------------------------------------------------------------ */
const failed =
  !validatorsOk ||
  !keywordsOk ||
  !regressionOk ||
  !redactionOk ||
  unlabelled > 0 ||
  unkeyedTotal > 0 ||
  (!update && comparison.status === "regressed");

console.log("");
if (failed) {
  console.log("RESULT: fail");
  process.exit(1);
}
console.log("RESULT: pass");
