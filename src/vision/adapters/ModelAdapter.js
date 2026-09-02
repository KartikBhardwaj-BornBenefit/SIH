/**
 * Adapter contract for a local object detector.
 *
 * Swap implementations without changing VisionEngine or the rest of the
 * extension. YOLOS-Tiny is the first baseline, not the final model.
 *
 * Expected analyze() result:
 * {
 *   detections: [{ label, confidence, boundingBox: { x, y, width, height } }],
 *   inferenceTimeMs,
 *   model,
 *   modelId,
 *   backend
 * }
 */
export class ModelAdapter {
  constructor() {
    this.id = "base";
    this.displayName = "Unimplemented adapter";
    this.modelId = "";
    this.backend = null;
    this.loadTimeMs = null;
  }

  async load(_preferredDevice) {
    throw new Error(this.displayName + " is not implemented yet.");
  }

  async analyze(_image) {
    throw new Error(this.displayName + " is not implemented yet.");
  }
}
