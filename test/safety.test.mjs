import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import "../src/agent/protocol.js";
import { normalizeDetections } from "../src/privacy/sanitizer.js";

const agent = globalThis.BrowserAgent.agent;

function context() {
  return {
    redacted: true,
    mode: "visible",
    page: { title: "Demo", url: "http://example.test/" },
    redactionCounts: { replacements: 1, categories: { email: 1 } },
    elements: [
      {
        id: "element_1",
        tag: "input",
        kind: "input",
        inputType: "email",
        text: "Email",
        sensitivityCategories: ["email"]
      },
      {
        id: "element_2",
        tag: "input",
        kind: "input",
        inputType: "password",
        text: "Password",
        sensitivityCategories: ["password"]
      }
    ]
  };
}

test("outbound preparation fails closed and catches reformatted vault values", () => {
  assert.equal(agent.prepareOutbound("go", { redacted: false }, {}).ok, false);
  const safe = agent.prepareOutbound("use <EMAIL_1>", context(), {
    "<EMAIL_1>": "demo.user@example.com"
  });
  assert.equal(safe.ok, true);
  const leaked = structuredClone(context());
  leaked.page.title = "demo user @ example . com";
  assert.equal(
    agent.prepareOutbound("go", leaked, { "<EMAIL_1>": "demo.user@example.com" }).ok,
    false
  );
});

test("model response parser is strict but accepts fenced JSON", () => {
  assert.equal(
    agent.parseResponse('```json\n{"actions":[],"done":true}\n```').ok,
    true
  );
  assert.equal(agent.parseResponse("{broken").ok, false);
  assert.equal(
    agent.parseResponse({ actions: [], done: true, debug: "not allowed" }).ok,
    false
  );
  assert.equal(agent.parseResponse("x".repeat(20001)).ok, false);
  assert.equal(
    agent.parseResponse({ actions: [{ type: "javascript", code: "alert(1)" }] }).ok,
    false
  );
  assert.equal(
    agent.parseResponse({
      actions: Array.from({ length: 9 }, () => ({ type: "wait", ms: 1 }))
    }).ok,
    false
  );
});

test("action validation rejects unknown targets, credentials and excessive bounds", () => {
  assert.equal(
    agent.validateActions([{ type: "click", elementId: "element_99" }], context()).ok,
    false
  );
  assert.equal(
    agent.validateActions(
      [{ type: "fill", elementId: "element_2", text: "<PASSWORD_1>" }],
      context()
    ).ok,
    false
  );
  assert.equal(agent.validateActions([{ type: "wait", ms: 6000 }], context()).ok, false);
  assert.equal(
    agent.validateActions([{ type: "scroll", x: 0, y: 5000 }], context()).ok,
    false
  );
});

test("network gate requires branded sanitized types and rejects raw-data fields", () => {
  const prepared = agent.prepareOutbound("go", context(), {});
  assert.equal(agent.verifyNetworkPayload(prepared.payload, false).ok, true);
  assert.equal(agent.verifyNetworkPayload(prepared.payload, true).ok, false);
  const withImage = {
    ...prepared.payload,
    screenshot: {
      sanitized: true,
      kind: "sanitized-screenshot-v1",
      dataUrl: "data:image/jpeg;base64,AA==",
      width: 1,
      height: 1,
      byteLength: 1
    }
  };
  assert.equal(agent.verifyNetworkPayload(withImage, true).ok, true);
  assert.equal(
    agent.verifyNetworkPayload({ ...prepared.payload, vault: {} }, false).ok,
    false
  );
  assert.match(agent.SYSTEM_PROMPT, /untrusted data/i);
});

test("normalized pixel detections contain only safe metadata", () => {
  const detections = normalizeDetections(
    null,
    null,
    {
      image: { width: 100, height: 100 },
      detections: [
        {
          confidence: 0.91,
          boundingBox: { x: 10, y: 10, width: 20, height: 20 },
          sensitivity: "potentially_sensitive",
          sensitivityCategories: ["faces_people"]
        }
      ]
    },
    {
      items: [
        {
          text: "8565 2583 5787",
          confidence: 0.88,
          boundingBox: { x: 20, y: 60, width: 50, height: 10 },
          sensitivity: "sensitive",
          sensitivityCategories: ["aadhaar"]
        }
      ]
    }
  );
  assert.deepEqual(
    detections.map(({ category, source, redactionPolicy }) => ({
      category,
      source,
      redactionPolicy
    })),
    [
      { category: "faces_people", source: "vision", redactionPolicy: "pixelate" },
      { category: "aadhaar", source: "ocr", redactionPolicy: "black" }
    ]
  );
  assert.doesNotMatch(JSON.stringify(detections), /8565|5787/);
});

test("content applicator refuses unknown, one-way and OTP values", () => {
  const dom = new JSDOM(
    `<input id="email" data-browser-agent-id="element_1">
     <input id="otp" name="otp" autocomplete="one-time-code" data-browser-agent-id="element_2">`,
    { runScripts: "outside-only", url: "http://example.test/" }
  );
  dom.window.eval(fs.readFileSync("src/agent/protocol.js", "utf8"));
  dom.window.eval(fs.readFileSync("src/agent/apply.js", "utf8"));
  const apply = dom.window.BrowserAgent.agentApply;
  assert.equal(
    apply.applyAction(
      { type: "fill", elementId: "element_1", text: "<EMAIL_99>" },
      { "<EMAIL_1>": "demo.user@example.com" }
    ).ok,
    false
  );
  assert.equal(
    apply.applyAction(
      { type: "fill", elementId: "element_1", text: "<OTP_1>" },
      {}
    ).ok,
    false
  );
  assert.equal(
    apply.applyAction(
      { type: "fill", elementId: "element_2", text: "123456" },
      {}
    ).ok,
    false
  );
});
