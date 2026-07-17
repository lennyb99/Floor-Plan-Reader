//  SELECTION
// ─────────────────────────────────────────────
function select(hit) {
  if (!hit) {
    state.selected = null;
  } else if (hit.kind === 'wall') {
    state.selected = { kind: 'wall', wallId: hit.wall.id };
  } else if (hit.kind === 'furniture') {
    state.selected = { kind: 'furniture', idx: hit.idx };
  } else {
    state.selected = { kind: hit.kind, wallId: hit.wall.id, idx: hit.idx };
  }
  updateSidebar();
  updateInspector();
  render();
}

function getSelectedObject() {
  const s = state.selected;
  if (!s) return null;
  if (s.kind === 'furniture') {
    const obj = (state.data.furniture || [])[s.idx];
    return obj ? { obj, kind: 'furniture' } : null;
  }
  const wall = state.data.walls.find(w => w.id === s.wallId);
  if (!wall) return null;
  if (s.kind === 'wall')   return { obj: wall,              kind: 'wall',   wall };
  if (s.kind === 'window') return { obj: wall.windows[s.idx], kind: 'window', wall };
  if (s.kind === 'door')   return { obj: wall.doors[s.idx],   kind: 'door',   wall };
  return null;
}

function getCenter(sel) {
  const r = getSelectedObject();
  if (!r) return null;
  if (r.kind === 'wall') {
    return {
      x: Math.round((r.obj.start.x + r.obj.end.x) / 2),
      y: Math.round((r.obj.start.y + r.obj.end.y) / 2)
    };
  }
  // furniture and wall children both have a center field
  return { x: Math.round(r.obj.center.x), y: Math.round(r.obj.center.y) };
}

// ─────────────────────────────────────────────
//  DRAG (move children along wall)
// ─────────────────────────────────────────────
canvas.addEventListener('mousedown', e => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  if (e.button === 1) {                         // middle mouse → pan
    e.preventDefault();
    state.panDrag = { startSX: sx, startSY: sy, origPan: { ...state.pan } };
    canvas.style.cursor = 'grabbing';
    return;
  }

  const hit = hitTest(sx, sy);
  select(hit);

  if (hit && (hit.kind === 'window' || hit.kind === 'door')) {
    state.drag = {
      kind:  hit.kind,
      wall:  hit.wall,
      idx:   hit.idx,
      obj:   hit.obj,
      startSX: sx, startSY: sy,
      origCenter: { ...hit.obj.center },
    };
  }
});

canvas.addEventListener('mousemove', e => {
  if (state.panDrag) {
    const rect = canvas.getBoundingClientRect();
    state.pan.x = state.panDrag.origPan.x + (e.clientX - rect.left - state.panDrag.startSX);
    state.pan.y = state.panDrag.origPan.y + (e.clientY - rect.top  - state.panDrag.startSY);
    render();
    return;
  }
  if (!state.drag) return;
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const dx = (sx - state.drag.startSX) / state.scale;
  const dy = (sy - state.drag.startSY) / state.scale;
  const wall = state.drag.wall;
  const obj  = state.drag.obj;
  const isH  = wallIsHorizontal(wall);

  if (isH) {
    // Clamp to wall bounds
    const minX = Math.min(wall.start.x, wall.end.x) + obj.width / 2;
    const maxX = Math.max(wall.start.x, wall.end.x) - obj.width / 2;
    obj.center.x = Math.max(minX, Math.min(maxX, state.drag.origCenter.x + dx));
  } else {
    const minY = Math.min(wall.start.y, wall.end.y) + obj.height / 2;
    const maxY = Math.max(wall.start.y, wall.end.y) - obj.height / 2;
    obj.center.y = Math.max(minY, Math.min(maxY, state.drag.origCenter.y + dy));
  }

  updateCoordsStrip();
  syncStorage();
  updateInspector();
  render();
});

canvas.addEventListener('mouseup', e => {
  if (state.panDrag) {
    state.panDrag = null;
    canvas.style.cursor = '';
    return;
  }
  if (state.drag) { pushHistory(); state.drag = null; }
});
canvas.addEventListener('mouseleave', () => {
  state.drag = null;
  if (state.panDrag) { state.panDrag = null; canvas.style.cursor = ''; }
});
