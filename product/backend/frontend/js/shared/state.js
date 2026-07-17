//  STATE
// ─────────────────────────────────────────────
const state = {
  data:        null,   // populated after JSON upload
  showGrid:    false,
  showRefImg:  false,
  refImg:      false,   // HTMLImageElement loaded by user
  showLabels:  false,
  showMeasure: true,
  selected:    null,
  collapsed:   {},
  drag:        null,
  panDrag:        null,   // middle-mouse pan
  detectionsOnly:  false,  // true when server returned detections but no walls
  pan:         { x: 0, y: 0 },
  scale:       1,
};

function syncStorage() {
  if (state.data && !state.detectionsOnly) {
    localStorage.setItem('floorplan', JSON.stringify(state.data));
  }
}

// ─────────────────────────────────────────────