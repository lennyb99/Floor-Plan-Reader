// DOM-free crop geometry shared by the Image Prep UI and Node tests.
(function exposeCropGeometry(globalScope) {
  function manualCropCanvasBounds(width, height, maxSpan = 1.25) {
    const sourceWidth = Number(width);
    const sourceHeight = Number(height);
    if (!(sourceWidth > 0) || !(sourceHeight > 0)) return null;
    const size = Math.max(sourceWidth, sourceHeight) * maxSpan;
    return {
      left: (sourceWidth - size) / 2,
      top: (sourceHeight - size) / 2,
      size,
    };
  }

  function clampManualCropGeometry(crop, width, height, maxSpan = 1.25) {
    const bounds = manualCropCanvasBounds(width, height, maxSpan);
    if (!bounds) return crop;
    const requestedSize = Number(crop?.size);
    const size = Math.max(32, Math.min(
      bounds.size,
      Number.isFinite(requestedSize) ? requestedSize : bounds.size,
    ));
    const requestedLeft = Number(crop?.left);
    const requestedTop = Number(crop?.top);
    const left = Number.isFinite(requestedLeft) ? requestedLeft : 0;
    const top = Number.isFinite(requestedTop) ? requestedTop : 0;
    return {
      size,
      left: Math.max(bounds.left, Math.min(bounds.left + bounds.size - size, left)),
      top: Math.max(bounds.top, Math.min(bounds.top + bounds.size - size, top)),
    };
  }

  const api = { manualCropCanvasBounds, clampManualCropGeometry };
  Object.assign(globalScope, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
