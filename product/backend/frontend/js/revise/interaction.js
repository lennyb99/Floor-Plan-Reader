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

function moveWallBy(wall, dx, dy) {
  wall.start.x += dx; wall.start.y += dy;
  wall.end.x += dx; wall.end.y += dy;
  [...(wall.windows || []), ...(wall.doors || [])].forEach(opening => {
    opening.center.x += dx;
    opening.center.y += dy;
  });
}

function updateSelectionHint() {
  const hint = document.getElementById('selection-hint');
  const isWall = state.selected?.kind === 'wall';
  hint.classList.toggle('visible', isWall);
  hint.textContent = isWall
    ? 'Wall selected · drag to move · arrow keys nudge · Shift = 10 px'
    : 'Select a wall and drag to move the complete segment.';
}

// ─────────────────────────────────────────────
//  DRAG (move wall segments or openings)
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
  if (e.button !== 0) return;

  const hit = hitTest(sx, sy);
  select(hit);

  if (hit?.kind === 'wall') {
    state.drag = {
      kind: 'wall',
      wall: hit.wall,
      startSX: sx, startSY: sy,
      origStart: { ...hit.wall.start },
      origEnd: { ...hit.wall.end },
      origWindows: (hit.wall.windows || []).map(item => ({ ...item.center })),
      origDoors: (hit.wall.doors || []).map(item => ({ ...item.center })),
      moved: false,
    };
    canvas.style.cursor = 'grabbing';
  } else if (hit && (hit.kind === 'window' || hit.kind === 'door')) {
    state.drag = {
      kind:  hit.kind,
      wall:  hit.wall,
      idx:   hit.idx,
      obj:   hit.obj,
      startSX: sx, startSY: sy,
      origCenter: { ...hit.obj.center },
      moved: false,
    };
    canvas.style.cursor = 'grabbing';
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
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  if (!state.drag) {
    const hover = state.data ? hitTest(sx, sy) : null;
    canvas.style.cursor = hover ? 'grab' : 'default';
    return;
  }
  const dx = (sx - state.drag.startSX) / state.scale;
  const dy = (sy - state.drag.startSY) / state.scale;
  const wall = state.drag.wall;
  state.drag.moved = Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1;

  if (state.drag.kind === 'wall') {
    wall.start.x = state.drag.origStart.x + dx;
    wall.start.y = state.drag.origStart.y + dy;
    wall.end.x = state.drag.origEnd.x + dx;
    wall.end.y = state.drag.origEnd.y + dy;
    (wall.windows || []).forEach((item, index) => {
      item.center.x = state.drag.origWindows[index].x + dx;
      item.center.y = state.drag.origWindows[index].y + dy;
    });
    (wall.doors || []).forEach((item, index) => {
      item.center.x = state.drag.origDoors[index].x + dx;
      item.center.y = state.drag.origDoors[index].y + dy;
    });
  } else {
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
  if (state.drag) {
    if (state.drag.moved) pushHistory();
    state.drag = null;
    canvas.style.cursor = '';
  }
});
canvas.addEventListener('mouseleave', () => {
  if (state.drag?.moved) pushHistory();
  state.drag = null;
  canvas.style.cursor = '';
  if (state.panDrag) { state.panDrag = null; canvas.style.cursor = ''; }
});

document.addEventListener('keydown', event => {
  if (document.activeElement.tagName === 'INPUT' || state.selected?.kind !== 'wall') return;
  const delta = event.shiftKey ? 10 : 1;
  const movement = {
    ArrowLeft: [-delta, 0], ArrowRight: [delta, 0],
    ArrowUp: [0, -delta], ArrowDown: [0, delta],
  }[event.key];
  if (!movement) return;
  const selected = getSelectedObject();
  if (!selected?.wall) return;
  event.preventDefault();
  moveWallBy(selected.wall, movement[0], movement[1]);
  syncStorage();
  pushHistory();
  updateSidebar();
  updateInspector();
  render();
});
