/** Local privacy gateway configuration. API keys belong on the server only. */
var BrowserAgentLlm = {
  endpoint: "http://127.0.0.1:4317/agent",
  timeoutMs: 60000,
  imageEnabled: true
};

globalThis.BrowserAgentLlm = BrowserAgentLlm;
