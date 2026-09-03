/**
 * Content script entry. Runs in the isolated world for the current tab
 * after the user asks the extension to analyze the page.
 *
 * Isolated world means: we can read the page DOM, but we do not share
 * JavaScript variables with the page's own scripts.
 *
 * The raw snapshot never leaves this file. It is redacted here. Analyze
 * returns only agentContext and value-free redaction metadata. The vault
 * remains in this tab-scoped isolated world. The agent path returns a
 * leak-checked payload with no vault, and the service worker is the only
 * thing that may send that payload to the configured server.
 *
 * One qualification, since the NER pass makes the claim narrower than it
 * sounds. Named-entity recognition needs Transformers.js, which lives in the
 * offscreen document, so text has to cross a boundary to reach it. What
 * crosses is the output of the rule pass — prose with every checksum-verified
 * identifier already replaced by a placeholder — and only entity spans come
 * back. The vault never moves, and the destination is another local
 * extension context, not the network.
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
  var sessionMinter = null;

  /**
   * Categories that only a model can find. If none of them is enabled we skip
   * the NER round trip entirely, which also means the weights are never
   * downloaded — the cheapest possible way to honour the setting.
   */
  var MODEL_CATEGORIES = ["person_name"];

  function wantsModelPass(policy) {
    var normalized = BrowserAgent.normalizeSensitivityPolicy
      ? BrowserAgent.normalizeSensitivityPolicy(policy)
      : policy || {};
    return MODEL_CATEGORIES.some(function (category) {
      return Boolean(normalized[category]);
    });
  }

  /**
   * Second redaction pass.
   *
   * Runs on the output of the rule pass, so the strings handed to the model
   * already have every checksum-verified identifier replaced. If the model is
   * unavailable we keep the rule-redacted result and report why, rather than
   * failing the whole analysis: a partially redacted snapshot is still safe,
   * and silently degrading would be worse than saying so.
   */
  async function applyModelPass(safe, policy) {
    var texts = BrowserAgent.redaction.textsForModel(safe.agentContext);
    if (!texts.length) {
      return { safe: safe, ner: null };
    }

    var response;
    try {
      response = await chrome.runtime.sendMessage({
        type: BrowserAgent.MSG.NER_ANALYZE,
        texts: texts
      });
    } catch (error) {
      return {
        safe: safe,
        ner: { ok: false, error: error && error.message ? error.message : String(error) }
      };
    }

    if (!response || !response.ok || !response.ner) {
      return {
        safe: safe,
        ner: {
          ok: false,
          error: (response && response.error) || "NER did not return a result.",
          status: response && response.status
        }
      };
    }

    var updated = BrowserAgent.redaction.applyEntities(
      safe.agentContext,
      response.ner.results,
      policy,
      safe.minter
    );

    return {
      safe: updated,
      ner: {
        ok: true,
        model: response.ner.model,
        modelId: response.ner.modelId,
        backend: response.ner.backend,
        inferenceTimeMs: response.ner.inferenceTimeMs,
        textsScanned: response.ner.textsScanned,
        entities: (response.ner.results || []).reduce(function (total, result) {
          return total + (result.entities || []).length;
        }, 0)
      }
    };
  }

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (!message || !message.type) {
      return;
    }

    if (message.type === BrowserAgent.MSG.PING) {
      sendResponse({ ok: true });
      return;
    }

    if (message.type === BrowserAgent.MSG.EXTRACT_DOM) {
      (async function () {
        try {
          var localStart = performance.now();
          var extractionStart = performance.now();
          var snapshot = BrowserAgent.extractPage({
            mode: message.mode,
            sensitivityPolicy: message.sensitivityPolicy
          });
          var domExtractionMs = Math.round(performance.now() - extractionStart);

          // Pass 1: rules and checksums, entirely inside this world.
          var ruleStart = performance.now();
          var safe = BrowserAgent.redaction.build(snapshot, message.sensitivityPolicy);
          var ruleRedactionMs = Math.round(performance.now() - ruleStart);
          var ner = null;

          // Pass 2: the model, if the user has asked for a category only a
          // model can find. The vault stays here either way.
          if (message.runNer !== false && wantsModelPass(message.sensitivityPolicy)) {
            var result = await applyModelPass(safe, message.sensitivityPolicy);
            safe = result.safe;
            ner = result.ner;
          }

          sessionVault = safe.vault;
          sessionMinter = safe.minter;
          sendResponse({
            ok: true,
            snapshot: safe.agentContext,
            redaction: safe.redaction,
            ner: ner,
            timings: {
              domExtractionMs: domExtractionMs,
              ruleRedactionMs: ruleRedactionMs,
              nerMs: (ner && ner.inferenceTimeMs) || 0,
              totalLocalTextMs: Math.round(performance.now() - localStart)
            }
          });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error && error.message ? error.message : String(error)
          });
        }
      })();
      return true;
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
      sessionMinter = null;
      sendResponse({ ok: true });
      return;
    }

    /**
     * One agent turn's extract + redact. The goal is rewritten against the
     * vault (and the identifier validators) before it leaves this world, so
     * a user who types a live email into the instruction box does not send it.
     * The vault itself is not in the response.
     */
    if (message.type === BrowserAgent.MSG.AGENT_TURN) {
      (async function () {
        try {
          var localStart = performance.now();
          var extractionStart = performance.now();
          var snapshot = BrowserAgent.extractPage({
            mode: message.mode,
            sensitivityPolicy: message.sensitivityPolicy
          });
          var domExtractionMs = Math.round(performance.now() - extractionStart);
          var ruleStart = performance.now();
          var safe = BrowserAgent.redaction.build(
            snapshot,
            message.sensitivityPolicy,
            sessionMinter || undefined
          );
          var ruleRedactionMs = Math.round(performance.now() - ruleStart);
          var ner = null;
          if (message.runNer !== false && wantsModelPass(message.sensitivityPolicy)) {
            var result = await applyModelPass(safe, message.sensitivityPolicy);
            safe = result.safe;
            ner = result.ner;
          }
          sessionVault = safe.vault;
          sessionMinter = safe.minter;

          var outboundGoal = BrowserAgent.agent.redactAgainstVault(message.goal || "", safe.vault);
          if (BrowserAgent.redaction.redactText) {
            outboundGoal = BrowserAgent.redaction.redactText(
              outboundGoal,
              message.sensitivityPolicy,
              safe.minter,
              { elementId: null, field: "goal" }
            );
            sessionVault = safe.vault;
          }

          var prepared = BrowserAgent.agent.prepareOutbound(
            outboundGoal,
            safe.agentContext,
            safe.vault
          );
          if (!prepared.ok) {
            sendResponse({ ok: false, error: prepared.error });
            return;
          }
          var historyLeaks = BrowserAgent.agent.findLeaks(
            JSON.stringify(message.history || []),
            safe.vault
          );
          if (historyLeaks.length) {
            sendResponse({
              ok: false,
              error: "Refusing to send: action history contains a protected value."
            });
            return;
          }

          sendResponse({
            ok: true,
            payload: prepared.payload,
            snapshot: safe.agentContext,
            redaction: safe.redaction,
            ner: ner,
            timings: {
              domExtractionMs: domExtractionMs,
              ruleRedactionMs: ruleRedactionMs,
              nerMs: (ner && ner.inferenceTimeMs) || 0,
              totalLocalTextMs: Math.round(performance.now() - localStart)
            }
          });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error && error.message ? error.message : String(error)
          });
        }
      })();
      return true;
    }

    if (message.type === BrowserAgent.MSG.APPLY_ACTIONS) {
      try {
        if (!BrowserAgent.agentApply) {
          sendResponse({ ok: false, error: "Action applicator is not loaded." });
          return;
        }
        sendResponse(BrowserAgent.agentApply.applyActions(message.actions || [], sessionVault));
      } catch (error) {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error)
        });
      }
    }
  });
}
