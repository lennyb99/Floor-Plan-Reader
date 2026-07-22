//  SELECTION
// ─────────────────────────────────────────────
function select(hit) {
  if (!hit) {
    state.selected = null;
  } else if (hit.kind === 'wall' || hit.kind === 'wall-endpoint') {
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
    ? 'Wall selected · drag segment to move · drag round ends to resize · arrows nudge'
    : 'Select a wall and drag to move the complete segment.';
}

function captureOpeningRatios(wall, start, end) {
  return {
    // Openings keep their absolute position when one wall endpoint changes.
    // This prevents visually surprising proportional "scaling" of windows and
    // doors while still clamping them to the edited wall segment.
    windows: (wall.windows || []).map(item => ({ ...item.center })),
    doors: (wall.doors || []).map(item => ({ ...item.center })),
  };
}

function positionOpeningOnWall(wall, opening, ratio) {
  const isH = wallIsHorizontal(wall);
  const halfExtent = openingExtentAlongWall(wall, opening) / 2;
  if (isH) {
    const min = Math.min(wall.start.x, wall.end.x);
    const max = Math.max(wall.start.x, wall.end.x);
    const inset = Math.min(halfExtent, Math.max(0, (max - min) / 2));
    const target = wall.start.x + (wall.end.x - wall.start.x) * ratio;
    opening.center.x = Math.max(min + inset, Math.min(max - inset, target));
    opening.center.y = wall.start.y;
  } else {
    const min = Math.min(wall.start.y, wall.end.y);
    const max = Math.max(wall.start.y, wall.end.y);
    const inset = Math.min(halfExtent, Math.max(0, (max - min) / 2));
    const target = wall.start.y + (wall.end.y - wall.start.y) * ratio;
    opening.center.x = wall.start.x;
    opening.center.y = Math.max(min + inset, Math.min(max - inset, target));
  }
}

function keepOpeningPositionOnWall(wall, opening, originalCenter) {
  const isH = wallIsHorizontal(wall);
  const halfExtent = openingExtentAlongWall(wall, opening) / 2;
  if (isH) {
    const min = Math.min(wall.start.x, wall.end.x);
    const max = Math.max(wall.start.x, wall.end.x);
    const inset = Math.min(halfExtent, Math.max(0, (max - min) / 2));
    opening.center.x = Math.max(min + inset, Math.min(max - inset, originalCenter.x));
    opening.center.y = wall.start.y;
  } else {
    const min = Math.min(wall.start.y, wall.end.y);
    const max = Math.max(wall.start.y, wall.end.y);
    const inset = Math.min(halfExtent, Math.max(0, (max - min) / 2));
    opening.center.x = wall.start.x;
    opening.center.y = Math.max(min + inset, Math.min(max - inset, originalCenter.y));
  }
}

function repositionAttachedOpenings(wall, ratios) {
  (wall.windows || []).forEach((item, index) => keepOpeningPositionOnWall(wall, item, ratios.windows[index] || item.center));
  (wall.doors || []).forEach((item, index) => keepOpeningPositionOnWall(wall, item, ratios.doors[index] || item.center));
}

function moveWallEndpoint(drag, dx, dy) {
  const wall = drag.wall;
  const originalLength = Math.hypot(
    drag.origEnd.x - drag.origStart.x,
    drag.origEnd.y - drag.origStart.y,
  );
  const minLength = Math.min(Math.max(8, Number(wall.thickness) || 0), originalLength);
  const isStart = drag.endpoint === 'start';
  const fixed = isStart ? drag.origEnd : drag.origStart;
  const moving = isStart ? { ...drag.origStart } : { ...drag.origEnd };

  if (drag.horizontal) {
    const proposed = moving.x + dx;
    const direction = drag.direction;
    const fixedScalar = fixed.x * direction;
    const proposedScalar = proposed * direction;
    moving.x = (isStart
      ? Math.min(proposedScalar, fixedScalar - minLength)
      : Math.max(proposedScalar, fixedScalar + minLength)) / direction;
  } else {
    const proposed = moving.y + dy;
    const direction = drag.direction;
    const fixedScalar = fixed.y * direction;
    const proposedScalar = proposed * direction;
    moving.y = (isStart
      ? Math.min(proposedScalar, fixedScalar - minLength)
      : Math.max(proposedScalar, fixedScalar + minLength)) / direction;
  }

  const snap = snapWallEndpointToVisibleEdges(state.data?.walls, wall, drag.endpoint, moving);
  if (snap.snapped && Math.hypot(snap.point.x - fixed.x, snap.point.y - fixed.y) >= minLength) {
    moving.x = snap.point.x;
    moving.y = snap.point.y;
  }

  if (isStart) wall.start = moving;
  else wall.end = moving;
  repositionAttachedOpenings(wall, drag.openingRatios);

  const original = isStart ? drag.origStart : drag.origEnd;
  return Math.hypot(moving.x - original.x, moving.y - original.y) > 0.1;
}

function snapWallMoveOffset(drag, moveDx, moveDy) {
  if (state.moveAxis) return { dx: moveDx, dy: moveDy };
  const preview = {
    ...drag.wall,
    start: {
      x: drag.origStart.x + moveDx,
      y: drag.origStart.y + moveDy,
    },
    end: {
      x: drag.origEnd.x + moveDx,
      y: drag.origEnd.y + moveDy,
    },
  };
  let best = null;
  ['start', 'end'].forEach(endpoint => {
    const proposed = preview[endpoint];
    const snap = snapWallEndpointToVisibleEdges(state.data?.walls, preview, endpoint, proposed);
    if (!snap.snapped) return;
    const offset = {
      dx: snap.point.x - proposed.x,
      dy: snap.point.y - proposed.y,
    };
    const distance = Math.hypot(offset.dx, offset.dy);
    if (best && distance >= best.distance) return;
    best = { distance, offset };
  });
  return best
    ? { dx: moveDx + best.offset.dx, dy: moveDy + best.offset.dy }
    : { dx: moveDx, dy: moveDy };
}

// ─────────────────────────────────────────────
//  DRAG (move wall segments or openings)
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
  if (e.button !== 0) return;

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

  if (hit?.kind === 'wall-endpoint') {
    const horizontal = wallIsHorizontal(hit.wall);
    const axisDelta = horizontal
      ? hit.wall.end.x - hit.wall.start.x
      : hit.wall.end.y - hit.wall.start.y;
    state.drag = {
      kind: 'wall-endpoint',
      wall: hit.wall,
      endpoint: hit.endpoint,
      horizontal,
      direction: Math.sign(axisDelta) || 1,
      startSX: sx, startSY: sy,
      origStart: { ...hit.wall.start },
      origEnd: { ...hit.wall.end },
      openingRatios: captureOpeningRatios(hit.wall, hit.wall.start, hit.wall.end),
      moved: false,
    };
    canvas.style.cursor = wallEndpointCursor(hit.wall);
  } else if (hit?.kind === 'wall') {
    const connectedToStart = state.moveAxis
      ? getConnectedPoints(hit.wall.start.x, hit.wall.start.y, hit.wall.id)
      : [];
    const connectedToEnd = state.moveAxis
      ? getConnectedPoints(hit.wall.end.x, hit.wall.end.y, hit.wall.id)
      : [];
    const connectedOnSeg = state.moveAxis
      ? getPointsOnSegment(hit.wall.start, hit.wall.end, hit.wall.id)
      : [];
    const children = [...(hit.wall.windows || []), ...(hit.wall.doors || [])];
    state.drag = {
      kind: 'wall',
      wall: hit.wall,
      startSX: sx, startSY: sy,
      origStart: { ...hit.wall.start },
      origEnd: { ...hit.wall.end },
      origWindows: (hit.wall.windows || []).map(item => ({ ...item.center })),
      origDoors: (hit.wall.doors || []).map(item => ({ ...item.center })),
      connectedToStart,
      origConnectedToStart: connectedToStart.map(point => ({ ...point })),
      connectedToEnd,
      origConnectedToEnd: connectedToEnd.map(point => ({ ...point })),
      connectedOnSeg,
      origConnectedOnSeg: connectedOnSeg.map(point => ({ ...point })),
      children,
      origChildrenCenters: children.map(child => ({ ...child.center })),
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
  } else if (hit && hit.kind === 'furniture') {
    state.drag = {
      kind: hit.kind,
      idx: hit.idx,
      obj: hit.obj,
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
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  if (!state.drag) {
    const hover = state.data ? hitTest(sx, sy) : null;
    canvas.style.cursor = hover?.kind === 'wall-endpoint'
      ? wallEndpointCursor(hover.wall)
      : (hover ? 'grab' : 'default');
    return;
  }
  const dx = (sx - state.drag.startSX) / state.scale;
  const dy = (sy - state.drag.startSY) / state.scale;
  const wall = state.drag.wall;

  if (state.drag.kind === 'wall-endpoint') {
    state.drag.moved = moveWallEndpoint(state.drag, dx, dy);
  } else if (state.drag.kind === 'wall') {
    state.drag.moved = Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1;
    let moveDx = dx;
    let moveDy = dy;
    if (state.moveAxis === 'x') moveDy = 0;
    if (state.moveAxis === 'y') moveDx = 0;
    const snappedMove = snapWallMoveOffset(state.drag, moveDx, moveDy);
    moveDx = snappedMove.dx;
    moveDy = snappedMove.dy;

    state.drag.connectedToStart.forEach((pt, i) => {
      pt.x = state.drag.origConnectedToStart[i].x + moveDx;
      pt.y = state.drag.origConnectedToStart[i].y + moveDy;
    });
    state.drag.connectedToEnd.forEach((pt, i) => {
      pt.x = state.drag.origConnectedToEnd[i].x + moveDx;
      pt.y = state.drag.origConnectedToEnd[i].y + moveDy;
    });
    state.drag.connectedOnSeg.forEach((pt, i) => {
      pt.x = state.drag.origConnectedOnSeg[i].x + moveDx;
      pt.y = state.drag.origConnectedOnSeg[i].y + moveDy;
    });

    wall.start.x = state.drag.origStart.x + moveDx;
    wall.start.y = state.drag.origStart.y + moveDy;
    wall.end.x = state.drag.origEnd.x + moveDx;
    wall.end.y = state.drag.origEnd.y + moveDy;
    (wall.windows || []).forEach((item, index) => {
      item.center.x = state.drag.origWindows[index].x + moveDx;
      item.center.y = state.drag.origWindows[index].y + moveDy;
    });
    (wall.doors || []).forEach((item, index) => {
      item.center.x = state.drag.origDoors[index].x + moveDx;
      item.center.y = state.drag.origDoors[index].y + moveDy;
    });
  } else if (state.drag.kind === 'furniture') {
    const obj = state.drag.obj;
    obj.center.x = state.drag.origCenter.x + dx;
    obj.center.y = state.drag.origCenter.y + dy;
    state.drag.moved = Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1;
  } else {
    // window / door
    const wall = state.drag.wall;
    const obj  = state.drag.obj;
    const isH  = wallIsHorizontal(wall);
    state.drag.moved = Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1;

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
  if (state.drag) {
    if (state.drag.moved) commitFloorplanChange({ normalize: true, announceTopology: true });
    state.drag = null;
    canvas.style.cursor = '';
  }
});
canvas.addEventListener('mouseleave', () => {
  if (state.drag?.moved) commitFloorplanChange({ normalize: true, announceTopology: true });
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
  commitFloorplanChange({ normalize: true });
});
