/**
 * Full-window viewer for every sanitized screenshot in the last agent task.
 * Reads in-memory frames from the service worker; nothing is written to disk.
 */
var titleEl = document.getElementById("gallery-title");
var goalEl = document.getElementById("gallery-goal");
var emptyEl = document.getElementById("gallery-empty");
var mainEl = document.getElementById("gallery-main");
var imageEl = document.getElementById("gallery-image");
var captionEl = document.getElementById("gallery-caption");
var stepEl = document.getElementById("gallery-step");
var urlEl = document.getElementById("gallery-url");
var flagsEl = document.getElementById("gallery-flags");
var stripEl = document.getElementById("gallery-strip");

var frames = [];
var selectedIndex = 0;
var analysisMode = null;
var captureErrors = [];

function helpers() {
  return (globalThis.BrowserAgent && globalThis.BrowserAgent.screenshotFrames) || null;
}

function renderSelected() {
  if (!frames.length) {
    emptyEl.hidden = false;
    mainEl.hidden = true;
    stripEl.hidden = true;
    stripEl.replaceChildren();
    titleEl.textContent = "Sanitized screenshots";
    return;
  }
  if (selectedIndex < 0 || selectedIndex >= frames.length) {
    selectedIndex = frames.length - 1;
  }
  var frame = frames[selectedIndex];
  var shot = frame.screenshot;
  var api = helpers();
  emptyEl.hidden = true;
  mainEl.hidden = false;
  stripEl.hidden = false;
  titleEl.textContent =
    frames.length === 1 ? "1 sanitized screenshot" : frames.length + " sanitized screenshots";
  imageEl.src = shot.dataUrl;
  captionEl.textContent = api ? api.label(frame) : "Step " + frame.step;
  stepEl.textContent =
    "Screen " +
    (selectedIndex + 1) +
    " of " +
    frames.length +
    " · " +
    shot.width +
    "×" +
    shot.height;
  urlEl.textContent = frame.url || "No redacted URL on this capture.";
  var flags = [];
  flags.push(frame.transmitted ? "Eligible for the agent server" : "Stayed on this device");
  if (shot.redaction && shot.redaction.blackRegions != null) {
    flags.push(shot.redaction.blackRegions + " black regions");
  }
  if (analysisMode) {
    flags.push(analysisMode.replace(/-/g, " ") + " mode");
  }
  if (captureErrors && captureErrors.length) {
    flags.push(captureErrors.length + " later capture(s) failed");
  }
  flagsEl.textContent = flags.join(" · ");

  stripEl.replaceChildren();
  frames.forEach(function (item, index) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "agent-shot-thumb" + (index === selectedIndex ? " is-selected" : "");
    var img = document.createElement("img");
    img.src = item.screenshot.dataUrl;
    img.alt = api ? api.label(item) : "Step " + item.step;
    var badge = document.createElement("span");
    badge.className = "agent-shot-step";
    badge.textContent = String(index + 1);
    button.appendChild(img);
    button.appendChild(badge);
    button.addEventListener("click", function () {
      selectedIndex = index;
      renderSelected();
    });
    stripEl.appendChild(button);
  });
}

function applyResponse(response) {
  var api = helpers();
  frames = api ? api.listFrom(response) : [];
  analysisMode = response && response.analysisMode ? response.analysisMode : analysisMode;
  captureErrors = (response && response.captureErrors) || [];
  if (response && response.goal) {
    goalEl.textContent = response.goal;
  }
  if (selectedIndex >= frames.length) {
    selectedIndex = Math.max(0, frames.length - 1);
  }
  renderSelected();
}

function loadFromWorker() {
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
    emptyEl.textContent = "Open this page from the extension popup.";
    return;
  }
  chrome.runtime.sendMessage({ type: "AGENT_STATUS", anyTab: true }, function (response) {
    if (chrome.runtime.lastError) {
      emptyEl.textContent = chrome.runtime.lastError.message;
      return;
    }
    applyResponse(response || {});
  });
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "AGENT_STATUS") {
      return;
    }
    if (message.screenshotFrame || message.screenshotCount) {
      loadFromWorker();
    }
  });
}

document.addEventListener("keydown", function (event) {
  if (!frames.length) {
    return;
  }
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    selectedIndex = Math.min(frames.length - 1, selectedIndex + 1);
    renderSelected();
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    selectedIndex = Math.max(0, selectedIndex - 1);
    renderSelected();
  } else if (event.key === "Home") {
    selectedIndex = 0;
    renderSelected();
  } else if (event.key === "End") {
    selectedIndex = frames.length - 1;
    renderSelected();
  }
});

loadFromWorker();
