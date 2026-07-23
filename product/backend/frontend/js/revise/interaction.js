//  SELECTION
// ─────────────────────────────────────────────
function select(hit) {
  if (!hit) {
    state.selected = null;
  } else if (hit.kind === 'wall' || hit.kind === 'wall-endpoint') {
    state.selected = { kind: 'wall', wallId: hit.wall.id };
  } else if (hit.kind === 'furniture' || hit.kind === 'furniture-resize' || hit.kind === 'furniture-rotate') {
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
  const isFurniture = state.selected?.kind === 'furniture';
  hint.classList.toggle('visible', isWall || isFurniture);
  hint.textContent = isWall
    ? 'Wall selected · drag segment to move · drag round ends to resize · arrows nudge'
    : isFurniture
      ? 'Object selected · drag body to move + snap · drag side/corner gizmos to scale · drag round handle to rotate'
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

function setFurnitureSnapState(item, snap) {
  if (!item || !snap) return;
  if (snap.snapped) {
    item.center.x = snap.center.x;
    item.center.y = snap.center.y;
    item.attached_wall_id = snap.attachment.wall_id;
    item.attachment = {
      ...(item.attachment || {}),
      ...snap.attachment,
    };
  } else {
    item.center.x = snap.center.x;
    item.center.y = snap.center.y;
    delete item.attached_wall_id;
    if (item.attachment?.mode === 'bbox_edge_to_wall_thickness') delete item.attachment;
  }
}

function normalizeDegrees(value) {
  let degrees = Number(value) || 0;
  while (degrees <= -180) degrees += 360;
  while (degrees > 180) degrees -= 360;
  return Number(degrees.toFixed(1));
}

function rotateWorldOffset(dx, dy, degrees) {
  const angle = degrees * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: dx * cos - dy * sin,
    y: dx * sin + dy * cos,
  };
}

function screenToLocalForDrag(sx, sy, drag) {
  const pointer = sw(sx, sy);
  const dx = pointer.x - drag.origCenter.x;
  const dy = pointer.y - drag.origCenter.y;
  return rotateWorldOffset(dx, dy, -(drag.localRotation ?? drag.origRotation));
}

function furnitureHandleAnchor(item, handle) {
  const halfW = Math.max(10, Number(item.width) || 10) / 2;
  const halfH = Math.max(10, Number(item.height) || 10) / 2;
  return {
    n:  { affectX: false, affectY: true,  anchorX: 0,      anchorY: halfH,  dirY: -1 },
    e:  { affectX: true,  affectY: false, anchorX: -halfW, anchorY: 0,      dirX: 1 },
    s:  { affectX: false, affectY: true,  anchorX: 0,      anchorY: -halfH, dirY: 1 },
    w:  { affectX: true,  affectY: false, anchorX: halfW,  anchorY: 0,      dirX: -1 },
    nw: { affectX: true,  affectY: true,  anchorX: halfW,  anchorY: halfH,  dirX: -1, dirY: -1 },
    ne: { affectX: true,  affectY: true,  anchorX: -halfW, anchorY: halfH,  dirX: 1,  dirY: -1 },
    se: { affectX: true,  affectY: true,  anchorX: -halfW, anchorY: -halfH, dirX: 1,  dirY: 1 },
    sw: { affectX: true,  affectY: true,  anchorX: halfW,  anchorY: -halfH, dirX: -1, dirY: 1 },
  }[handle];
}

function resizeFurnitureFromHandle(drag, sx, sy) {
  const minSize = 10;
  const local = screenToLocalForDrag(sx, sy, drag);
  let width = drag.origWidth;
  let height = drag.origHeight;
  let centerLocalX = 0;
  let centerLocalY = 0;

  if (drag.anchor.affectX) {
    const edgeX = drag.anchor.dirX > 0
      ? Math.max(local.x, drag.anchor.anchorX + minSize)
      : Math.min(local.x, drag.anchor.anchorX - minSize);
    width = Math.abs(edgeX - drag.anchor.anchorX);
    centerLocalX = (edgeX + drag.anchor.anchorX) / 2;
  }

  if (drag.anchor.affectY) {
    const edgeY = drag.anchor.dirY > 0
      ? Math.max(local.y, drag.anchor.anchorY + minSize)
      : Math.min(local.y, drag.anchor.anchorY - minSize);
    height = Math.abs(edgeY - drag.anchor.anchorY);
    centerLocalY = (edgeY + drag.anchor.anchorY) / 2;
  }

  const worldOffset = rotateWorldOffset(centerLocalX, centerLocalY, drag.localRotation ?? drag.origRotation);
  drag.obj.width = Number(width.toFixed(1));
  drag.obj.height = Number(height.toFixed(1));
  drag.obj.user_scaled = true;
  drag.obj.center.x = Number((drag.origCenter.x + worldOffset.x).toFixed(2));
  drag.obj.center.y = Number((drag.origCenter.y + worldOffset.y).toFixed(2));
  drag.obj.rotation = drag.origRotation;
  const snap = snapFurnitureToWallThickness(drag.obj, state.data?.walls, 18);
  setFurnitureSnapState(drag.obj, snap);
  drag.snap = snap;
  drag.moved = true;
}

function pointerAngleDegrees(sx, sy, center) {
  const pointer = sw(sx, sy);
  return Math.atan2(pointer.y - center.y, pointer.x - center.x) * 180 / Math.PI;
}

function rotateFurnitureFromHandle(drag, sx, sy, snapToStep = false) {
  const pointerAngle = pointerAngleDegrees(sx, sy, drag.origCenter);
  let visualRotation = (drag.localRotation ?? drag.origRotation) + pointerAngle - drag.startAngle;
  if (snapToStep) visualRotation = Math.round(visualRotation / 15) * 15;
  drag.obj.rotation = typeof furnitureCanonicalRotationDegrees === 'function'
    ? furnitureCanonicalRotationDegrees(visualRotation, drag.obj)
    : normalizeDegrees(visualRotation);
  const snap = snapFurnitureToWallThickness(drag.obj, state.data?.walls, 24);
  setFurnitureSnapState(drag.obj, snap);
  drag.snap = snap;
  drag.moved = true;
}

// ─────────────────────────────────────────────
//  DRAG (move wall segments or openings)

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

  if (hit?.kind === 'furniture-rotate') {
    const currentRotation = Number.isFinite(Number(hit.obj.rotation))
      ? Number(hit.obj.rotation)
      : (Number.isFinite(Number(hit.obj._rotationY)) ? -Number(hit.obj._rotationY) * 180 / Math.PI : 0);
    const currentVisualRotation = typeof furnitureVisualRotationDegrees === 'function'
      ? furnitureVisualRotationDegrees(hit.obj)
      : currentRotation;
    state.drag = {
      kind: 'furniture-rotate',
      idx: hit.idx,
      obj: hit.obj,
      origCenter: { ...hit.obj.center },
      origRotation: normalizeDegrees(currentRotation),
      localRotation: normalizeDegrees(currentVisualRotation),
      startAngle: pointerAngleDegrees(sx, sy, hit.obj.center),
      moved: false,
    };
    canvas.style.cursor = 'grabbing';
  } else if (hit?.kind === 'furniture-resize') {
    const currentRotation = Number.isFinite(Number(hit.obj.rotation))
      ? Number(hit.obj.rotation)
      : (Number.isFinite(Number(hit.obj._rotationY)) ? -Number(hit.obj._rotationY) * 180 / Math.PI : 0);
    const currentVisualRotation = typeof furnitureVisualRotationDegrees === 'function'
      ? furnitureVisualRotationDegrees(hit.obj)
      : currentRotation;
    state.drag = {
      kind: 'furniture-resize',
      idx: hit.idx,
      obj: hit.obj,
      handle: hit.handle,
      anchor: furnitureHandleAnchor(hit.obj, hit.handle),
      origCenter: { ...hit.obj.center },
      origRotation: normalizeDegrees(currentRotation),
      localRotation: normalizeDegrees(currentVisualRotation),
      origWidth: Math.max(10, Number(hit.obj.width) || 10),
      origHeight: Math.max(10, Number(hit.obj.height) || 10),
      moved: false,
    };
    canvas.style.cursor = hit.cursor || 'nwse-resize';
  } else if (hit?.kind === 'wall-endpoint') {
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
    canvas.style.cursor = hover?.kind === 'wall-endpoint'
      ? wallEndpointCursor(hover.wall)
      : hover?.kind === 'furniture-resize'
        ? (hover.cursor || 'nwse-resize')
        : hover?.kind === 'furniture-rotate'
          ? 'grab'
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
    state.drag.moved = Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1;
    if (state.drag.kind === 'furniture-rotate') {
      rotateFurnitureFromHandle(state.drag, sx, sy, e.shiftKey);
    } else if (state.drag.kind === 'furniture-resize') {
      resizeFurnitureFromHandle(state.drag, sx, sy);
    } else if (state.drag.kind === 'furniture') {
      const obj = state.drag.obj;
      const proposed = {
        ...obj,
        center: {
          x: state.drag.origCenter.x + dx,
          y: state.drag.origCenter.y + dy,
        },
      };
      const snap = snapFurnitureToWallThickness(proposed, state.data?.walls, 18);
      setFurnitureSnapState(obj, snap);
      state.drag.snap = snap;
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
    if (state.drag.moved) {
      const normalize = state.drag.kind === 'wall' || state.drag.kind === 'wall-endpoint';
      commitFloorplanChange({ normalize, announceTopology: normalize });
    }
    state.drag = null;
    canvas.style.cursor = '';
  }
});
canvas.addEventListener('mouseleave', () => {
  if (state.drag?.moved) {
    const normalize = state.drag.kind === 'wall' || state.drag.kind === 'wall-endpoint';
    commitFloorplanChange({ normalize, announceTopology: normalize });
  }
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
