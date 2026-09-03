/**
 * Deterministic hybrid gate: DOM first, vision only when the DOM cannot
 * say what is visually present. No LLM.
 *
 * This does not stop the baseline screenshot run; it records whether
 * vision was actually necessary for privacy-relevant understanding.
 */
var BrowserAgent = globalThis.BrowserAgent || {};

function has(elements, predicate) {
  for (var i = 0; i < elements.length; i++) {
    if (predicate(elements[i])) {
      return true;
    }
  }
  return false;
}

function visionHasLabel(visionResult, label) {
  var detections = (visionResult && visionResult.detections) || [];
  var needle = String(label).toLowerCase();
  for (var i = 0; i < detections.length; i++) {
    if (String(detections[i].label || "").toLowerCase() === needle) {
      return true;
    }
  }
  return false;
}

function ocrLooksLikeEmail(ocrResult) {
  var text = (ocrResult && ocrResult.text) || "";
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text);
}

function pixelSurfaces(domSnapshot) {
  var elements = (domSnapshot && domSnapshot.elements) || [];
  var found = [];

  elements.forEach(function (el) {
    var tag = String(el.tag || "").toLowerCase();
    var kind = String(el.kind || "").toLowerCase();
    if (
      (tag === "img" || kind === "image") &&
      found.indexOf("image") === -1
    ) {
      found.push("image");
    }
    if (
      (tag === "canvas" || kind === "canvas") &&
      found.indexOf("canvas") === -1
    ) {
      found.push("canvas");
    }
    if (
      (tag === "video" || kind === "video") &&
      found.indexOf("video") === -1
    ) {
      found.push("video");
    }
  });

  return found;
}

/**
 * OCR is expensive, so run it automatically only when the viewport snapshot
 * contains pixels the DOM cannot read. The override covers CSS backgrounds,
 * inaccessible frames, and other surfaces absent from the snapshot.
 */
function planOcr(domSnapshot, forceOcr) {
  var surfaces = pixelSurfaces(domSnapshot);
  var snapshotUnavailable = !domSnapshot;
  var run = Boolean(forceOcr || snapshotUnavailable || surfaces.length);
  var mode = forceOcr ? "forced" : (run ? "automatic" : "skipped");
  var reason;

  if (forceOcr) {
    reason = "OCR was explicitly requested for the full visible screen.";
  } else if (snapshotUnavailable) {
    reason = "OCR ran because DOM inspection was unavailable.";
  } else if (surfaces.length) {
    reason = "OCR ran because the viewport contains " + surfaces.join("/") + " pixels.";
  } else {
    reason = "OCR was skipped because the DOM found no image, canvas, or video pixels.";
  }

  return {
    run: run,
    mode: mode,
    surfaces: surfaces,
    reason: reason
  };
}

function decide(domSnapshot, visionResult, ocrResult) {
  var elements = (domSnapshot && domSnapshot.elements) || [];
  var reasons = [];

  var password = has(elements, function (el) {
    return el.inputType === "password";
  });
  var email = has(elements, function (el) {
    return el.inputType === "email" || (el.sensitivityCategories || []).indexOf("email") !== -1;
  });
  var button = has(elements, function (el) {
    return el.kind === "button" || el.kind === "link";
  });
  var image = has(elements, function (el) {
    return el.kind === "image" || el.tag === "img";
  });
  var canvas = has(elements, function (el) {
    return el.tag === "canvas" || el.kind === "canvas";
  });
  var video = has(elements, function (el) {
    return el.tag === "video" || el.kind === "video";
  });

  if (password) {
    reasons.push("DOM already identified a password field. Vision is not required for that control.");
  }
  if (email) {
    reasons.push("DOM already identified an email field. Vision is not required for the input itself.");
  }
  if (image) {
    reasons.push("DOM sees an image but not its pixels. Local vision may be required.");
  }
  if (canvas) {
    reasons.push("DOM sees a canvas but not painted pixels. Local vision/OCR may be required.");
  }
  if (video) {
    reasons.push("DOM sees a video element but not the current frame. Local vision may be required.");
  }

  var visionRecommended = image || canvas || video;
  var comparison = [
    {
      signal: "Password field",
      dom: password ? "YES" : "NO",
      vision: "NO",
      note: "DOM type=password is authoritative."
    },
    {
      signal: "Email field",
      dom: email ? "YES" : "NO",
      vision: ocrLooksLikeEmail(ocrResult) ? "MAYBE" : "NO",
      note: "The input is a DOM fact. OCR may still find an email painted in pixels."
    },
    {
      signal: "Person / face",
      dom: "NO",
      vision:
        visionHasLabel(visionResult, "face") || visionHasLabel(visionResult, "person")
          ? "YES"
          : "NO",
      note: "YuNet is purpose-built for small faces; YOLOS remains only as a benchmark adapter."
    },
    {
      signal: "Image / embedded pixels",
      dom: image ? "YES (tag only)" : "NO",
      vision: image ? "YES" : "NO",
      note: "DOM cannot see faces or text inside the image."
    },
    {
      signal: "Canvas text",
      dom: canvas ? "YES (tag only)" : "NO",
      vision: ocrResult && canvas ? "YES" : "NO",
      note: "Need OCR/vision to read pixels painted on a canvas."
    },
    {
      signal: "Normal button / link",
      dom: button ? "YES" : "NO",
      vision: "NO",
      note: "Interactive HTML is a DOM problem."
    }
  ];

  return {
    visionRecommended: visionRecommended,
    reasons: reasons,
    comparison: comparison,
    rule: "Use the cheapest reliable source first. DOM handles forms and controls; vision handles pixels the DOM cannot describe."
  };
}

BrowserAgent.hybrid = {
  decide: decide,
  pixelSurfaces: pixelSurfaces,
  planOcr: planOcr
};

globalThis.BrowserAgent = BrowserAgent;
