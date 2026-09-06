import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import "../src/agent/protocol.js";
import "../src/utils/sensitivityCatalog.js";
import "../src/utils/validators.js";
import "../src/privacy/profileVault.js";
import { normalizeDetections } from "../src/privacy/sanitizer.js";
import { filterFaceDetections } from "../src/vision/faceFilters.js";
import { contentScriptFiles } from "../eval/lib/dom.mjs";

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
  const repaired = agent.prepareOutbound("go", leaked, { "<EMAIL_1>": "demo.user@example.com" });
  assert.equal(repaired.ok, true);
  assert.doesNotMatch(JSON.stringify(repaired.payload), /demouserexamplecom|demo\.user@example\.com/i);
  assert.match(JSON.stringify(repaired.payload), /<EMAIL_1>/);
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
      actions: Array.from({ length: 20 }, () => ({ type: "wait", ms: 1 })),
      done: true
    }).actions.length,
    16
  );
  const truncated = agent.parseResponse({
    actions: Array.from({ length: 20 }, () => ({ type: "wait", ms: 1 })),
    done: true
  });
  assert.equal(truncated.ok, true);
  assert.equal(truncated.done, false);
  assert.equal(agent.parseResponse({ actions: [], done: true }).done, true);
  assert.equal(agent.parseResponse({ actions: [], done: false }).done, false);
});

