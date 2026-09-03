/**
 * Headless page loading for the evaluation harness.
 *
 * WHAT THIS COVERS
 *   Extraction, classification, and value detection — everything that turns a
 *   DOM into a snapshot.
 *
 * WHAT THIS DOES NOT COVER
 *   Visibility. jsdom has no layout engine, so getBoundingClientRect returns
 *   zeros and every element would be judged invisible. We stub a non-zero box,
 *   which means the three-tier visibility logic in utils/visibility.js is
 *   bypassed rather than tested. Visibility stays covered by the manual
 *   browser fixtures in examples/. Do not read a passing eval run as evidence
 *   that visibility filtering works.
 */
import fs from "fs";
import path from "path";
import { JSDOM } from "jsdom";

const STUB_BOX = {
  left: 0,
  top: 0,
  right: 200,
  bottom: 20,
  width: 200,
  height: 20,
  x: 0,
  y: 0
};

/**
 * The script list is parsed out of the service worker rather than duplicated
 * here, so the harness cannot silently test a different set of files than the
 * extension actually injects.
 */
export function contentScriptFiles(root) {
  const source = fs.readFileSync(path.join(root, "src/background/serviceWorker.js"), "utf8");
  const block = source.match(/var CONTENT_SCRIPT_FILES = \[([\s\S]*?)\];/);
  if (!block) {
    throw new Error("Could not find CONTENT_SCRIPT_FILES in the service worker.");
  }
  const files = (block[1].match(/"([^"]+)"/g) || []).map((q) => q.slice(1, -1));
  if (!files.length) {
    throw new Error("CONTENT_SCRIPT_FILES parsed as empty.");
  }
  // content.js only registers a chrome.runtime listener, which does not exist here.
  return files.filter((file) => file !== "src/content/content.js");
}

/** Load a page, inject the extractor, and return the window plus a snapshot. */
export function extractFromFile(root, htmlPath, options = {}) {
  const html = fs.readFileSync(htmlPath, "utf8");
  const dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: "dangerously" });
  const { window } = dom;

  window.Element.prototype.getBoundingClientRect = function () {
    return STUB_BOX;
  };

  for (const file of contentScriptFiles(root)) {
    const el = window.document.createElement("script");
    el.textContent = fs.readFileSync(path.join(root, file), "utf8");
    window.document.head.appendChild(el);
  }

  const agent = window.BrowserAgent;
  if (!agent || typeof agent.extractPage !== "function") {
    throw new Error(`Extractor failed to install for ${htmlPath}`);
  }

  const snapshot = agent.extractPage({
    mode: options.mode || "visible",
    sensitivityPolicy: options.sensitivityPolicy || null
  });

  return { window, agent, snapshot, dom };
}

/** Load only the utility modules, for unit checks that need no page. */
export function loadUtils(root) {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    runScripts: "dangerously"
  });
  const files = contentScriptFiles(root).concat(["src/vision/hybrid/decisionLayer.js"]);
  for (const file of files) {
    const el = dom.window.document.createElement("script");
    el.textContent = fs.readFileSync(path.join(root, file), "utf8");
    dom.window.document.head.appendChild(el);
  }
  return dom.window.BrowserAgent;
}
