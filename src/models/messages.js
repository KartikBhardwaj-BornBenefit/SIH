/**
 * Shared message types. Keep these string values in sync across popup,
 * service worker, content script, and the offscreen vision host.
 */
var BrowserAgent = globalThis.BrowserAgent || {};

BrowserAgent.SCHEMA_VERSION = 2;

BrowserAgent.MODES = {
  VISIBLE: "visible",
  VIEWPORT: "viewport"
};

BrowserAgent.MSG = {
  PING: "PING",
  EXTRACT_DOM: "EXTRACT_DOM",
  FILL_FROM_VAULT: "FILL_FROM_VAULT",
  CLEAR_VAULT: "CLEAR_VAULT",
  AGENT_TURN: "AGENT_TURN",
  APPLY_ACTIONS: "APPLY_ACTIONS",
  RUN_AGENT: "RUN_AGENT",
  STOP_AGENT: "STOP_AGENT",
  AGENT_STATUS: "AGENT_STATUS",
  ANALYZE_PAGE: "ANALYZE_PAGE",
  VISION_INIT: "VISION_INIT",
  VISION_STATUS: "VISION_STATUS",
  ANALYZE_SCREEN: "ANALYZE_SCREEN",
  OFFSCREEN_LOAD: "OFFSCREEN_LOAD",
  OFFSCREEN_ANALYZE: "OFFSCREEN_ANALYZE",
  OFFSCREEN_STATUS: "OFFSCREEN_STATUS",
  // Named-entity recognition. NER_ANALYZE is sent by the content script
  // mid-extraction, so it is the one message that flows tab -> worker rather
  // than the other way around.
  NER_INIT: "NER_INIT",
  NER_STATUS: "NER_STATUS",
  NER_ANALYZE: "NER_ANALYZE",
  OFFSCREEN_NER_LOAD: "OFFSCREEN_NER_LOAD",
  OFFSCREEN_NER_ANALYZE: "OFFSCREEN_NER_ANALYZE",
  OFFSCREEN_NER_STATUS: "OFFSCREEN_NER_STATUS"
};

globalThis.BrowserAgent = BrowserAgent;
