/**
 * Pure checks around the Phase 7 vision policy. Model inference itself needs
 * Chrome/WASM, but face annotation and OCR region scoping are deterministic.
 */
export function run(utils, t) {
  const policy = utils.defaultSensitivityPolicy();
  const snapshot = {
    viewport: {
      width: 100,
      height: 100,
      visualWidth: 100,
      visualHeight: 100,
      offsetLeft: 0,
      offsetTop: 0,
      scrollX: 0,
      scrollY: 0
    },
    elements: [
      { tag: "img", viewportBox: { x: 10, y: 10, width: 30, height: 30 } },
      { tag: "canvas", viewportBox: { x: 60, y: 60, width: 30, height: 30 } }
    ]
  };
  const vision = {
    image: { width: 200, height: 200 },
    detections: [
      { label: "face", confidence: 0.9 },
      { label: "person", confidence: 0.8 }
    ]
  };
  const ocr = {
    items: [
      { text: "ordinary image text", boundingBox: { x: 30, y: 30, width: 10, height: 10 } },
      { text: "ordinary page text", boundingBox: { x: 90, y: 20, width: 10, height: 10 } },
      { text: "canvas text", boundingBox: { x: 130, y: 130, width: 10, height: 10 } },
      {
        text: "person@example.com",
        boundingBox: { x: 90, y: 40, width: 20, height: 10 }
      }
    ]
  };

  const result = utils.sensitivity.annotatePixelSensitivity(vision, ocr, snapshot, policy);
  t.eq(
    "face detector labels are privacy-sensitive",
    result.detections.map((item) => item.sensitivityCategories),
    [["faces_people"], ["faces_people"]]
  );
  t.eq(
    "generic OCR is scoped to image and canvas pixels",
    result.ocrItems.map((item) => item.sensitivityCategories),
    [
      ["image_embedded_text"],
      [],
      ["image_embedded_text", "canvas_text"],
      ["email"]
    ]
  );

  const disabled = utils.sensitivity.annotatePixelSensitivity(
    vision,
    null,
    snapshot,
    { ...policy, faces_people: false }
  );
  t.eq(
    "face policy disables face annotation",
    disabled.detections.map((item) => item.sensitivity),
    ["unknown", "unknown"]
  );

  t.eq(
    "OCR runs automatically for pixel surfaces",
    utils.hybrid.planOcr(snapshot, false),
    {
      run: true,
      mode: "automatic",
      surfaces: ["image", "canvas"],
      reason: "OCR ran because the viewport contains image/canvas pixels."
    }
  );
  t.eq(
    "OCR is skipped for DOM-only screens",
    utils.hybrid.planOcr({ elements: [{ tag: "button", kind: "button" }] }, false).mode,
    "skipped"
  );
  t.eq(
    "OCR can be forced for unrepresented pixel surfaces",
    utils.hybrid.planOcr({ elements: [] }, true).mode,
    "forced"
  );
  t.eq(
    "OCR falls back on when DOM inspection fails",
    utils.hybrid.planOcr(null, false).mode,
    "automatic"
  );
}
