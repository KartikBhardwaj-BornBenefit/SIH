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
  ANALYZE_PAGE: "ANALYZE_PAGE",
  VISION_INIT: "VISION_INIT",
  VISION_STATUS: "VISION_STATUS",
  ANALYZE_SCREEN: "ANALYZE_SCREEN",
  OFFSCREEN_LOAD: "OFFSCREEN_LOAD",
  OFFSCREEN_ANALYZE: "OFFSCREEN_ANALYZE",
  OFFSCREEN_STATUS: "OFFSCREEN_STATUS"
};

globalThis.BrowserAgent = BrowserAgent;
