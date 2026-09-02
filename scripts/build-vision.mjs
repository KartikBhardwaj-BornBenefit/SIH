/**
 * Copy WASM/runtime files and bundle the offscreen vision host.
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

await downloadLang();

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

console.log("Vision host bundled.");
console.log("ONNX runtime files:", fs.existsSync(onnxDest) ? fs.readdirSync(onnxDest).length : 0);
console.log("Tesseract files:", fs.existsSync(tessDest) ? fs.readdirSync(tessDest).length : 0);