test("parser accepts aliased keys, drops empty fills, and keeps profile tokens", () => {
  const parsed = agent.parseResponse({
    actions: [
      { action: "fill", id: "element_1", value: "" },
      { action: "fill", id: "element_1", value: "<PROFILE_EMAIL>" },
      { action: "select", id: "element_3", value: "Visa" }
    ],
    done: true
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.actions.length, 2);
  assert.equal(parsed.actions[0].type, "fill");
  assert.equal(parsed.actions[0].elementId, "element_1");
  assert.equal(parsed.actions[0].text, "<PROFILE_EMAIL>");
  assert.equal(parsed.actions[1].type, "select");
});

test("validation skips invented payment values without failing the rest of the plan", () => {
  const page = context();
  page.elements.push({
    id: "element_3",
    tag: "select",
    kind: "select",
    text: "Card type",
    sensitivityCategories: ["payment_card"]
  });
  page.profile = globalThis.BrowserAgent.profileVault.publicCatalog({
    values: { email: "demo.user@example.com" }
  });
  const validated = agent.validateActions(
    [
      { type: "fill", elementId: "element_1", text: "<PROFILE_EMAIL>" },
      { type: "select", elementId: "element_3", text: "Visa (Preferred)" }
    ],
    page
  );
  assert.equal(validated.ok, true);
  assert.equal(validated.actions.length, 1);
  assert.equal(validated.actions[0].elementId, "element_1");
});

test("validation skips invented company and job titles", () => {
  const page = context();
  page.elements.push({
    id: "element_3",
    tag: "input",
    kind: "input",
    inputType: "text",
    text: "Company"
  });
  page.elements.push({
    id: "element_4",
    tag: "select",
    kind: "select",
    text: "Role",
    options: ["Choose one", "Student", "Mentor"]
  });
  page.profile = globalThis.BrowserAgent.profileVault.publicCatalog({
    values: { email: "demo.user@example.com" }
  });
  const validated = agent.validateActions(
    [
      { type: "fill", elementId: "element_1", text: "<PROFILE_EMAIL>" },
      { type: "fill", elementId: "element_3", text: "Acme Corp" },
      { type: "select", elementId: "element_4", text: "Student" }
    ],
    page,
    "Use the approved email and choose Student."
  );
  assert.equal(validated.ok, true);
  assert.deepEqual(
    validated.actions.map((action) => action.elementId + ":" + (action.text || "")),
    ["element_1:<PROFILE_EMAIL>", "element_4:Student"]
  );
});

test("validation allows chat text copied from the user goal", () => {
  const page = context();
  page.elements.push({
    id: "element_5",
    tag: "div",
    kind: "input",
    text: "Type a message"
  });
  const validated = agent.validateActions(
    [{ type: "fill", elementId: "element_5", text: "hi there" }],
    page,
    "write to Sravan, hi there"
  );
  assert.equal(validated.ok, true);
  assert.equal(validated.actions[0].text, "hi there");
});

test("redundant chat clicks are dropped and greetings parse from the goal", () => {
  const page = context();
  page.elements.push({
    id: "element_9",
    kind: "button",
    role: "listitem",
    text: "sebum"
  });
  page.elements.push({
    id: "element_10",
    kind: "input",
    role: "textbox",
    text: "Type a message"
  });
  const history = [
    {
      actions: [{ type: "click", elementId: "element_9" }],
      results: [{ ok: true, type: "click", elementId: "element_9" }],
      elements: [{ id: "element_9", kind: "button", role: "listitem", text: "sebum" }]
    }
  ];
  const reduced = agent.dropRedundantActions(
    [{ type: "click", elementId: "element_9" }],
    page,
    history
  );
  assert.equal(reduced.actions.length, 0);
  const retry = agent.dropRedundantActions(
    [{ type: "click", elementId: "element_9" }],
    page,
    history,
    "send sebum a hi"
  );
  assert.equal(retry.actions.length, 1);
  page.page = { goalChatOpen: true, openConversation: "sebum" };
  const alreadyOpen = agent.dropRedundantActions(
    [{ type: "click", elementId: "element_9" }],
    page,
    history,
    "send sebum a hi"
  );
  assert.equal(alreadyOpen.actions.length, 0);
  assert.equal(agent.historyOpenedGoalChat(history, "send sebum a hi"), true);
  assert.equal(agent.messageFromGoal("in this there is a contact named sebum , send him a hi"), "hi");
  assert.equal(agent.findComposerElement(page).id, "element_10");
});

test("search turns do not type into the already open chat", () => {
  const page = context();
  page.elements.push({
    id: "element_13",
    kind: "input",
    role: "searchbox",
    text: "Search or start a new chat"
  });
  page.elements.push({
    id: "element_65",
    kind: "input",
    role: "textbox",
    text: "Type a message"
  });
  page.elements.push({
    id: "element_145",
    kind: "button",
    role: "listitem",
    text: "Builders Sebum reacted to a message"
  });
  const split = agent.splitSearchTurn(
    [
      { type: "click", elementId: "element_13" },
      { type: "fill", elementId: "element_13", text: "sebum" },
      { type: "click", elementId: "element_145" },
      { type: "fill", elementId: "element_65", text: "hi" },
      { type: "click", elementId: "element_66" }
    ],
    page
  );
  assert.deepEqual(
    split.actions.map(function (action) {
      return action.type + " " + action.elementId;
    }),
    ["click element_13", "fill element_13"]
  );
  const mismatched = agent.dropMismatchedChatClicks(
    [{ type: "click", elementId: "element_145" }],
    page,
    "in this there is a contact named sebum , send him a hi"
  );
  assert.equal(mismatched.actions.length, 0);
  assert.equal(agent.goalContactName("Open the chat named sebum, type hi, and send"), "sebum");
  assert.equal(agent.goalContactName("send sebum a hi"), "sebum");
  assert.equal(agent.titleMatchesContact("sebum", "sebum"), true);
  assert.equal(agent.titleMatchesContact("Builders Sebum reacted", "sebum"), false);

  page.page = { title: "WhatsApp", openConversation: "Sravan liit" };
  page.elements.push({
    id: "element_179",
    kind: "button",
    role: "button",
    text: "Send"
  });
  const premature = agent.dropPrematureComposer(
    [
      { type: "fill", elementId: "element_65", text: "hi" },
      { type: "click", elementId: "element_179" }
    ],
    page,
    [],
    "in this there is a contact named sebum , send him a hi"
  );
  assert.equal(premature.actions.length, 0);
  page.elements.push({
    id: "element_200",
    kind: "button",
    role: "listitem",
    text: "sebum"
  });
  const afterClick = agent.dropPrematureComposer(
    [
      { type: "click", elementId: "element_200" },
      { type: "fill", elementId: "element_65", text: "hi" }
    ],
    page,
    [],
    "Open the chat named sebum, type hi, and send"
  );
  assert.deepEqual(
    afterClick.actions.map(function (action) {
      return action.type + " " + action.elementId;
    }),
    ["click element_200"]
  );
  assert.equal(agent.namedChatIsOpen(page, "Open the chat named sebum, type hi, and send"), false);

  page.page.openConversation = "sebum";
  page.page.goalChatOpen = true;
  const ready = agent.dropPrematureComposer(
    [{ type: "fill", elementId: "element_65", text: "hi" }],
    page,
    [
      {
        actions: [{ type: "click", elementId: "element_200" }],
        results: [{ ok: true, type: "click", elementId: "element_200" }],
        elements: [{ id: "element_200", role: "listitem", text: "sebum" }]
      }
    ],
    "Open the chat named sebum, type hi, and send"
  );
  assert.deepEqual(
    ready.actions.map(function (action) {
      return action.type + " " + action.elementId;
    }),
    ["fill element_65"]
  );
  assert.equal(agent.namedChatIsOpen(page, "Open the chat named sebum, type hi, and send"), true);
  assert.equal(agent.isGoalContactRow(page.elements[page.elements.length - 1], "Open the chat named sebum"), true);
  assert.equal(
    agent.isGoalContactRow(
      { id: "element_145", role: "listitem", text: "sebum last seen yesterday at 3:40" },
      "Open the chat named sebum"
    ),
    true
  );
  assert.equal(agent.openTitleMatchesContact("Sebum 💪 last seen today at 11:49", "sebum"), true);
  assert.equal(agent.titleMatchesContact("Sebum 💪 last seen today at 11:49", "sebum"), true);
  assert.equal(
    agent.namedChatIsOpen(
      { page: { goalChatOpen: false, openConversation: "Sebum 💪" } },
      "Open the chat named sebum, type hi, and send"
    ),
    true
  );
});

test("stale chat row ids remap onto the current snapshot", () => {
  const previous = [{ id: "element_136", kind: "button", role: "listitem", text: "sebum" }];
  const page = context();
  page.elements.push({
    id: "element_200",
    kind: "button",
    role: "listitem",
    text: "sebum"
  });
  page.elements.push({
    id: "element_201",
    kind: "button",
    role: "listitem",
    text: "Builders Sebum reacted to a message"
  });
  const stable = agent.stabilizeActions(
    [{ type: "click", elementId: "element_136" }],
    page,
    previous
  );
  assert.deepEqual(stable.dropped, []);
  assert.equal(stable.actions[0].elementId, "element_200");
  assert.equal(agent.validateActions(stable.actions, page).ok, true);

  const missing = agent.stabilizeActions(
    [{ type: "click", elementId: "element_136" }],
    context(),
    previous
  );
  assert.deepEqual(missing.dropped, ["element_136"]);
  assert.equal(missing.actions.length, 0);
});

test("action validation rejects credentials and excessive bounds, skips unknown ids", () => {
  const unknown = agent.validateActions([{ type: "click", elementId: "element_99" }], context());
  assert.equal(unknown.ok, true);
  assert.equal(unknown.actions.length, 0);
  const named = agent.validateActions(
    [
      { type: "fill", elementId: "24emailadr", text: "<PROFILE_EMAIL>" },
      { type: "click", elementId: "not-a-target" }
    ],
    {
      ...context(),
      profile: globalThis.BrowserAgent.profileVault.publicCatalog({
        values: { email: "demo.user@example.com" }
      }),
      elements: [
        ...context().elements,
        {
          id: "element_8",
          tag: "input",
          kind: "input",
          inputType: "email",
          name: "24emailadr",
          text: "E-mail",
          sensitivityCategories: ["email"]
        }
      ]
    }
  );
  assert.equal(named.ok, true);
  assert.deepEqual(
    named.actions.map((action) => action.type + " " + action.elementId),
    ["fill element_8"]
  );
  const numbered = agent.parseResponse({
    actions: [{ type: "click", elementId: 1 }],
    done: false
  });
  assert.equal(numbered.ok, true);
  assert.equal(numbered.actions[0].elementId, "element_1");
  assert.equal(
    agent.validateActions(
      [{ type: "fill", elementId: "element_2", text: "<PASSWORD_1>" }],
      context()
    ).ok,
    false
  );
  const longWait = agent.validateActions([{ type: "wait", ms: 6000 }], context());
  assert.equal(longWait.ok, true);
  assert.equal(longWait.actions[0].ms, 5000);
  assert.equal(longWait.clampedWaits.length, 1);
  assert.equal(longWait.clampedWaits[0].requested, 6000);
  const stringWait = agent.validateActions([{ type: "wait", ms: "8000" }], context());
  assert.equal(stringWait.ok, true);
  assert.equal(stringWait.actions[0].ms, 5000);
  assert.equal(agent.validateActions([{ type: "wait", ms: "nope" }], context()).ok, false);
  assert.equal(agent.MAX_GATE_WAIT_MS >= 10 * 60 * 1000, true);
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

test("YuNet face filter keeps the portrait and drops ID-card clutter", () => {
  const filtered = filterFaceDetections(
    [
      { label: "face", confidence: 0.89, boundingBox: { x: 1148, y: 532, width: 78, height: 101 } },
      { label: "face", confidence: 0.57, boundingBox: { x: 400, y: 300, width: 70, height: 90 } },
      { label: "face", confidence: 0.55, boundingBox: { x: 1400, y: 500, width: 90, height: 90 } },
      { label: "face", confidence: 0.51, boundingBox: { x: 900, y: 700, width: 220, height: 40 } },
      { label: "face", confidence: 0.45, boundingBox: { x: 800, y: 400, width: 60, height: 70 } }
    ],
    2880,
    1462
  );
  assert.deepEqual(
    filtered.map((det) => det.confidence),
    [0.89, 0.57]
  );
});

test("screenshot sanitizer does not black out an entire <img>", () => {
  const detections = normalizeDetections(
    {
      viewport: {
        width: 100,
        height: 100,
        visualWidth: 100,
        visualHeight: 100,
        offsetLeft: 0,
        offsetTop: 0,
        scrollX: 0,
        scrollY: 0
      },
      elements: [
        {
          id: "element_img",
          tag: "img",
          kind: "image",
          viewportBox: { x: 0, y: 0, width: 100, height: 100 }
        },
        {
          id: "element_name",
          tag: "span",
          kind: "text",
          viewportBox: { x: 10, y: 10, width: 20, height: 8 }
        }
      ]
    },
    {
      records: [
        { elementId: "element_img", category: "person_name", confidence: "model" },
        { elementId: "element_name", category: "person_name", confidence: "model" }
      ]
    },
    { image: { width: 100, height: 100 }, detections: [] },
    null
  );
  assert.deepEqual(
    detections.map((item) => item.elementId),
    ["element_name"]
  );
});

test("content applicator refuses unknown, one-way and OTP values", () => {
  const dom = new JSDOM(
    `<input id="email" data-browser-agent-id="element_1">
     <input id="otp" name="otp" autocomplete="one-time-code" data-browser-agent-id="element_2">`,
    { runScripts: "outside-only", url: "http://example.test/" }
  );
  dom.window.eval(fs.readFileSync("src/agent/protocol.js", "utf8"));
  dom.window.eval(fs.readFileSync("src/privacy/profileVault.js", "utf8"));
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

test("local profile catalog never includes values and rejects blocked categories", () => {
  const profile = globalThis.BrowserAgent.profileVault;
  const store = profile.sanitizeStore({
    values: {
      email: "demo.user@example.com",
      aadhaar: "789012345674",
      password: "hunter2"
    }
  });
  assert.equal(store.values.email, "demo.user@example.com");
  assert.equal(store.values.aadhaar, "789012345674");
  assert.equal(store.values.password, undefined);
  const catalog = profile.publicCatalog(store);
  assert.equal(catalog.available.email, true);
  assert.equal(catalog.tokens.email, "<PROFILE_EMAIL>");
  assert.doesNotMatch(JSON.stringify(catalog), /demo\.user@example\.com|789012345674|hunter2/);
  assert.equal(profile.validateValue("password", "hunter2").ok, false);
  assert.equal(profile.validateValue("aadhaar", "1234 1234 1234 7382").ok, true);
  assert.equal(profile.validateValue("ssn", "test-ssn").ok, true);
  assert.equal(profile.validateValue("comments", "hello").ok, true);
  const ids = profile.allowedCategories().map((item) => item.id);
  assert.equal(ids.includes("card_holder_name"), true);
  assert.equal(ids.includes("driver_license"), true);
  assert.equal(ids.includes("ssn"), true);
  assert.equal(ids.includes("company"), true);
  assert.equal(ids.includes("country"), true);
  assert.equal(ids.includes("card_type"), true);
  assert.equal(ids.includes("person_title"), true);
  assert.equal(ids.includes("security_pin"), true);
  assert.equal(ids.includes("password"), false);
  assert.equal(ids.includes("cvv"), false);
  assert.equal(ids.includes("otp"), false);
});

test("profile tokens are purpose-bound and leak-checked", () => {
  const page = context();
  page.profile = globalThis.BrowserAgent.profileVault.publicCatalog({
    values: { email: "demo.user@example.com" }
  });
  assert.equal(
    agent.validateActions(
      [{ type: "fill", elementId: "element_1", text: "<PROFILE_EMAIL>" }],
      page
    ).ok,
    true
  );
  assert.equal(
    agent.validateActions(
      [{ type: "fill", elementId: "element_2", text: "<PROFILE_EMAIL>" }],
      page
    ).ok,
    false
  );

  const profile = globalThis.BrowserAgent.profileVault;
  assert.equal(
    profile.fieldAcceptsCategory(
      { name: "10address1", text: "Address Line 1" },
      "address"
    ),
    true
  );
  assert.equal(
    profile.fieldAcceptsCategory({ name: "13adr_city", text: "City" }, "address"),
    true
  );
  assert.equal(
    profile.fieldAcceptsCategory({ name: "14adrstate", text: "State / Province" }, "address"),
    true
  );
  assert.equal(
    profile.fieldAcceptsCategory({ name: "05_company", text: "Company" }, "address"),
    false
  );
  assert.equal(
    profile.fieldAcceptsCategory({ name: "05_company", text: "Company" }, "company"),
    true
  );
  assert.equal(
    profile.fieldAcceptsCategory({ name: "01___title", text: "Title" }, "person_title"),
    true
  );
  assert.equal(
    profile.fieldAcceptsCategory({ name: "06position", text: "Position" }, "position"),
    true
  );
  assert.equal(
    profile.fieldAcceptsCategory({ name: "15_country", text: "Country" }, "country"),
    true
  );
  assert.equal(
    profile.fieldAcceptsCategory({ name: "32_cctype", text: "Credit Card Type" }, "card_type"),
    true
  );
  assert.equal(
    profile.fieldAcceptsCategory({ name: "30__userid", text: "User ID" }, "username"),
    true
  );

  const form = structuredClone(page);
  form.profile = profile.publicCatalog({
    values: { email: "demo.user@example.com", address: "House no. 252" }
  });
  form.elements = form.elements.concat([
    { id: "element_3", tag: "input", kind: "input", name: "10address1", text: "Address Line 1" },
    { id: "element_4", tag: "input", kind: "input", name: "13adr_city", text: "City" },
    { id: "element_5", tag: "input", kind: "input", name: "05_company", text: "Company" }
  ]);
  const mixed = agent.validateActions(
    [
      { type: "fill", elementId: "element_1", text: "<PROFILE_EMAIL>" },
      { type: "fill", elementId: "element_3", text: "<PROFILE_ADDRESS>" },
      { type: "fill", elementId: "element_4", text: "<PROFILE_ADDRESS>" },
      { type: "fill", elementId: "element_5", text: "<PROFILE_ADDRESS>" }
    ],
    form
  );
  assert.equal(mixed.ok, true);
  assert.deepEqual(
    mixed.actions.map((action) => action.elementId),
    ["element_1", "element_3", "element_4"]
  );

  const withCompany = structuredClone(form);
  withCompany.profile = profile.publicCatalog({
    values: { email: "demo.user@example.com", company: "Acme Corp" }
  });
  const companyFill = agent.validateActions(
    [{ type: "fill", elementId: "element_5", text: "<PROFILE_COMPANY>" }],
    withCompany
  );
  assert.equal(companyFill.ok, true);
  assert.deepEqual(
    companyFill.actions.map((action) => action.elementId),
    ["element_5"]
  );
  const leaked = structuredClone(context());
  leaked.page.title = "contact demo.user@example.com";
  const repaired = agent.prepareOutbound("go", leaked, {}, {
    values: { email: "demo.user@example.com" }
  });
  assert.equal(repaired.ok, true);
  assert.doesNotMatch(JSON.stringify(repaired.payload), /demo\.user@example\.com/);
  assert.match(JSON.stringify(repaired.payload), /<PROFILE_EMAIL>/);

  const pinPage = structuredClone(context());
  pinPage.page.url = "http://example.test/item/12410399";
  const pinOk = agent.prepareOutbound("go", pinPage, {}, { values: { pin_code: "124103" } });
  assert.equal(pinOk.ok, true);

  const spaced = structuredClone(context());
  spaced.page.title = "call +91 98765 43210 now";
  const phoneOk = agent.prepareOutbound("go", spaced, {}, { values: { phone: "9876543210" } });
  assert.equal(phoneOk.ok, true);
  assert.doesNotMatch(JSON.stringify(phoneOk.payload), /98765\s*43210|9876543210/);
  assert.match(JSON.stringify(phoneOk.payload), /<PROFILE_PHONE>/);

  const named = structuredClone(context());
  named.page.title = "kartik  bhardwaj (You)";
  named.page.openConversation = "Kartik Bhardwaj";
  const nameOk = agent.prepareOutbound("go", named, {}, { values: { person_name: "Kartik Bhardwaj" } });
  assert.equal(nameOk.ok, true);
  assert.doesNotMatch(JSON.stringify(nameOk.payload), /kartik/i);
  assert.match(JSON.stringify(nameOk.payload), /<PROFILE_NAME>/);

  const intact = structuredClone(context());
  intact.page.title = "Manila airport";
  const shortName = agent.prepareOutbound("go", intact, {}, { values: { person_name: "Anil" } });
  assert.equal(shortName.ok, true);
  assert.match(JSON.stringify(shortName.payload), /Manila/);
});

test("applicator expands profile tokens or leaves the field empty", () => {
  const dom = new JSDOM(
    `<input id="email" type="email" data-browser-agent-id="element_1">
     <input id="aadhaar" name="aadhaar" data-browser-agent-id="element_3">`,
    { runScripts: "outside-only", url: "http://example.test/" }
  );
  dom.window.eval(fs.readFileSync("src/agent/protocol.js", "utf8"));
  dom.window.eval(fs.readFileSync("src/privacy/profileVault.js", "utf8"));
  dom.window.eval(fs.readFileSync("src/agent/apply.js", "utf8"));
  const apply = dom.window.BrowserAgent.agentApply;
  const elements = [
    { id: "element_1", inputType: "email", sensitivityCategories: ["email"] },
    { id: "element_3", name: "aadhaar", sensitivityCategories: ["aadhaar"] }
  ];
  const filled = apply.applyAction(
    { type: "fill", elementId: "element_1", text: "<PROFILE_EMAIL>" },
    {},
    {
      profileMap: { "<PROFILE_EMAIL>": "demo.user@example.com" },
      elements: elements
    }
  );
  assert.equal(filled.ok, true);
  assert.equal(filled.skipped, undefined);
  assert.equal(dom.window.document.getElementById("email").value, "demo.user@example.com");

  const skipped = apply.applyAction(
    { type: "fill", elementId: "element_1", text: "<PROFILE_EMAIL>" },
    {},
    { profileMap: {}, elements: elements }
  );
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);

  const blocked = apply.applyAction(
    { type: "fill", elementId: "element_3", text: "<PROFILE_AADHAAR>" },
    {},
    {
      profileMap: { "<PROFILE_AADHAAR>": "789012345674" },
      elements: elements,
      allowHighRisk: false
    }
  );
  assert.equal(blocked.ok, true);
  assert.equal(blocked.skipped, true);
  assert.equal(dom.window.document.getElementById("aadhaar").value, "");

  const invented = apply.applyAction(
    { type: "fill", elementId: "element_1", text: "Acme Corp" },
    {},
    { profileMap: {}, elements: elements }
  );
  assert.equal(invented.ok, true);
  assert.equal(invented.skipped, true);
  assert.equal(dom.window.document.getElementById("email").value, "demo.user@example.com");

  const fromGoal = apply.applyAction(
    { type: "fill", elementId: "element_1", text: "hi there" },
    {},
    { profileMap: {}, elements: elements, goal: "write to Sravan, hi there" }
  );
  assert.equal(fromGoal.ok, true);
  assert.equal(fromGoal.skipped, undefined);
  assert.equal(dom.window.document.getElementById("email").value, "hi there");
});

test("profile card type selects a matching option and skips password", () => {
  const dom = new JSDOM(
    `<select id="cctype" name="32_cctype" data-browser-agent-id="element_2">
       <option>(Select Card Type)</option>
       <option>Visa (Preferred)</option>
       <option>Master Card</option>
     </select>
     <input id="password" type="password" name="password" data-browser-agent-id="element_9">`,
    { runScripts: "outside-only", url: "http://example.test/" }
  );
  dom.window.eval(fs.readFileSync("src/utils/sensitivityCatalog.js", "utf8"));
  dom.window.eval(fs.readFileSync("src/agent/protocol.js", "utf8"));
  dom.window.eval(fs.readFileSync("src/privacy/profileVault.js", "utf8"));
  dom.window.eval(fs.readFileSync("src/agent/apply.js", "utf8"));
  const apply = dom.window.BrowserAgent.agentApply;
  const selected = apply.applyAction(
    { type: "select", elementId: "element_2", text: "<PROFILE_CARD_TYPE>" },
    {},
    {
      profileMap: { "<PROFILE_CARD_TYPE>": "Visa" },
      elements: [{ id: "element_2", tag: "select", name: "32_cctype", text: "Credit Card Type" }]
    }
  );
  assert.equal(selected.ok, true);
  assert.equal(selected.skipped, undefined);
  assert.equal(dom.window.document.getElementById("cctype").value, "Visa (Preferred)");

  const password = apply.applyAction(
    { type: "fill", elementId: "element_9", text: "hunter2" },
    {},
    { elements: [{ id: "element_9", inputType: "password", sensitivityCategories: ["password"] }] }
  );
  assert.equal(password.ok, false);
});

test("saved security PIN fills DigiLocker boxes and OTP still refuses", () => {
  const pinPage = {
    profile: {
      available: { security_pin: true },
      tokens: { security_pin: "<PROFILE_SECURITY_PIN>" }
    },
    elements: [
      {
        id: "element_1",
        tag: "input",
        inputType: "password",
        name: "pin1",
        text: "Enter 6 digit security PIN",
        sensitivityCategories: ["password", "security_pin"]
      },
      {
        id: "element_9",
        tag: "input",
        autocomplete: "one-time-code",
        name: "otp",
        text: "OTP",
        sensitivityCategories: ["otp"]
      }
    ]
  };
  const pinFill = agent.validateActions(
    [{ type: "fill", elementId: "element_1", text: "<PROFILE_SECURITY_PIN>" }],
    pinPage
  );
  assert.equal(pinFill.ok, true);
  assert.equal(pinFill.actions.length, 1);

  const otpFill = agent.validateActions(
    [{ type: "fill", elementId: "element_9", text: "<PROFILE_SECURITY_PIN>" }],
    pinPage
  );
  assert.equal(otpFill.ok, false);

  const dom = new JSDOM(
    `<section>
       <h1>Enter 6 digit security PIN</h1>
       <input id="p1" type="password" maxlength="1" name="pin1" data-browser-agent-id="element_1">
       <input id="p2" type="password" maxlength="1" name="pin2" data-browser-agent-id="element_2">
       <input id="p3" type="password" maxlength="1" name="pin3" data-browser-agent-id="element_3">
       <input id="p4" type="password" maxlength="1" name="pin4" data-browser-agent-id="element_4">
       <input id="p5" type="password" maxlength="1" name="pin5" data-browser-agent-id="element_5">
       <input id="p6" type="password" maxlength="1" name="pin6" data-browser-agent-id="element_6">
     </section>
     <input id="otp" name="otp" autocomplete="one-time-code" data-browser-agent-id="element_9">`,
    { runScripts: "outside-only", url: "http://example.test/" }
  );
  dom.window.eval(fs.readFileSync("src/utils/sensitivityCatalog.js", "utf8"));
  dom.window.eval(fs.readFileSync("src/agent/protocol.js", "utf8"));
  dom.window.eval(fs.readFileSync("src/privacy/profileVault.js", "utf8"));
  dom.window.eval(fs.readFileSync("src/agent/apply.js", "utf8"));
  const apply = dom.window.BrowserAgent.agentApply;
  const elements = [
    {
      id: "element_1",
      tag: "input",
      inputType: "password",
      name: "pin1",
      text: "Enter 6 digit security PIN",
      sensitivityCategories: ["security_pin"]
    }
  ];
  const filled = apply.applyAction(
    { type: "fill", elementId: "element_1", text: "<PROFILE_SECURITY_PIN>" },
    {},
    {
      profileMap: { "<PROFILE_SECURITY_PIN>": "482910" },
      elements: elements
    }
  );
  assert.equal(filled.ok, true);
  assert.equal(dom.window.document.getElementById("p1").value, "4");
  assert.equal(dom.window.document.getElementById("p2").value, "8");
  assert.equal(dom.window.document.getElementById("p3").value, "2");
  assert.equal(dom.window.document.getElementById("p4").value, "9");
  assert.equal(dom.window.document.getElementById("p5").value, "1");
  assert.equal(dom.window.document.getElementById("p6").value, "0");

  const otp = apply.applyAction(
    { type: "fill", elementId: "element_9", text: "123456" },
    {},
    { elements: [{ id: "element_9", autocomplete: "one-time-code", sensitivityCategories: ["otp"] }] }
  );
  assert.equal(otp.ok, false);
});

test("nested DigiLocker PIN boxes fill from the saved profile even if the model only clicks", () => {
  const html = fs.readFileSync("examples/digilocker-pin.html", "utf8");
  const page = new JSDOM(html, {
    pretendToBeVisual: true,
    url: "https://accounts.digilocker.gov.in/signin",
    runScripts: "outside-only"
  });
  const box = { left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40, x: 0, y: 0 };
  page.window.Element.prototype.getBoundingClientRect = function () {
    return box;
  };
  contentScriptFiles(path.resolve(".")).forEach(function (file) {
    page.window.eval(fs.readFileSync(file, "utf8"));
  });
  const snapshot = page.window.BrowserAgent.extractPage({ mode: "visible" });
  const pinBoxes = snapshot.elements.filter((el) => el.tag === "input");
  assert.equal(pinBoxes.length, 6);
  pinBoxes.forEach((el) => {
    assert.equal((el.sensitivityCategories || []).includes("security_pin"), true, el.id);
    assert.equal((el.sensitivityCategories || []).includes("otp"), false, el.id);
  });

  const pinContext = {
    redacted: true,
    page: { title: "DigiLocker", url: "https://accounts.digilocker.gov.in/signin" },
    elements: snapshot.elements,
    profile: {
      available: { security_pin: true },
      tokens: { security_pin: "<PROFILE_SECURITY_PIN>" }
    }
  };
  const gate = agent.findAuthGate(pinContext);
  assert.equal(gate.kind, "pin");
  assert.equal(gate.blocking, false);
  assert.equal(gate.emptyCount, 6);
  assert.match(agent.unfinishedGoalReason(pinContext, "download my aadhaar"), /security PIN/i);

  const forgot = snapshot.elements.find((el) => /forgot/i.test(String(el.text || "")));
  assert.ok(forgot, "Forgot security PIN link should be in the snapshot");
  const stable = agent.stabilizeActions([{ type: "click", elementId: forgot.id }], pinContext);
  assert.equal(stable.injectedPin, true);
  assert.equal(stable.actions.length, 1);
  assert.equal(stable.actions[0].type, "fill");
  assert.equal(stable.actions[0].text, "<PROFILE_SECURITY_PIN>");

  const validated = agent.validateActions(
    stable.actions,
    pinContext,
    "login into digilocker and download my aadhaar card"
  );
  assert.equal(validated.ok, true);
  assert.equal(validated.actions[0].type, "fill");

  const apply = page.window.BrowserAgent.agentApply;
  const filled = apply.applyAction(
    validated.actions[0],
    {},
    {
      profileMap: { "<PROFILE_SECURITY_PIN>": "482910" },
      elements: snapshot.elements
    }
  );
  assert.equal(filled.ok, true);
  assert.equal(filled.skipped, undefined);
  const inputs = page.window.document.querySelectorAll("input[type='password']");
  assert.equal(inputs[0].value, "4");
  assert.equal(inputs[1].value, "8");
  assert.equal(inputs[2].value, "2");
  assert.equal(inputs[3].value, "9");
  assert.equal(inputs[4].value, "1");
  assert.equal(inputs[5].value, "0");
});

test("saved PIN fills hidden DigiLocker boxes that the snapshot may omit", () => {
  const html = `<!doctype html><body>
    <div>Enter 6 digit security PIN</div>
    <div class="pin-row">
      <input style="opacity:0" type="password" maxlength="1">
      <input style="opacity:0" type="password" maxlength="1">
      <input style="opacity:0" type="password" maxlength="1">
      <input style="opacity:0" type="password" maxlength="1">
      <input style="opacity:0" type="password" maxlength="1">
      <input style="opacity:0" type="password" maxlength="1">
    </div>
    <a href="#forgot">Forgot security PIN?</a>
  </body>`;
  const page = new JSDOM(html, {
    pretendToBeVisual: true,
    url: "https://accounts.digilocker.gov.in/signin",
    runScripts: "outside-only"
  });
  page.window.Element.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40, x: 0, y: 0 };
  };
  contentScriptFiles(path.resolve(".")).forEach(function (file) {
    page.window.eval(fs.readFileSync(file, "utf8"));
  });
  const filled = page.window.BrowserAgent.agentApply.fillSavedSecurityPin({
    "<PROFILE_SECURITY_PIN>": "482910"
  });
  assert.equal(filled.filled, true);
  const inputs = page.window.document.querySelectorAll("input");
  assert.equal(inputs[0].value, "4");
  assert.equal(inputs[5].value, "0");
});

test("chat list rows stay labeled after long preview text and clicks survive restamps", () => {
  const html = `<!doctype html><body>
    <div role="searchbox" contenteditable="true">Search</div>
    <div role="listitem">
      <span>sebum</span>
      <span>Toh last message that is quite long and would previously swallow the contact name into truncated text</span>
    </div>
    <div role="listitem">
      <span>Builders</span>
      <span>Sebum reacted to a message</span>
    </div>
    <div contenteditable="true">Type a message</div>
  </body>`;
  const page = new JSDOM(html, {
    pretendToBeVisual: true,
    url: "https://web.whatsapp.com/",
    runScripts: "outside-only"
  });
  const box = { left: 0, top: 0, right: 200, bottom: 20, width: 200, height: 20, x: 0, y: 0 };
  page.window.Element.prototype.getBoundingClientRect = function () {
    return box;
  };
  contentScriptFiles(path.resolve(".")).forEach(function (file) {
    page.window.eval(fs.readFileSync(file, "utf8"));
  });
  const snapshot = page.window.BrowserAgent.extractPage({ mode: "visible" });
  const rows = snapshot.elements.filter(function (element) {
    return element.role === "listitem";
  });
  const row = rows.find(function (element) {
    return /sebum/i.test(String(element.text || ""));
  });
  const builders = rows.find(function (element) {
    return /builders/i.test(String(element.text || ""));
  });
  assert.ok(row, "listitem chat rows must be in the agent snapshot");
  assert.equal(row.interactive, true);
  assert.match(String(row.text || ""), /sebum/i);
  assert.doesNotMatch(String(row.text || ""), /TRUNCATED/i);
  assert.ok(builders, "group rows must keep the group title");
  assert.doesNotMatch(String(builders.text || ""), /^sebum/i);

  let clicked = "";
  const listitem = page.window.document.querySelector("[role=listitem]");
  listitem.addEventListener("click", function () {
    clicked = "row";
  });
  listitem.removeAttribute("data-browser-agent-id");
  const applied = page.window.BrowserAgent.agentApply.applyAction(
    { type: "click", elementId: row.id },
    {},
    { elements: snapshot.elements, goal: "Open the chat named sebum and type hi there" }
  );
  assert.equal(applied.ok, true);
  assert.equal(clicked, "row");
});

test("open conversation is the main header, not a selected search row", () => {
  const html = `<!doctype html><body>
    <div id="pane-side">
      <div role="listitem" aria-selected="true"><span>sebum</span></div>
    </div>
    <div id="main">
      <header><span title="Kartik Bhardwaj">Kartik Bhardwaj</span></header>
      <div contenteditable="true">Type a message</div>
    </div>
  </body>`;
  const page = new JSDOM(html, {
    pretendToBeVisual: true,
    url: "https://web.whatsapp.com/",
    runScripts: "outside-only"
  });
  const box = { left: 0, top: 0, right: 200, bottom: 20, width: 200, height: 20, x: 0, y: 0 };
  page.window.Element.prototype.getBoundingClientRect = function () {
    return box;
  };
  contentScriptFiles(path.resolve(".")).forEach(function (file) {
    page.window.eval(fs.readFileSync(file, "utf8"));
  });
  const snapshot = page.window.BrowserAgent.extractPage({ mode: "visible" });
  assert.equal(snapshot.page.openConversation, "Kartik Bhardwaj");
  page.window.BrowserAgent.agent.markGoalChatOpen(
    snapshot,
    "Open the chat named sebum, type hi, and send"
  );
  assert.equal(snapshot.page.goalChatOpen, false);
  snapshot.redacted = true;
  const outbound = page.window.BrowserAgent.agent.prepareOutbound(
    "Open the chat named sebum, type hi, and send",
    snapshot,
    {}
  );
  assert.equal(outbound.ok, true);
  assert.match(outbound.payload.context.observation, /not the open conversation/i);
});

test("open conversation matches a WhatsApp header with emoji and last seen", () => {
  const html = `<!doctype html><body>
    <div id="pane-side">
      <div role="listitem" aria-selected="true"><span>Sebum 💪</span><span>Aaj hai meet already</span></div>
    </div>
    <div id="main">
      <header>
        <span title="Search">Search</span>
        <span title="Menu">Menu</span>
        <span title="Sebum 💪">Sebum 💪</span>
        <span>last seen today at 11:49</span>
      </header>
      <div contenteditable="true">Type a message</div>
    </div>
  </body>`;
  const page = new JSDOM(html, {
    pretendToBeVisual: true,
    url: "https://web.whatsapp.com/",
    runScripts: "outside-only"
  });
  const box = { left: 0, top: 0, right: 200, bottom: 20, width: 200, height: 20, x: 0, y: 0 };
  page.window.Element.prototype.getBoundingClientRect = function () {
    return box;
  };
  page.window.document.title = "(1) Sebum 💪";
  contentScriptFiles(path.resolve(".")).forEach(function (file) {
    page.window.eval(fs.readFileSync(file, "utf8"));
  });
  const snapshot = page.window.BrowserAgent.extractPage({ mode: "visible" });
  assert.match(snapshot.page.openConversation, /sebum/i);
  page.window.BrowserAgent.agent.markGoalChatOpen(
    snapshot,
    "Open the chat named sebum, type hi, and send"
  );
  assert.equal(snapshot.page.goalChatOpen, true);
  snapshot.redacted = true;
  const outbound = page.window.BrowserAgent.agent.prepareOutbound(
    "Open the chat named sebum, type hi, and send",
    snapshot,
    {}
  );
  assert.equal(outbound.ok, true);
  assert.match(outbound.payload.context.observation, /named chat is open/i);
});

test("screenshot gallery only accepts sanitizer-branded JPEGs", () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("src/popup/screenshotFrames.js", "utf8"), context);
  const api = context.BrowserAgent.screenshotFrames;
  const shot = {
    sanitized: true,
    kind: "sanitized-screenshot-v1",
    dataUrl: "data:image/jpeg;base64,/9j/4AAQ"
  };
  const raw = {
    sanitized: false,
    kind: "sanitized-screenshot-v1",
    dataUrl: "data:image/png;base64,AAAA"
  };
  assert.equal(api.brandedScreenshot(shot), true);
  assert.equal(api.brandedScreenshot(raw), false);
  assert.equal(api.listFrom({ sanitizedScreenshot: raw }).length, 0);
  const listed = api.listFrom({
    sanitizedScreenshots: [
      { step: 2, title: "Checkout", url: "https://shop.test/<EMAIL_1>", transmitted: true, screenshot: shot },
      { step: 1, title: "Cart", url: "https://shop.test/cart", transmitted: false, screenshot: shot },
      { step: 3, title: "Ignored", screenshot: raw }
    ]
  });
  assert.equal(listed.length, 2);
  assert.equal(listed[0].step, 1);
  assert.equal(listed[1].step, 2);
  const replaced = api.upsert(listed, {
    step: 2,
    title: "Payment",
    url: "https://shop.test/pay",
    transmitted: true,
    screenshot: shot
  });
  assert.equal(replaced.length, 2);
  assert.equal(replaced[1].title, "Payment");
  const withFinal = api.upsert(replaced, {
    step: 2,
    phase: "final",
    title: "Receipt",
    url: "https://shop.test/receipt",
    transmitted: false,
    screenshot: shot
  });
  assert.equal(withFinal.length, 3);
  assert.equal(withFinal[1].title, "Payment");
  assert.equal(withFinal[2].title, "Receipt");
  assert.match(api.note(replaced[0], "hybrid", 2), /2 screens in this task/);
  assert.match(api.emptyNote("dom"), /DOM-only mode/);
});

