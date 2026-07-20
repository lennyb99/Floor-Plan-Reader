

document.body.classList.toggle('debug-mode', new URLSearchParams(location.search).get('debug') === '1');

let toastTimer;
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2400);
}

function refreshDerivedGeometry({ normalize = false } = {}) {
  if (!state.data) return { changed: false, snapped: 0, createdSegments: 0 };
  const result = normalize
    ? normalizeFloorplanTopology(state.data)
    : { changed: false, snapped: 0, crossSections: 0, createdSegments: 0 };
  state.rooms = calculateRooms(state.data);
  state.data.rooms = state.rooms.map(room => ({
    id: room.id,
    center: {
      x: Number(room.center.x.toFixed(2)),
      y: Number(room.center.y.toFixed(2)),
    },
    area_px2: room.area_px2,
    area_m2: room.area_m2 == null ? null : Number(room.area_m2.toFixed(3)),
  }));
  return result;
}

function commitFloorplanChange({ normalize = true, announceTopology = false } = {}) {
  if (!state.data) return;
  const topology = refreshDerivedGeometry({ normalize });
  if (state.selected?.wallId && !state.data.walls.some(wall => wall.id === state.selected.wallId)) {
    const replacement = state.data.walls.find(wall => wall.source_wall_id === state.selected.wallId);
    state.selected = replacement ? { kind: 'wall', wallId: replacement.id } : null;
  }
  syncStorage();
  pushHistory();
  updateSidebar();
  updateInspector(true);
  render();
  if (announceTopology && topology.changed) {
    showToast(`${topology.snapped} junctions snapped · ${topology.createdSegments} cross-section splits`);
  }
}

// ─────────────────────────────────────────────
//  TOOLBAR TOGGLES
// ─────────────────────────────────────────────
function bindToggle(id, key, cb) {
  const btn = document.getElementById(id);
  btn.addEventListener('click', () => {
    state[key] = !state[key];
    btn.classList.toggle('active', state[key]);
    btn.setAttribute('aria-pressed', String(state[key]));
    if (cb) cb();
    render();
  });
}

bindToggle('tb-grid',    'showGrid');
bindToggle('tb-wall-opacity', 'transparentWalls');

// Reference image toggle: first click opens file picker (if no image loaded yet),
// subsequent clicks just show/hide the loaded image
document.getElementById('tb-refimg').addEventListener('click', () => {
  if (!state.refImg) {
    // No image from analyze yet — let user pick one manually
    document.getElementById('refimg-input').click();
  } else {
    state.showRefImg = !state.showRefImg;
    document.getElementById('tb-refimg').classList.toggle('active', state.showRefImg);
    render();
  }
});

document.getElementById('refimg-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    state.refImg      = img;
    state.showRefImg  = true;
    document.getElementById('tb-refimg').classList.add('active');
    render();
  };
  img.src = url;
  e.target.value = '';
});
bindToggle('tb-labels',  'showLabels');
bindToggle('tb-measure', 'showMeasure');

// ─────────────────────────────────────────────
//  DOWNLOAD
// ─────────────────────────────────────────────
document.getElementById('btn-download').addEventListener('click', () => {
  if (!state.data) { showToast('Load a floor plan before exporting.'); return; }
  const blob = new Blob([JSON.stringify(state.data, null, 4)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'floorplan_edited.json';
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Edited JSON downloaded.');
});

// ─────────────────────────────────────────────
//  LOAD JSON
// ─────────────────────────────────────────────
function loadJSON(json) {
  // Detections-only format (YOLO without wall segmentation): { detections: [...] }
  // Full format: { walls: [...] }
  if (!json.walls && json.detections) {
    state.data          = null;
    state.detectionsOnly = true;
    render();
    buildHierarchy();
    return;
  }
  state.detectionsOnly = false;
  ensureFloorplanCollections(json);
  state.data      = json;
  const topology = refreshDerivedGeometry({ normalize: true });
  state.selected  = null;
  state.collapsed = {};
  appHistory.stack   = [];
  appHistory.cursor  = -1;
  pushHistory();
  autoFit();
  updateSidebar();
  updateInspector(true);
  if (topology.changed) {
    showToast(`${topology.createdSegments} wall splits and ${topology.snapped} snapped junctions applied.`);
  }
}

document.getElementById('btn-upload').addEventListener('click', () => {
  document.getElementById('file-input').click();
});

document.getElementById('file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try { 
      loadJSON(JSON.parse(ev.target.result)); 
      syncStorage();
    }
    catch { showToast('This is not a valid floor plan JSON file.'); }
  };
  reader.readAsText(file);
  e.target.value = ''; // reset so same file can be re-uploaded
});

// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
//  DELETE SELECTED
// ─────────────────────────────────────────────
function deleteSelected() {
  const s = state.selected;
  if (!s || !state.data) return;
  const wall = s.kind !== 'furniture'
    ? state.data.walls.find(w => w.id === s.wallId)
    : null;
  if (s.kind !== 'furniture' && !wall) return;
  if (s.kind === 'furniture') {
    state.data.furniture.splice(s.idx, 1);
  } else if (s.kind === 'wall') {
    state.data.walls = state.data.walls.filter(w => w.id !== s.wallId);
  } else if (s.kind === 'window') {
    wall.windows.splice(s.idx, 1);
  } else if (s.kind === 'door') {
    wall.doors.splice(s.idx, 1);
  }

  state.selected = null;
  commitFloorplanChange({ normalize: false });
}

