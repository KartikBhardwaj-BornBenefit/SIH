/**
 * Facade over a NerAdapter. The rest of the extension talks only to this.
 *
 * Usage:
 *   const engine = new NerEngine(new BertBaseNerAdapter());
 *   await engine.init();
 *   const result = await engine.analyze([{ key: "el:4:text", text: "..." }]);
 */
export class NerEngine {
  constructor(adapter) {
    this.adapter = adapter;
    this.status = "idle";
    this.error = null;
    this.loadInfo = null;
  }

  getStatus() {
    return {
      status: this.status,
      error: this.error,
      backend: this.adapter && this.adapter.backend,
      model: this.adapter && this.adapter.displayName,
      modelId: this.adapter && this.adapter.modelId,
      adapterId: this.adapter && this.adapter.id,
      loadTimeMs: this.adapter && this.adapter.loadTimeMs,
      note: "English DistilBERT, WASM q8. It cannot read Devanagari names."
    };
  }

  async init(preferredDevice) {
    if (this.status === "ready" && this.adapter && this.adapter.tagger) {
      return this.getStatus();
    }
    this.status = "loading";
    this.error = null;
    try {
      this.loadInfo = await this.adapter.load(preferredDevice);
      this.status = "ready";
      return this.getStatus();
    } catch (error) {
      this.status = "error";
      this.error = error && error.message ? error.message : String(error);
      throw error;
    }
  }

  async analyze(texts) {
    if (this.status !== "ready") {
      throw new Error("NER engine is not ready. Status: " + this.status);
    }
    var started = performance.now();
    var result = await this.adapter.analyze(texts);
    return {
      results: result.results || [],
      inferenceTimeMs: result.inferenceTimeMs,
      totalProcessingTimeMs: Math.round(performance.now() - started),
      modelLoadTimeMs: this.adapter.loadTimeMs,
      model: result.model,
      modelId: result.modelId,
      backend: result.backend,
      adapterId: result.adapterId,
      textsScanned: (texts || []).length,
      textLeftDevice: false
    };
  }
}