test("clicks and Enter are treated as possible navigation", () => {
  assert.equal(agent.actionsMayNavigate([{ type: "scroll", x: 0, y: 400 }]), false);
  assert.equal(agent.actionsMayNavigate([{ type: "click", elementId: "element_1" }]), true);
  assert.equal(agent.actionsMayNavigate([{ type: "press", elementId: "element_1", key: "Enter" }]), true);
  assert.equal(agent.actionsMayNavigate([{ type: "press", elementId: "element_1", key: "Tab" }]), false);
});

test("auth gates detect OTP and PIN but ignore generic passwords", () => {
  const passwordOnly = agent.findAuthGate(context());
  assert.equal(passwordOnly.present, false);
  assert.equal(passwordOnly.blocking, false);

  const otpPage = {
    elements: [
      {
        id: "element_9",
        tag: "input",
        inputType: "text",
        autocomplete: "one-time-code",
        name: "otp",
        text: "OTP",
        hasUserValue: false,
        sensitivityCategories: ["otp"]
      }
    ]
  };
  const emptyOtp = agent.findAuthGate(otpPage);
  assert.equal(emptyOtp.present, true);
  assert.equal(emptyOtp.blocking, true);
  assert.equal(emptyOtp.kind, "otp");
  assert.equal(emptyOtp.emptyCount, 1);

  const filledOtp = agent.findAuthGate({
    elements: [{ ...otpPage.elements[0], hasUserValue: true }]
  });
  assert.equal(filledOtp.present, true);
  assert.equal(filledOtp.blocking, false);
  assert.equal(filledOtp.filledCount, 1);

  const pinElements = [
    {
      id: "element_10",
      tag: "input",
      inputType: "password",
      name: "mpin",
      text: "mPIN",
      hasUserValue: false,
      sensitivityCategories: ["password", "security_pin"]
    }
  ];
  const pinPage = agent.findAuthGate({ elements: pinElements });
  assert.equal(pinPage.blocking, true);
  assert.equal(pinPage.kind, "pin");

  const pinWithProfile = agent.findAuthGate({
    profile: { available: { security_pin: true }, tokens: { security_pin: "<PROFILE_SECURITY_PIN>" } },
    elements: pinElements
  });
  assert.equal(pinWithProfile.present, true);
  assert.equal(pinWithProfile.blocking, false);
  assert.equal(pinWithProfile.kind, "pin");

  const otpStillBlocks = agent.findAuthGate({
    profile: { available: { security_pin: true }, tokens: { security_pin: "<PROFILE_SECURITY_PIN>" } },
    elements: otpPage.elements.concat(pinElements)
  });
  assert.equal(otpStillBlocks.blocking, true);
  assert.equal(otpStillBlocks.kind, "otp");

  const outboundPassword = agent.prepareOutbound("fill the form", context(), {
    "<EMAIL_1>": "demo.user@example.com"
  });
  assert.equal(outboundPassword.ok, true);
  assert.equal(outboundPassword.payload.context.page.authGate, undefined);

  const otpContext = {
    redacted: true,
    page: { title: "Login", url: "https://digilocker.test/otp" },
    elements: otpPage.elements
  };
  const outboundOtp = agent.prepareOutbound("download my certificate", otpContext, {});
  assert.equal(outboundOtp.ok, true);
  assert.deepEqual(outboundOtp.payload.context.page.authGate, {
    present: true,
    blocking: true,
    kind: "otp"
  });
  assert.match(outboundOtp.payload.context.observation, /empty one-time code/i);
  assert.match(outboundOtp.payload.context.observation, /do not mark the goal done/i);
  assert.match(agent.SYSTEM_PROMPT, /client pauses for the user/i);
  assert.match(agent.SYSTEM_PROMPT, /Do not wait for SMS\/OTP/i);
  assert.match(agent.SYSTEM_PROMPT, /PROFILE_SECURITY_PIN/);

  const pinContext = {
    redacted: true,
    page: { title: "DigiLocker", url: "https://digilocker.test/pin" },
    elements: pinElements
  };
  const outboundPin = agent.prepareOutbound(
    "download my certificate",
    pinContext,
    {},
    { values: { security_pin: "482910" } }
  );
  assert.equal(outboundPin.ok, true);
  assert.equal(outboundPin.payload.context.page.authGate.blocking, false);
  assert.match(outboundPin.payload.context.observation, /PROFILE_SECURITY_PIN/);
  assert.doesNotMatch(JSON.stringify(outboundPin.payload), /482910/);
});

