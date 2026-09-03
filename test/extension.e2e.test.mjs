import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { createApp } from "../server/index.mjs";

const root = path.resolve(".");

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    chromium.executablePath(),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

test("unpacked extension completes the offline SIH demo through the mock server", {
  timeout: 120000
}, async () => {
  const executablePath = chromeExecutable();
  assert.ok(executablePath, "Chrome/Chromium is required; set CHROME_PATH if it is not in a standard location.");

  const server = createApp({
    port: 0,
    provider: "mock",
    model: "mock",
    apiKey: "",
    endpoint: "",
    timeoutMs: 5000,
    bodyLimit: "6mb",
    imageEnabled: true,
    allowedOrigins: []
  }).listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const serverUrl = `http://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-agent-e2e-"));
  const extensionRoot = path.join(profile, "extension");
  fs.mkdirSync(extensionRoot);
  for (const directory of ["src", "vendor", "icons"]) {
    fs.cpSync(path.join(root, directory), path.join(extensionRoot, directory), {
      recursive: true
    });
  }
  const testManifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  // Headless Chromium cannot click the toolbar action that grants activeTab.
  // The temporary test-only manifest supplies capture permission; production
  // keeps the narrower user-gesture-bound activeTab permission.
  testManifest.host_permissions = [
    ...new Set([...(testManifest.host_permissions || []), "<all_urls>"])
  ];
  fs.writeFileSync(
    path.join(extensionRoot, "manifest.json"),
    JSON.stringify(testManifest, null, 2)
  );
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath,
      headless: true,
      args: [
        `--disable-extensions-except=${extensionRoot}`,
        `--load-extension=${extensionRoot}`,
        "--no-first-run",
        "--disable-default-apps"
      ]
    });
    let worker = context.serviceWorkers()[0];
    if (!worker) {
      worker = await context.waitForEvent("serviceworker", { timeout: 20000 });
    }
    await worker.evaluate((endpoint) => {
      globalThis.BrowserAgentLlm.endpoint = endpoint;
    }, `${serverUrl}/agent`);
    const extensionId = new URL(worker.url()).host;
    const demo = await context.newPage();
    await demo.goto(`${serverUrl}/demo/sih-demo.html`);

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    popup.on("dialog", (dialog) => dialog.accept());
    await popup.evaluate(() => {
      const personName = document.querySelector('[data-category="person_name"]');
      if (personName) {
        personName.checked = false;
        personName.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    if (process.env.FAST_E2E !== "1") {
      await demo.bringToFront();
      const localAnalysis = await popup.evaluate(
        () =>
          new Promise((resolve) => {
            chrome.runtime.sendMessage(
              {
                type: "ANALYZE_SCREEN",
                runOcr: true,
                includeOriginal: false,
                sensitivityPolicy: SensitivityForm.getPolicy()
              },
              resolve
            );
          })
      );
      assert.equal(localAnalysis.ok, true, JSON.stringify(localAnalysis));
      assert.equal(Object.hasOwn(localAnalysis, "vault"), false);
      assert.equal(localAnalysis.imageDataUrl, null);
      assert.equal(localAnalysis.sanitizedScreenshot.sanitized, true);
      assert.equal(localAnalysis.sanitizedScreenshot.redaction.faceMode, "black");
      assert.match(localAnalysis.sanitizedScreenshot.dataUrl, /^data:image\/jpeg;base64,/);
      assert.equal(localAnalysis.ocr.rawTextRetained, false);
      assert.equal(Object.hasOwn(localAnalysis.ocr, "text"), false);
      assert.ok(localAnalysis.ocr.items.every((item) => !Object.hasOwn(item, "text")));
    }

    await popup.evaluate(() => {
      document.getElementById("agent-goal").value =
        "Fill the contact form using the approved email placeholder, choose Student and continue, but do not fill or reveal the password.";
      document.getElementById("agent-mode").value = "dom";
      document.getElementById("allow-destructive").checked = true;
      document.getElementById("agent-run").click();
    });
    try {
      await popup.waitForFunction(
        () => document.getElementById("agent-state").textContent === "Complete",
        null,
        { timeout: 30000 }
      );
    } catch (error) {
      const diagnostics = await popup.evaluate(() => ({
        state: document.getElementById("agent-state").textContent,
        error: document.getElementById("agent-error").textContent,
        log: document.getElementById("agent-log").textContent
      }));
      throw new Error(`Agent did not complete: ${JSON.stringify(diagnostics)}`, {
        cause: error
      });
    }
    await demo.bringToFront();
    await demo.locator("#completion").waitFor({ state: "visible" });
    assert.equal(await demo.locator('input[type="password"]').inputValue(), "");
    assert.equal(await demo.locator("#contact-form").isHidden(), true);
  } finally {
    if (context) await context.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
