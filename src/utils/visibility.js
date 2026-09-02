/**
 * Three separate questions, kept distinct on purpose:
 *
 * 1. DOM existence — the node is in the document.
 * 2. Visibility    — the node is actually rendered on the page
 *                    (not display:none, not 0×0, not in a closed <details>, …).
 *    Below-the-fold content can still be visible in this sense.
 * 3. Viewport      — the rendered box currently intersects the browser viewport.
 *
 * This is CSS/layout visibility, not screenshot visibility. We cannot reliably
 * tell occlusion, contrast, or whether something is covered by a modal.
 */
var BrowserAgent = globalThis.BrowserAgent || {};

var MIN_BOX_PX = 1;

function getBoundingBox(element) {
  var rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.left + window.scrollX),
    y: Math.round(rect.top + window.scrollY),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function getViewportBox(element) {
  var rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function hasRenderableBox(element) {
  var rect = element.getBoundingClientRect();
  return rect.width >= MIN_BOX_PX && rect.height >= MIN_BOX_PX;
}

function isHiddenInput(element) {
  if (element.tagName.toLowerCase() !== "input") {
    return false;
  }
  var type = (element.getAttribute("type") || element.type || "").toLowerCase();
  return type === "hidden";
}

function isClosedDetailsContent(element) {
  var closed = element.closest("details:not([open])");
  if (!closed) {
    return false;
  }
  return !element.closest("summary");
}

function isInViewport(element) {
  var rect = element.getBoundingClientRect();
  if (rect.width < MIN_BOX_PX || rect.height < MIN_BOX_PX) {
    return false;
  }
  var vw = window.innerWidth || document.documentElement.clientWidth;
  var vh = window.innerHeight || document.documentElement.clientHeight;
  return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
}

function ancestorHidesElement(element) {
  var node = element;
  while (node && node.nodeType === 1) {
    if (node.hasAttribute("hidden")) {
      return true;
    }
    var style = window.getComputedStyle(node);
    if (!style) {
      return true;
    }
    if (style.display === "none") {
      return true;
    }
    if (style.visibility === "hidden" || style.visibility === "collapse") {
      return true;
    }
    if (parseFloat(style.opacity) === 0) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

function isClippedByAncestor(element) {
  var rect = element.getBoundingClientRect();
  var parent = element.parentElement;
  while (parent && parent !== document.documentElement) {
    var style = window.getComputedStyle(parent);
    var overflowX = style.overflowX;
    var overflowY = style.overflowY;
    var clips =
      overflowX === "hidden" ||
      overflowX === "clip" ||
      overflowY === "hidden" ||
      overflowY === "clip";
    if (clips) {
      var parentRect = parent.getBoundingClientRect();
      if (parentRect.width < MIN_BOX_PX || parentRect.height < MIN_BOX_PX) {
        return true;
      }
      var intersects =
        rect.right > parentRect.left &&
        rect.left < parentRect.right &&
        rect.bottom > parentRect.top &&
        rect.top < parentRect.bottom;
      if (!intersects) {
        return true;
      }
    }
    parent = parent.parentElement;
  }
  return false;
}

function isOutsideScrollablePage(element) {
  var rect = element.getBoundingClientRect();
  var doc = document.documentElement;
  var pageWidth = Math.max(doc.scrollWidth, window.innerWidth);
  var pageHeight = Math.max(doc.scrollHeight, window.innerHeight);
  var left = rect.left + window.scrollX;
  var top = rect.top + window.scrollY;
  var right = rect.right + window.scrollX;
  var bottom = rect.bottom + window.scrollY;
  return right < 0 || bottom < 0 || left > pageWidth || top > pageHeight;
}

function isRenderedVisible(element) {
  if (!(element instanceof Element)) {
    return false;
  }
  if (!element.isConnected) {
    return false;
  }
  if (isHiddenInput(element)) {
    return false;
  }
  if (isClosedDetailsContent(element)) {
    return false;
  }

  if (typeof element.checkVisibility === "function") {
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return false;
    }
  } else if (ancestorHidesElement(element)) {
    return false;
  }

  if (!hasRenderableBox(element)) {
    return false;
  }
  if (isClippedByAncestor(element)) {
    return false;
  }
  if (isOutsideScrollablePage(element)) {
    return false;
  }
  return true;
}

function classifyVisibility(element) {
  var visible = isRenderedVisible(element);
  return {
    visible: visible,
    inViewport: visible && isInViewport(element)
  };
}

BrowserAgent.visibility = {
  MIN_BOX_PX: MIN_BOX_PX,
  getBoundingBox: getBoundingBox,
  getViewportBox: getViewportBox,
  isInViewport: isInViewport,
  isRenderedVisible: isRenderedVisible,
  isCssVisible: isRenderedVisible,
  classifyVisibility: classifyVisibility
};

globalThis.BrowserAgent = BrowserAgent;
