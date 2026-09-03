/**
 * Copy WASM/runtime files and bundle the offscreen inference host.
 *
 * The entry point is offscreen.js, so vision, OCR, and NER are all pulled in
 * transitively — adding a model layer needs no change here as long as the
 * offscreen host imports it.
 */
import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(from, to) {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
}

function copyMatching(srcDir, destDir, test) {
  if (!fs.existsSync(srcDir)) {
    console.warn("skip missing", srcDir);
    return [];
  }
  ensureDir(destDir);
  const copied = [];
  for (const name of fs.readdirSync(srcDir)) {
    if (test(name)) {
      copyFile(path.join(srcDir, name), path.join(destDir, name));
      copied.push(name);
    }
  }
  return copied;
}

const onnxDir = path.join(root, "node_modules", "onnxruntime-web", "dist");
const onnxDest = path.join(root, "vendor", "onnx");
const onnxCopied = copyMatching(onnxDir, onnxDest, (name) =>
  /\.(wasm|mjs|js)$/.test(name) && /ort-wasm|ort\.webgpu|ort-webgpu|jsep/.test(name)
);
if (!onnxCopied.length) {
  copyMatching(onnxDir, onnxDest, (name) => /\.(wasm|mjs)$/.test(name));
}

async function downloadFaceModel() {
  const visionDest = path.join(root, "vendor", "vision");
  const dest = path.join(visionDest, "face_detection_yunet_2023mar.onnx");
  if (fs.existsSync(dest)) {
    return;
  }
  ensureDir(visionDest);
  const url =
    "https://github.com/opencv/opencv_zoo/raw/main/models/" +
    "face_detection_yunet/face_detection_yunet_2023mar.onnx";
  console.log("Downloading OpenCV YuNet face model…");
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Could not download YuNet model: HTTP " + res.status);
  }
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

const tessJs = path.join(root, "node_modules", "tesseract.js", "dist");
const tessCore = path.join(root, "node_modules", "tesseract.js-core");
const tessDest = path.join(root, "vendor", "tesseract");
copyMatching(tessJs, tessDest, (name) => name.startsWith("worker"));
copyMatching(tessCore, tessDest, (name) => /tesseract-core/.test(name));

const langDest = path.join(tessDest, "lang");
ensureDir(langDest);

async function downloadLang() {
  const dest = path.join(langDest, "eng.traineddata.gz");
  if (fs.existsSync(path.join(langDest, "eng.traineddata")) || fs.existsSync(dest)) {
    return;
  }
  const url = "https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz";
  console.log("Downloading Tesseract English traineddata…");
  const res = await fetch(url);
  if (!res.ok) {
    console.warn("Could not download OCR language data:", res.status);
    return;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

if (process.env.SKIP_MODEL_DOWNLOADS === "1") {
  console.log("Skipping optional model downloads for CI.");
} else {
  await downloadFaceModel();
  await downloadLang();
}

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ["src/offscreen/offscreen.js"],
  bundle: true,
  format: "esm",
  outfile: "src/offscreen/offscreen.bundle.js",
  platform: "browser",
  target: ["chrome114"],
  minify: true,
  legalComments: "none",
  logLevel: "info"
});

console.log("Offscreen host bundled (vision + OCR + NER).");
console.log("ONNX runtime files:", fs.existsSync(onnxDest) ? fs.readdirSync(onnxDest).length : 0);
console.log("Vision model:", fs.existsSync(path.join(root, "vendor", "vision")) ? "YuNet" : "missing");
console.log("Tesseract files:", fs.existsSync(tessDest) ? fs.readdirSync(tessDest).length : 0);
