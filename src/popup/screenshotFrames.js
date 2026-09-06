/**
 * Helpers for the last-task sanitized screenshot gallery.
 * Frames are in-memory only and must already be sanitizer-branded JPEGs.
 */
var BrowserAgent = globalThis.BrowserAgent || {};

BrowserAgent.screenshotFrames = (function () {
  var VIEWER_PATH = "src/popup/screenshotGallery.html";

  function brandedScreenshot(value) {
    return Boolean(
      value &&
        value.sanitized === true &&
        value.kind === "sanitized-screenshot-v1" &&
        typeof value.dataUrl === "string" &&
        /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value.dataUrl)
    );
  }

  function isFrame(frame) {
    return Boolean(frame && brandedScreenshot(frame.screenshot));
  }

  function listFrom(response) {
    var frames = [];
    if (response && Array.isArray(response.sanitizedScreenshots)) {
      response.sanitizedScreenshots.forEach(function (frame) {
        if (isFrame(frame)) {
          frames.push(frame);
        }
      });
    }
    if (
      !frames.length &&
      response &&
      brandedScreenshot(response.sanitizedScreenshot)
    ) {
      frames.push({
        step: 1,
        title: "Sanitized screenshot",
        url: "",
        transmitted: false,
        screenshot: response.sanitizedScreenshot
      });
    }
    frames.sort(compareFrames);
    return frames;
  }

  function frameKey(frame) {
    if (frame && frame.screen != null) {
      return "screen:" + String(frame.screen);
    }
    return String(frame && frame.step != null ? frame.step : "") + ":" + String((frame && frame.phase) || "observe");
  }

  function compareFrames(a, b) {
    var stepDiff = Number(a.step || 0) - Number(b.step || 0);
    if (stepDiff) {
      return stepDiff;
    }
    var order = { observe: 0, after: 1, final: 2 };
    return (order[a.phase] || 0) - (order[b.phase] || 0) || Number(a.capturedAt || 0) - Number(b.capturedAt || 0);
  }

  function upsert(list, frame) {
    var next = Array.isArray(list) ? list.slice() : [];
    if (!isFrame(frame)) {
      return next;
    }
    var key = frameKey(frame);
    var index = -1;
    for (var i = 0; i < next.length; i++) {
      if (frameKey(next[i]) === key) {
        index = i;
        break;
      }
    }
    if (index >= 0) {
      next[index] = frame;
    } else {
      next.push(frame);
    }
    next.sort(compareFrames);
    return next;
  }

  function label(frame) {
    var step = frame && frame.step != null ? String(frame.step) : "?";
    var title = frame && frame.title ? String(frame.title) : "";
    var prefix = title ? "Step " + step + " · " + title : "Step " + step;
    if (frame && frame.phase && frame.phase !== "observe") {
      return prefix + " · after navigation";
    }
    return prefix;
  }

  function note(frame, analysisMode, count) {
    var parts = [];
    if (count > 1) {
      parts.push(count + " screens in this task.");
    }
    if (analysisMode === "dom") {
      parts.push("No screenshot was captured or transmitted in DOM-only mode.");
      return parts.join(" ");
    }
    if (analysisMode === "sanitized-image") {
      parts.push(
        frame && frame.transmitted
          ? "This sanitized image was eligible for transmission."
          : "This sanitized preview stayed local."
      );
    } else {
      parts.push("This sanitized preview stayed local; only structured context was sent.");
    }
    return parts.join(" ");
  }

  function emptyNote(analysisMode) {
    return analysisMode === "dom"
      ? "No screenshot was captured or transmitted in DOM-only mode."
      : "No screenshot was captured or transmitted in this mode.";
  }

  function openViewer() {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.getURL) {
      return;
    }
    var url = chrome.runtime.getURL(VIEWER_PATH);
    function createWindow() {
      if (chrome.windows && chrome.windows.create) {
        chrome.windows.create({
          url: url,
          type: "popup",
          focused: true,
          width: 1100,
          height: 800
        });
        return;
      }
      chrome.tabs.create({ url: url });
    }
    chrome.tabs.query({ url: url }, function (tabs) {
      if (chrome.runtime.lastError || !tabs || !tabs[0]) {
        createWindow();
        return;
      }
      chrome.windows.update(tabs[0].windowId, { focused: true });
      chrome.tabs.update(tabs[0].id, { active: true });
    });
  }

  return {
    brandedScreenshot: brandedScreenshot,
    isFrame: isFrame,
    listFrom: listFrom,
    upsert: upsert,
    label: label,
    note: note,
    emptyNote: emptyNote,
    openViewer: openViewer,
    VIEWER_PATH: VIEWER_PATH
  };
})();

globalThis.BrowserAgent = BrowserAgent;
