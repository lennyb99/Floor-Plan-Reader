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

function getConnectedPoints(targetX, targetY, ignoreWallId) {
  const points = [];
  const EPS = 1.0;
  if (!state.data || !state.data.walls) return points;
  state.data.walls.forEach(w => {
    if (w.id === ignoreWallId) return;
    if (Math.abs(w.start.x - targetX) < EPS && Math.abs(w.start.y - targetY) < EPS) points.push(w.start);
    if (Math.abs(w.end.x - targetX) < EPS && Math.abs(w.end.y - targetY) < EPS) points.push(w.end);
  });
  return points;
}

function getPointsOnSegment(v, w, ignoreWallId) {
  const points = [];
  const EPS = 2.0;
  if (!state.data || !state.data.walls) return points;
  
  function distToSegment(p, v, w) {
    const l2 = (w.x - v.x)**2 + (w.y - v.y)**2;
    if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    const proj = { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) };
    return Math.hypot(p.x - proj.x, p.y - proj.y);
  }

  state.data.walls.forEach(wall => {
    if (wall.id === ignoreWallId) return;
    if (distToSegment(wall.start, v, w) < EPS && 
        Math.hypot(wall.start.x - v.x, wall.start.y - v.y) >= EPS && 
        Math.hypot(wall.start.x - w.x, wall.start.y - w.y) >= EPS) {
      points.push(wall.start);
    }
    if (distToSegment(wall.end, v, w) < EPS && 
        Math.hypot(wall.end.x - v.x, wall.end.y - v.y) >= EPS && 
        Math.hypot(wall.end.x - w.x, wall.end.y - w.y) >= EPS) {
      points.push(wall.end);
    }
  });
  return points;
}

// ─────────────────────────────────────────────
//  DRAG
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
  
  let changed = false;
  if (!hit && state.selected) changed = true;
  else if (hit && !state.selected) changed = true;
  else if (hit && state.selected) {
    if (hit.kind !== state.selected.kind) changed = true;
    else if (hit.wall && hit.wall.id !== state.selected.wallId) changed = true;
    else if (hit.idx !== state.selected.idx) changed = true;
  }
  
  if (changed) {
    state.moveAxis = null;
    select(hit);
  }

  if (hit && (hit.kind === 'window' || hit.kind === 'door')) {
    state.drag = {
      kind:  hit.kind,
      wall:  hit.wall,
      idx:   hit.idx,
      obj:   hit.obj,
      startSX: sx, startSY: sy,
      origCenter: { ...hit.obj.center },
    };
  } else if (hit && hit.kind === 'furniture') {
    state.drag = {
      kind: hit.kind,
      idx: hit.idx,
      obj: hit.obj,
      startSX: sx, startSY: sy,
      origCenter: { ...hit.obj.center },
    };
  } else if (hit && hit.kind === 'wall') {
    if (state.moveAxis) {
      const cStart = getConnectedPoints(hit.wall.start.x, hit.wall.start.y, hit.wall.id);
      const cEnd = getConnectedPoints(hit.wall.end.x, hit.wall.end.y, hit.wall.id);
      const cSeg = getPointsOnSegment(hit.wall.start, hit.wall.end, hit.wall.id);
      state.drag = {
        kind: hit.kind,
        wall: hit.wall,
        startSX: sx, startSY: sy,
        origStart: { ...hit.wall.start },
        origEnd: { ...hit.wall.end },
        connectedToStart: cStart,
        origConnectedToStart: cStart.map(p => ({...p})),
        connectedToEnd: cEnd,
        origConnectedToEnd: cEnd.map(p => ({...p})),
        connectedOnSeg: cSeg,
        origConnectedOnSeg: cSeg.map(p => ({...p})),
        children: [...hit.wall.windows, ...hit.wall.doors],
        origChildrenCenters: [...hit.wall.windows, ...hit.wall.doors].map(c => ({...c.center}))
      };
    }
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

  if (state.drag.kind === 'wall') {
    let axDx = 0, axDy = 0;
    if (state.moveAxis === 'x') axDx = dx;
    if (state.moveAxis === 'y') axDy = dy;
    
    const wall = state.drag.wall;
    wall.start.x = state.drag.origStart.x + axDx;
    wall.start.y = state.drag.origStart.y + axDy;
    wall.end.x = state.drag.origEnd.x + axDx;
    wall.end.y = state.drag.origEnd.y + axDy;

    state.drag.connectedToStart.forEach((pt, i) => {
      pt.x = state.drag.origConnectedToStart[i].x + axDx;
      pt.y = state.drag.origConnectedToStart[i].y + axDy;
    });
    state.drag.connectedToEnd.forEach((pt, i) => {
      pt.x = state.drag.origConnectedToEnd[i].x + axDx;
      pt.y = state.drag.origConnectedToEnd[i].y + axDy;
    });
    state.drag.connectedOnSeg.forEach((pt, i) => {
      pt.x = state.drag.origConnectedOnSeg[i].x + axDx;
      pt.y = state.drag.origConnectedOnSeg[i].y + axDy;
    });
    state.drag.children.forEach((child, i) => {
      child.center.x = state.drag.origChildrenCenters[i].x + axDx;
      child.center.y = state.drag.origChildrenCenters[i].y + axDy;
    });
  } else if (state.drag.kind === 'furniture') {
    const obj = state.drag.obj;
    obj.center.x = state.drag.origCenter.x + dx;
    obj.center.y = state.drag.origCenter.y + dy;
  } else {
    // window / door
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
  }

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
