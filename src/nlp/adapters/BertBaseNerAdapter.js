/**
 * DistilBERT NER via Transformers.js (WASM, q8).
 *
 * The first checkpoint was Xenova/bert-base-NER. That was the wrong size for
 * an extension popup: q8 is 108 MB, the fp32 sibling is 431 MB, and trying
 * WebGPU first can pull the large file, fail, then download q8 as well.
 * Meanwhile each snapshot field was a separate WASM forward pass, so a page
 * with a few dozen strings looked like a hung download after the weights had
 * already arrived.
 *
 * onnx-community/distilbert-NER-ONNX q8 is 66 MB, WASM-only so we never touch
 * the 261 MB fp32 file, and packed inference turns many short strings into
 * one pass. Same CoNLL-03 PER labels, still English-only.
 */
import { pipeline, env } from "@huggingface/transformers";
import { NerAdapter } from "./NerAdapter.js";
import { groupEntities, MIN_SCORE } from "../entities.js";
import { chunkText, mergeEntities, packTexts, unpackEntities } from "../chunk.js";

function configureRuntime() {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.numThreads = 1;
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
    env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/onnx/");
  }
}

export class BertBaseNerAdapter extends NerAdapter {
  constructor() {
    super();
    this.id = "distilbert-ner";
    this.displayName = "DistilBERT NER (English)";
    this.modelId = "onnx-community/distilbert-NER-ONNX";
    this.tagger = null;
    this.onProgress = null;
  }

  async load(preferredDevice) {
    configureRuntime();
    var start = performance.now();
    var self = this;

    // WASM only. WebGPU on this checkpoint tries the 261 MB fp32/fp16 files
    // and can sit compiling shaders for minutes. preferredDevice is ignored
    // on purpose so a caller cannot reintroduce that path.
    void preferredDevice;

    this.tagger = await pipeline("token-classification", this.modelId, {
      device: "wasm",
      dtype: "q8",
      progress_callback: function (info) {
        if (typeof self.onProgress === "function") {
          self.onProgress(info);
        }
      }
    });
    this.backend = "wasm";
    this.loadTimeMs = Math.round(performance.now() - start);
    return {
      backend: this.backend,
      loadTimeMs: this.loadTimeMs,
      model: this.displayName,
      modelId: this.modelId
    };
  }

  /** Entities in one string, with offsets indexing into that string. */
  async analyzeText(text) {
    var chunks = chunkText(text);
    var found = [];

    for (var i = 0; i < chunks.length; i++) {
      var chunk = chunks[i];
      var tokens = await this.tagger(chunk.text, {
        ignore_labels: ["O"]
      });
      var grouped = groupEntities(Array.isArray(tokens) ? tokens : [], chunk.text, {
        minScore: MIN_SCORE
      });
      for (var g = 0; g < grouped.length; g++) {
        var entity = grouped[g];
        found.push({
          label: entity.label,
          category: entity.category,
          score: entity.score,
          start: entity.start + chunk.offset,
          length: entity.length,
          text: entity.text
        });
      }
    }

    return mergeEntities(found);
  }

  /**
   * @param {Array<{key: string, text: string}>} texts
   */
  async analyze(texts) {
    if (!this.tagger) {
      throw new Error("NER adapter is not loaded.");
    }
    var started = performance.now();
    var packs = packTexts(texts || []);
    var results = [];

    for (var i = 0; i < packs.length; i++) {
      var pack = packs[i];
      var entities = await this.analyzeText(pack.text);
      var mapped = unpackEntities(entities, pack.members);
      for (var m = 0; m < mapped.length; m++) {
        results.push(mapped[m]);
      }
    }

    return {
      results: results,
      inferenceTimeMs: Math.round(performance.now() - started),
      model: this.displayName,
      modelId: this.modelId,
      backend: this.backend,
      adapterId: this.id,
      packsRun: packs.length
    };
  }
}
