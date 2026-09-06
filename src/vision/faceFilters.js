/**
 * YuNet is trained to find very small faces, so QR modules, emblems, and
 * printed text on ID cards often score in the 0.45–0.55 range. 0.57 keeps
 * weaker printed portraits while still dropping that clutter.
 */
export var FACE_SCORE_THRESHOLD = 0.57;

var MIN_SIDE = 16;
var MIN_ASPECT = 0.45;
var MAX_ASPECT = 1.35;
var MAX_IMAGE_FRACTION = 0.45;

export function isPlausibleFace(box, imageWidth, imageHeight) {
  if (!box) {
    return false;
  }
  var width = Number(box.width) || 0;
  var height = Number(box.height) || 0;
  if (width < MIN_SIDE || height < MIN_SIDE) {
    return false;
  }
  var aspect = width / height;
  if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) {
    return false;
  }
  var imageArea = (Number(imageWidth) || 0) * (Number(imageHeight) || 0);
  if (imageArea) {
    var fraction = (width * height) / imageArea;
    if (fraction > MAX_IMAGE_FRACTION) {
      return false;
    }
  }
  return true;
}

export function filterFaceDetections(detections, imageWidth, imageHeight) {
  return (detections || []).filter(function (det) {
    return (
      (det.confidence || 0) >= FACE_SCORE_THRESHOLD &&
      isPlausibleFace(det.boundingBox, imageWidth, imageHeight)
    );
  });
}
