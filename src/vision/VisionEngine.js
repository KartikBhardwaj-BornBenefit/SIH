/**
 * Facade over a ModelAdapter. The rest of the extension talks only to this.
 *
 * Usage:
 *   const engine = new VisionEngine(new YolosTinyAdapter());
 *   await engine.init();
 *   const result = await engine.analyze(imageDataUrl, { width, height });
 */
export class VisionEngine {
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
      note: "YOLOS-Tiny is a baseline detector, not the final privacy model."
    };
  }

  async init(preferredDevice) {
    if (this.status === "ready" && this.adapter && this.adapter.detector) {
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

  async analyze(image, meta) {
    if (this.status !== "ready") {
      throw new Error("Vision engine is not ready. Status: " + this.status);
    }
    var started = performance.now();
    var result = await this.adapter.analyze(image);
    var totalProcessingTimeMs = Math.round(performance.now() - started);
    return {
      detections: result.detections || [],
      inferenceTimeMs: result.inferenceTimeMs,
      totalProcessingTimeMs: totalProcessingTimeMs,
      modelLoadTimeMs: this.adapter.loadTimeMs,
      model: result.model,
      modelId: result.modelId,
      backend: result.backend,
      adapterId: result.adapterId,
      image: {
        width: meta && meta.width,
        height: meta && meta.height
      },
      capturedAt: new Date().toISOString(),
      screenshotLeftDevice: false
    };
  }
}
