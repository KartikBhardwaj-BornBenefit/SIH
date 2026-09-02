/**
 * Content script entry. Runs in the isolated world for the current tab
 * after the user asks the extension to analyze the page.
 *
 * Isolated world means: we can read the page DOM, but we do not share
 * JavaScript variables with the page's own scripts.
 */
var BrowserAgent = globalThis.BrowserAgent || {};

if (!globalThis.__browserAgentInstalled) {
  globalThis.__browserAgentInstalled = true;

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (!message || !message.type) {
      return;
    }

    if (message.type === BrowserAgent.MSG.PING) {
      sendResponse({ ok: true });
      return;
    }

    if (message.type === BrowserAgent.MSG.EXTRACT_DOM) {
      try {
        var snapshot = BrowserAgent.extractPage({
          mode: message.mode,
          sensitivityPolicy: message.sensitivityPolicy
        });
        sendResponse({ ok: true, snapshot: snapshot });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error)
        });
      }
    }
  });
}
