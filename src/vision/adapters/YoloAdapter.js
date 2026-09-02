/**
 * Placeholder for a future YOLOv10 (or similar) adapter.
 * Kept so the extension can swap detectors without a rewrite.
 */
import { ModelAdapter } from "./ModelAdapter.js";

export class YoloAdapter extends ModelAdapter {
  constructor() {
    super();
    this.id = "yolov10";
    this.displayName = "YOLOv10 (not wired yet)";
    this.modelId = "";
  }
}
