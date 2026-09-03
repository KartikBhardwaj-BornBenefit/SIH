/**
 * Adapter contract for a local named-entity recogniser.
 *
 * Deliberately the same shape as vision's ModelAdapter, because the reason
 * for the indirection is the same and here it is not hypothetical: the first
 * checkpoint we ship is English-only, and the plan is to replace it. Anything
 * that reaches around this contract makes that swap more expensive.
 *
 * Expected analyze() result — one entry per input, in input order:
 * {
 *   results: [{ key, entities: [{ label, category, score, start, length, text }] }],
 *   inferenceTimeMs,
 *   model,
 *   modelId,
 *   backend
 * }
 *
 * `start` and `length` index into the string that was passed in.
 */
export class NerAdapter {
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

  async analyze(_texts) {
    throw new Error(this.displayName + " is not implemented yet.");
  }
}
