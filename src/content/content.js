/**
 * Content script entry. Runs in the isolated world for the current tab
 * after the user asks the extension to analyze the page.
 *
 * Isolated world means: we can read the page DOM, but we do not share
 * JavaScript variables with the page's own scripts.
 *
 * The raw snapshot never leaves this file. It is redacted here, and only the
 * agentContext plus the session vault are handed back. Keeping the split on
 * this side of the message boundary is the whole point: there is no code path
 * that sends an unredacted snapshot anywhere.
 */
var BrowserAgent = globalThis.BrowserAgent || {};

if (!globalThis.__browserAgentInstalled) {
  globalThis.__browserAgentInstalled = true;

  /**
   * Placeholder to original value for the page as last analyzed. Lives in the
   * isolated world so de-referencing needs nothing from outside, and dies with
   * the page on navigation or reload. Never persisted.
   */
  var sessionVault = null;

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
        var safe = BrowserAgent.redaction.build(snapshot, message.sensitivityPolicy);
        sessionVault = safe.vault;
        sendResponse({
          ok: true,
          snapshot: safe.agentContext,
          vault: safe.vault,
          redaction: safe.redaction
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error)
        });
      }
      return;
    }

    // De-referencing. The caller supplies a placeholder, never a value, so
    // this cannot be used to inject arbitrary text into the page.
    if (message.type === BrowserAgent.MSG.FILL_FROM_VAULT) {
      try {
        sendResponse(
          BrowserAgent.redaction.fillFromVault(sessionVault, message.elementId, message.placeholder)
        );
      } catch (error) {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error)
        });
      }
      return;
    }

    if (message.type === BrowserAgent.MSG.CLEAR_VAULT) {
      sessionVault = null;
      sendResponse({ ok: true });
    }
  });
}
