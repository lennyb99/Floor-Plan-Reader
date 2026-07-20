const assert = require('node:assert/strict');
const {
  clampManualCropGeometry,
  manualCropCanvasBounds,
} = require('../product/backend/frontend/js/analyze/crop-geometry.js');

const bounds = manualCropCanvasBounds(1000, 1500);
assert.deepEqual(bounds, { left: -437.5, top: -187.5, size: 1875 });

const fullImage = clampManualCropGeometry({ left: -250, top: 0, size: 1500 }, 1000, 1500);
assert.deepEqual(fullImage, { left: -250, top: 0, size: 1500 });

const zoomedOut = clampManualCropGeometry({ left: -437.5, top: -187.5, size: 1875 }, 1000, 1500);
assert.deepEqual(zoomedOut, { left: -437.5, top: -187.5, size: 1875 });

const clamped = clampManualCropGeometry({ left: -900, top: 900, size: 3000 }, 1000, 1500);
assert.deepEqual(clamped, { left: -437.5, top: -187.5, size: 1875 });

console.log('Crop geometry tests passed.');