test("auth gate resume policy waits for a human, then continues", () => {
  const blocking = { present: true, blocking: true, kind: "otp", emptyCount: 1, filledCount: 0 };
  const filled = { present: true, blocking: false, kind: "otp", emptyCount: 0, filledCount: 1 };
  assert.equal(agent.shouldResumeAuthGate({ gate: blocking, probeOk: true }).resume, false);
  assert.equal(agent.shouldResumeAuthGate({ gate: filled, probeOk: true }).resume, false);
  assert.equal(agent.shouldResumeAuthGate({ probeOk: false }).resume, false);

  const cleared = agent.shouldResumeAuthGate({
    gate: { present: false, blocking: false },
    probeOk: true
  });
  assert.equal(cleared.resume, true);
  assert.equal(cleared.reason, "cleared");

  const navigated = agent.shouldResumeAuthGate({
    gate: { present: false, blocking: false },
    probeOk: true,
    identityChanged: true
  });
  assert.equal(navigated.reason, "navigation");

  const continued = agent.shouldResumeAuthGate({
    gate: filled,
    probeOk: true,
    continueRequested: true
  });
  assert.equal(continued.resume, true);
  assert.equal(continued.reason, "continue");
  assert.equal(continued.ignoreKey, "");

  const anyway = agent.shouldResumeAuthGate({
    gate: blocking,
    probeOk: true,
    continueRequested: true,
    gateKey: "tab|otp|blocking"
  });
  assert.equal(anyway.resume, true);
  assert.equal(anyway.reason, "continue_anyway");
  assert.equal(anyway.ignoreKey, "tab|otp|blocking");
  assert.match(agent.authGateNotice(blocking).title, /one-time code/i);
  assert.match(agent.authGateNotice(blocking).detail, /10 minutes/i);
  assert.match(agent.authGateResumeDetail("cleared"), /Verification step finished/i);

  const manual = agent.authGateNotice({ kind: "manual", blocking: true, present: true });
  assert.equal(manual.kind, "manual");
  assert.match(manual.title, /Waiting for your input/i);
  assert.match(manual.detail, /Ctrl\+Shift\+U/);
  assert.equal(agent.authGateLabel("manual"), "your input");
});