document.addEventListener('keydown', e => {
  const commandKey = e.ctrlKey || e.metaKey;
  if (commandKey && e.key.toLowerCase() === 'z' && e.shiftKey) { e.preventDefault(); redo(); return; }
  if (commandKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (commandKey && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (document.activeElement.tagName === 'INPUT') return;
  if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
});

// ─────────────────────────────────────────────
//  ZOOM  (mouse-wheel, zoom toward cursor)
// ─────────────────────────────────────────────
const ZOOM_FACTOR = 1.12;
const ZOOM_MIN    = 0.2;
const ZOOM_MAX    = 8;

function zoomCanvas(factor) {
  if (!state.data) return;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.scale * factor));
  state.pan.x = cx - (cx - state.pan.x) * (newScale / state.scale);
  state.pan.y = cy - (cy - state.pan.y) * (newScale / state.scale);
  state.scale = newScale;
  render();
}

document.getElementById('tb-zoom-out').addEventListener('click', () => zoomCanvas(1 / ZOOM_FACTOR));
document.getElementById('tb-zoom-in').addEventListener('click', () => zoomCanvas(ZOOM_FACTOR));
document.getElementById('tb-fit').addEventListener('click', autoFit);
document.getElementById('btn-close-inspector').addEventListener('click', () => select(null));

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (!state.data) return;
  const rect    = canvas.getBoundingClientRect();
  const mx      = e.clientX - rect.left;   // cursor in screen space
  const my      = e.clientY - rect.top;
  const factor  = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
  const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.scale * factor));
  // Shift pan so the point under the cursor stays fixed
  state.pan.x = mx - (mx - state.pan.x) * (newScale / state.scale);
  state.pan.y = my - (my - state.pan.y) * (newScale / state.scale);
  state.scale = newScale;
  render();
}, { passive: false });

canvas.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });

// ─────────────────────────────────────────────
//  DEBUG PANEL
// ─────────────────────────────────────────────
function refreshDebugPanel() {
  const raw  = localStorage.getItem('floorplan');
  const body = document.getElementById('debug-body');
  if (!raw) { body.textContent = 'Nothing in localStorage (key: "floorplan").'; return; }

  try {
    const parsed = JSON.parse(raw);
    const walls  = parsed.walls;
    if (!walls) {
      body.textContent = 'Parsed OK but no "walls" key found.\n\nTop-level keys:\n'
        + Object.keys(parsed).join(', ')
        + '\n\nRaw (first 800 chars):\n'
        + raw.slice(0, 800);
      return;
    }
    const wins  = walls.reduce((a, w) => a + (w.windows||[]).length, 0);
    const doors = walls.reduce((a, w) => a + (w.doors||[]).length,   0);
    const sample = walls.slice(0, 3);
    body.textContent =
      `✓ walls: ${walls.length}  windows: ${wins}  doors: ${doors}\n\n`
      + `First ${sample.length} walls:\n`
      + JSON.stringify(sample, null, 2).slice(0, 1200);
  } catch(e) {
    body.textContent = 'JSON parse error: ' + e.message + '\n\nRaw (first 400 chars):\n' + raw.slice(0, 400);
  }
}

document.getElementById('btn-debug').addEventListener('click', () => {
  const panel = document.getElementById('debug-panel');
  panel.classList.toggle('visible');
  if (panel.classList.contains('visible')) refreshDebugPanel();
});
document.getElementById('btn-debug-close').addEventListener('click', () => {
  document.getElementById('debug-panel').classList.remove('visible');
});
document.getElementById('btn-debug-copy').addEventListener('click', () => {
  const raw = localStorage.getItem('floorplan') || '';
  navigator.clipboard.writeText(raw).catch(() => {});
});

// ─────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────
new ResizeObserver(() => {
  const r = viewport.getBoundingClientRect();
  canvas.width  = r.width;
  canvas.height = r.height;
  if (state.data) autoFit(); else render();
}).observe(viewport);

// Initial size
const vr = viewport.getBoundingClientRect();
canvas.width  = vr.width;
canvas.height = vr.height;

// Start loading 2D furniture SVGs (renders again when done)
loadFurnitureAssets2D();

// Auto-load floorplan passed from analyze.html
const _saved  = localStorage.getItem('floorplan');
const _source = localStorage.getItem('floorplan_source');
const _overlay = document.getElementById('page-transition');
const _ptLabel = document.getElementById('pt-label');

function fadeOutOverlay() {
  // Small delay so the first render frame is painted before we reveal the editor
  requestAnimationFrame(() => requestAnimationFrame(() => {
    _overlay.classList.add('hidden');
    // Remove from flow after transition completes so it can't block clicks
    setTimeout(() => { _overlay.style.display = 'none'; }, 500);
  }));
}

if (_saved) {
  try {
    const parsed = JSON.parse(_saved);
    if (_source) document.getElementById('nav-source').textContent = _source;
    loadJSON(parsed);
    const wallCount = parsed.walls?.length || 0;
    document.getElementById('workspace-status-text').textContent = `${wallCount} walls · 512 px workspace`;
    _ptLabel.textContent = 'Ready.';
  } catch(e) {
    _ptLabel.textContent = 'Load error — try uploading JSON manually.';
    render();
  }
} else {
  _ptLabel.textContent = 'No data — upload a JSON file.';
  render();
}

// Auto-load reference image stored by analyze.html
const _savedImg = localStorage.getItem('floorplan_image');
if (_savedImg) {
  const img = new Image();
  img.onload = () => {
    state.refImg     = img;
    state.showRefImg = true;
    document.getElementById('tb-refimg').classList.add('active');
    render();
  };
  img.src = _savedImg;
}

window.addEventListener('storage', e => {
  if (e.key !== 'floorplan' || !e.newValue) return;
  try {
    loadJSON(JSON.parse(e.newValue));
  } catch(err) { console.warn('2D sync error', err); }
});

fadeOutOverlay();