test("agent session UI stays on the tab that ran the task", () => {
  assert.equal(agent.agentSessionBelongsToTab({ tabId: 12, status: "error" }, 12), true);
  assert.equal(agent.agentSessionBelongsToTab({ tabId: 12, status: "error" }, 99), false);
  assert.equal(agent.agentSessionBelongsToTab({ tabId: 12, status: "error" }, null), false);
  assert.equal(agent.agentSessionBelongsToTab({ tabId: null, status: "idle" }, 99), true);
  assert.equal(agent.agentSessionBelongsToTab(null, 99), true);
});

test("select-account screens are not treated as a finished goal", () => {
  const selectAccount = {
    redacted: true,
    page: { title: "Select Account" },
    redactionCounts: { replacements: 0, categories: {} },
    elements: [
      { id: "element_1", kind: "heading", tag: "h1", text: "Select Account", interactive: false },
      {
        id: "element_2",
        kind: "button",
        tag: "div",
        role: "button",
        text: "S***a* S***o** U***h*** Verified",
        interactive: true
      },
      {
        id: "element_3",
        kind: "button",
        tag: "div",
        role: "button",
        text: "S***a* U***h*** Unverified",
        interactive: true
      },
      {
        id: "element_4",
        kind: "button",
        tag: "button",
        text: "+ Create New Account",
        interactive: true
      }
    ]
  };
  const reason = agent.unfinishedGoalReason(
    selectAccount,
    "login into digilocker and download my aadhaar card"
  );
  assert.match(reason, /select an account/i);
  assert.deepEqual(
    agent.recoverUnfinishedAction(
      selectAccount,
      "login into digilocker and download my aadhaar card"
    ),
    { type: "click", elementId: "element_2" }
  );
  const prepared = agent.prepareOutbound("login into digilocker", selectAccount, {});
  assert.equal(prepared.ok, true);
  assert.match(prepared.payload.context.observation, /not complete/i);
  assert.match(prepared.payload.context.observation, /Verified account/i);
});
