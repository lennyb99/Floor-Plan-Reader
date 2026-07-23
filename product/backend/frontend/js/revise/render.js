//  CANVAS / RENDERING
// ─────────────────────────────────────────────
const canvas  = document.getElementById('canvas');
const ctx     = canvas.getContext('2d');
const viewport = document.getElementById('viewport');

// ─────────────────────────────────────────────
//  2D FURNITURE ASSET REGISTRY
//  Map each class to an SVG path under assets/2d/.
//  Set a value to null to use the bounding-box fallback instead.
// ─────────────────────────────────────────────
const FURNITURE_ASSETS_2D = {
  Waschbecken: 'assets/2d/waschbecken.svg',
  Herd:        'assets/2d/herd.svg',
  Toilette:    'assets/2d/toilette.svg',
};

// Loaded SVGs are cached here as HTMLImageElement objects.
// Entries are null while loading or if the file is missing.
const svgCache = {};

async function loadFurnitureAssets2D() {
  await Promise.all(
    Object.entries(FURNITURE_ASSETS_2D).map(async ([cls, path]) => {
      if (!path) { svgCache[cls] = null; return; }
      try {
        const res = await fetch(path);
        if (!res.ok) throw new Error(res.status);
        const blob = await res.blob();
        const url  = URL.createObjectURL(blob);
        await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload  = () => { svgCache[cls] = img; resolve(); };
          img.onerror = () => { svgCache[cls] = null; resolve(); };  // fail gracefully
          img.src = url;
        });
      } catch {
        svgCache[cls] = null;   // file missing → bounding-box fallback
      }
    })
  );
  render();   // redraw once all assets are ready
}

const COLORS = {
  wall:          '#b8bfad',
  wallStroke:    '#576049',
  window:        '#617e82',
  windowFill:    '#c8d8d7',
  door:          '#8a6d5c',
  doorFill:      '#ddcabe',
  selected:      '#8a7552',
  endpointFill:  '#b58b52',
  endpointCore:  '#252a21',
  measure:       '#576049',
  label:         '#3f473a',
  grid:          'rgba(87,96,73,0.09)',
  furniture:     '#8f6652',
  furnitureFill: '#dfc9bc',
};

function resize() {
  const r = viewport.getBoundingClientRect();
  canvas.width  = r.width;
  canvas.height = r.height;
  autoFit();
}

function autoFit() {
  if (!state.data) return;
  const walls = state.data.walls;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  walls.forEach(w => {
    minX = Math.min(minX, w.start.x, w.end.x);
    minY = Math.min(minY, w.start.y, w.end.y);
    maxX = Math.max(maxX, w.start.x, w.end.x);
    maxY = Math.max(maxY, w.start.y, w.end.y);
  });
  const pw = canvas.width - 80, ph = canvas.height - 80;
  const fw = maxX - minX, fh = maxY - minY;
  state.scale = Math.min(pw / fw, ph / fh);
  state.pan.x = (canvas.width  - fw * state.scale) / 2 - minX * state.scale;
  state.pan.y = (canvas.height - fh * state.scale) / 2 - minY * state.scale;
  render();
}

// world → screen
function ws(x, y) {
  return { x: x * state.scale + state.pan.x, y: y * state.scale + state.pan.y };
}
// screen → world
function sw(x, y) {
  return { x: (x - state.pan.x) / state.scale, y: (y - state.pan.y) / state.scale };
}

function wallIsHorizontal(w) {
  return Math.abs(w.end.y - w.start.y) < Math.abs(w.end.x - w.start.x);
}

// Returns canvas-space rect {x,y,w,h} for a wall segment
function wallRect(wall) {
  const t  = Math.max(wall.thickness, 2);
  const s  = ws(wall.start.x, wall.start.y);
  const e  = ws(wall.end.x, wall.end.y);
  const ts = t * state.scale;
  if (wallIsHorizontal(wall)) {
    const x = Math.min(s.x, e.x);
    const y = s.y - ts / 2;
    return { x, y, w: Math.abs(e.x - s.x), h: ts };
  } else {
    const x = s.x - ts / 2;
    const y = Math.min(s.y, e.y);
    return { x, y, w: ts, h: Math.abs(e.y - s.y) };
  }
}

// Returns canvas-space rect for a child (window/door) on its parent wall
function childRect(wall, child) {
  const isH = wallIsHorizontal(wall);
  const t   = Math.max(wall.thickness, 2);
  const ts  = t * state.scale;
  const cen = ws(child.center.x, child.center.y);
  const hw  = (child.width  * state.scale) / 2;
  const hh  = (child.height * state.scale) / 2;
  if (isH) return { x: cen.x - hw, y: cen.y - ts / 2, w: hw * 2, h: ts };
  else     return { x: cen.x - ts / 2, y: cen.y - hh,  w: ts,     h: hh * 2 };
}

function isSelected(kind, wall, idx) {
  const s = state.selected;
  if (!s) return false;
  if (s.kind === 'wall' && kind === 'wall' && s.wallId === wall.id) return true;
  if (s.kind === kind && s.wallId === wall.id && s.idx === idx) return true;
  return false;
}

function render() {
  const { width: W, height: H } = canvas;
  ctx.clearRect(0, 0, W, H);

  // Reference image underlay
  if (state.showRefImg && state.refImg) {
    ctx.save();
    ctx.globalAlpha = 0.45;
    // Draw scaled + panned to match the viewport transform
    const iw = state.refImg.naturalWidth;
    const ih = state.refImg.naturalHeight;
    ctx.drawImage(state.refImg,
      state.pan.x, state.pan.y,
      iw * state.scale, ih * state.scale);
    ctx.restore();
  }

  // Empty state — no file loaded yet
  if (!state.data) {
    ctx.textAlign = 'center';
    ctx.font = '14px ' + getComputedStyle(document.body).fontFamily;
    if (state.detectionsOnly) {
      ctx.fillStyle = '#8a7552';
      ctx.fillText('YOLO detections received — wall segmentation not yet run.', W / 2, H / 2 - 12);
      ctx.fillStyle = '#687060';
      ctx.font = '12px ' + getComputedStyle(document.body).fontFamily;
      ctx.fillText('Run the full pipeline (YOLO + UNet) to enable the editor.', W / 2, H / 2 + 12);
    } else {
      ctx.fillStyle = '#687060';
      ctx.fillText('Load a JSON file  ↙', W / 2, H / 2);
    }
    return;
  }

  // Grid
  if (state.showGrid) {
    const gridStep = 20 * state.scale;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    const ox = state.pan.x % gridStep;
    const oy = state.pan.y % gridStep;
    for (let x = ox; x < W; x += gridStep) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
    for (let y = oy; y < H; y += gridStep) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
  }

  // Measure lines (blue dashed border around whole floorplan)
  if (state.showMeasure) {
    const walls = state.data.walls;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    walls.forEach(w => {
      minX = Math.min(minX, w.start.x, w.end.x);
      minY = Math.min(minY, w.start.y, w.end.y);
      maxX = Math.max(maxX, w.start.x, w.end.x);
      maxY = Math.max(maxY, w.start.y, w.end.y);
    });
    const pad = 18;
    const tl = ws(minX, minY);
    const br = ws(maxX, maxY);
    ctx.strokeStyle = COLORS.measure;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(tl.x - pad, tl.y - pad, br.x - tl.x + pad * 2, br.y - tl.y + pad * 2);
    ctx.setLineDash([]);
    // tick marks
    const tickLen = 6;
    ctx.strokeStyle = COLORS.measure;
    ctx.lineWidth = 1;
    [[tl.x - pad, tl.y - pad],[br.x + pad, tl.y - pad],[tl.x - pad, br.y + pad],[br.x + pad, br.y + pad]].forEach(([cx,cy]) => {
      ctx.beginPath(); ctx.moveTo(cx - tickLen, cy); ctx.lineTo(cx + tickLen, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy - tickLen); ctx.lineTo(cx, cy + tickLen); ctx.stroke();
    });
  }

  // ── 1. Pass 1: Strokes (Outer Border) ─────────────────────────────────────
  // We draw the stroke thicker (1.0) because the fill will cover the inner half.
  const transparency = Math.max(0, Math.min(100, Number(state.objectTransparency) || 0));
  const objectAlpha = state.transparentObjects ? 1 - transparency / 100 : 1;
  ctx.save();
  ctx.globalAlpha = objectAlpha;
  ctx.strokeStyle = COLORS.wallStroke;
  ctx.lineWidth = 1.0;
  
  state.data.walls.forEach(wall => {
    const r = wallRect(wall);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  });

  // ── 2. Pass 2: Fills ──────────────────────────────────────────────────────
  // Filling over the strokes removes the internal intersecting lines!
  ctx.fillStyle = COLORS.wall;
  
  state.data.walls.forEach(wall => {
    const r = wallRect(wall);
    ctx.fillRect(r.x, r.y, r.w, r.h);
  });
  ctx.restore();

  // ── 3. Windows, Doors, and Selection Outlines ─────────────────────────────
  state.data.walls.forEach(wall => {
    const sel = isSelected('wall', wall, null);
    if (sel) {
      const r = wallRect(wall);
      ctx.strokeStyle = COLORS.selected;
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
    }

    // Windows
    wall.windows.forEach((win, i) => {
      const cr   = childRect(wall, win);
      const csel = isSelected('window', wall, i);
      ctx.save();
      ctx.globalAlpha = objectAlpha;
      drawWindow(cr, wallIsHorizontal(wall));
      ctx.restore();
      if (csel) drawSelectionOutline(cr);
      if (state.showLabels) drawLabel(`win_${win.detection_id}`, cr.x + cr.w / 2, cr.y - 6);
    });

    // Doors
    wall.doors.forEach((door, i) => {
      const cr   = childRect(wall, door);
      const csel = isSelected('door', wall, i);
      ctx.save();
      ctx.globalAlpha = objectAlpha;
      ctx.fillStyle   = COLORS.doorFill;
      ctx.strokeStyle = COLORS.door;
      ctx.lineWidth   = 1.5;
      ctx.fillRect(cr.x, cr.y, cr.w, cr.h);
      ctx.strokeRect(cr.x, cr.y, cr.w, cr.h);
      ctx.restore();
      if (csel) drawSelectionOutline(cr);
      if (state.showLabels) drawLabel(`door_${door.detection_id}`, cr.x + cr.w / 2, cr.y - 6);
    });

    if (state.showLabels) {
      const r2 = wallRect(wall);
      drawLabel(wall.id, r2.x + r2.w / 2, r2.y - 4);
    }

    if (sel) drawWallEndpointHandles(wall);
  });

  if (state.showMeasure) {
    const factor = getMetersPerPixel(state.data);
    state.data.walls.forEach(wall => {
      const midpoint = ws(
        (wall.start.x + wall.end.x) / 2,
        (wall.start.y + wall.end.y) / 2,
      );
      const length = wallPixelLength(wall);
      const label = factor ? `${(length * factor).toFixed(2)} m` : `${length.toFixed(0)} px`;
      drawMetricBadge(label, midpoint.x, midpoint.y - Math.max(10, wall.thickness * state.scale / 2 + 9));
    });
    if (factor) {
      (state.rooms || []).forEach(room => {
        const center = ws(room.center.x, room.center.y);
        drawRoomAreaBadge(`${room.area_m2.toFixed(2)} m²`, center.x, center.y);
      });
    }
  }

  // ── Furniture (free-standing items) ───────────────────────────────────────
  (state.data.furniture || []).forEach((item, i) => {
    const fr   = furnitureRect(item);
    const fsel = state.selected && state.selected.kind === 'furniture' && state.selected.idx === i;
    const svg  = svgCache[item.class];

    ctx.save();
    ctx.globalAlpha = objectAlpha;
    if (svg) {
      // ── SVG asset available: draw it fitted into the bounding rect ──────────
      ctx.drawImage(svg, fr.x, fr.y, fr.w, fr.h);
    } else {
      // ── Fallback: orange bounding box ───────────────────────────────────────
      ctx.fillStyle   = COLORS.furnitureFill;
      ctx.strokeStyle = COLORS.furniture;
      ctx.lineWidth   = 1.5;
      ctx.fillRect(fr.x, fr.y, fr.w, fr.h);
      ctx.strokeRect(fr.x, fr.y, fr.w, fr.h);
    }
    ctx.restore();

    if (fsel) drawSelectionOutline(fr);

    // Label: hide when SVG is shown and showLabels is off
    if (!svg || state.showLabels) {
      drawLabel(item.class, fr.x + fr.w / 2, fr.y - 5);
    }
  });
  // Move indicator
  if (state.moveAxis && state.selected) {
    const r = getSelectedObject();
    if (r) {
      let cx = 0, cy = 0;
      if (r.kind === 'wall') {
        cx = (r.obj.start.x + r.obj.end.x) / 2;
        cy = (r.obj.start.y + r.obj.end.y) / 2;
      } else {
        cx = r.obj.center.x;
        cy = r.obj.center.y;
      }
      const p = ws(cx, cy);
      ctx.strokeStyle = '#9b5147';
      ctx.lineWidth = 3;
      ctx.beginPath();
      if (state.moveAxis === 'x') {
        ctx.moveTo(p.x - 20, p.y); ctx.lineTo(p.x + 20, p.y);
        ctx.moveTo(p.x - 15, p.y - 5); ctx.lineTo(p.x - 20, p.y); ctx.lineTo(p.x - 15, p.y + 5);
        ctx.moveTo(p.x + 15, p.y - 5); ctx.lineTo(p.x + 20, p.y); ctx.lineTo(p.x + 15, p.y + 5);
      } else {
        ctx.moveTo(p.x, p.y - 20); ctx.lineTo(p.x, p.y + 20);
        ctx.moveTo(p.x - 5, p.y - 15); ctx.lineTo(p.x, p.y - 20); ctx.lineTo(p.x + 5, p.y - 15);
        ctx.moveTo(p.x - 5, p.y + 15); ctx.lineTo(p.x, p.y + 20); ctx.lineTo(p.x + 5, p.y + 15);
      }
      ctx.stroke();
    }
  }
}


function drawLabel(text, cx, cy) {
  ctx.font = `10px ${getComputedStyle(document.body).fontFamily}`;
  ctx.fillStyle = COLORS.label;
  ctx.textAlign = 'center';
  ctx.fillText(text, cx, cy);
}

function drawMetricBadge(text, cx, cy) {
  ctx.save();
  ctx.font = `600 10px ${getComputedStyle(document.body).fontFamily}`;
  const width = ctx.measureText(text).width + 10;
  ctx.fillStyle = 'rgba(251,252,248,.94)';
  ctx.strokeStyle = '#576049';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(cx - width / 2, cy - 9, width, 18, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#424a38';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

function drawRoomAreaBadge(text, cx, cy) {
  ctx.save();
  ctx.font = `700 12px ${getComputedStyle(document.body).fontFamily}`;
  const width = ctx.measureText(text).width + 18;
  ctx.fillStyle = 'rgba(225,229,217,.94)';
  ctx.strokeStyle = '#8a7552';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(cx - width / 2, cy - 12, width, 24, 7);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#4d5547';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

// Window: grey fill + dark border + center line parallel to wall
function drawWindow(cr, isHorizontal) {
  const lw = 1.5 * Math.min(state.scale, 1.5);
  ctx.fillStyle   = COLORS.windowFill;
  ctx.strokeStyle = COLORS.window;
  ctx.lineWidth   = lw * 2;
  ctx.fillRect(cr.x, cr.y, cr.w, cr.h);
  ctx.strokeRect(cr.x, cr.y, cr.w, cr.h);
  // center line runs along the wall (parallel to wall direction)
  ctx.beginPath();
  if (isHorizontal) {
    const my = cr.y + cr.h / 2;
    ctx.moveTo(cr.x, my); ctx.lineTo(cr.x + cr.w, my);
  } else {
    const mx = cr.x + cr.w / 2;
    ctx.moveTo(mx, cr.y); ctx.lineTo(mx, cr.y + cr.h);
  }
  ctx.stroke();
}

// Canvas-space rect for a free-standing furniture item
function furnitureRect(item) {
  const cen = ws(item.center.x, item.center.y);
  const hw  = (item.width  * state.scale) / 2;
  const hh  = (item.height * state.scale) / 2;
  return { x: cen.x - hw, y: cen.y - hh, w: hw * 2, h: hh * 2 };
}

function drawSelectionOutline(cr) {
  ctx.strokeStyle = COLORS.selected;
  ctx.lineWidth   = 2;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(cr.x - 3, cr.y - 3, cr.w + 6, cr.h + 6);
  ctx.setLineDash([]);
}

function drawWallEndpointHandles(wall) {
  const handles = [
    { endpoint: 'start', point: ws(wall.start.x, wall.start.y) },
    { endpoint: 'end', point: ws(wall.end.x, wall.end.y) },
  ];

  handles.forEach(({ endpoint, point }) => {
    const active = state.drag?.kind === 'wall-endpoint'
      && state.drag.wall.id === wall.id
      && state.drag.endpoint === endpoint;
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, active ? 8 : 7, 0, Math.PI * 2);
    ctx.fillStyle = active ? '#c7a86a' : COLORS.endpointFill;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.endpointCore;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(point.x, point.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.endpointCore;
    ctx.fill();
    ctx.restore();
  });
}

// ─────────────────────────────────────────────
//  HIT TESTING
// ─────────────────────────────────────────────
function hitTest(sx, sy) {
  // Endpoint handles have a generous invisible hit radius so they remain easy
  // to grab even though the visible circles stay precise and unobtrusive.
  if (state.selected?.kind === 'wall') {
    const selectedWall = state.data.walls.find(w => w.id === state.selected.wallId);
    if (selectedWall) {
      const handles = [
        ['start', ws(selectedWall.start.x, selectedWall.start.y)],
        ['end', ws(selectedWall.end.x, selectedWall.end.y)],
      ];
      for (const [endpoint, point] of handles) {
        if (Math.hypot(sx - point.x, sy - point.y) <= 18) {
          return { kind: 'wall-endpoint', wall: selectedWall, endpoint };
        }
      }
    }
  }

  // Once a wall is selected, it owns its complete visible rectangle. This
  // makes a second click-drag reliably move the wall even when the pointer is
  // over an attached door or window.
  if (state.selected?.kind === 'wall') {
    const selectedWall = state.data.walls.find(w => w.id === state.selected.wallId);
    if (selectedWall && inRect(sx, sy, wallRect(selectedWall))) {
      return { kind: 'wall', wall: selectedWall };
    }
  }
  // Test furniture first (on top visually)
  const furniture = state.data.furniture || [];
  for (let i = furniture.length - 1; i >= 0; i--) {
    const fr = furnitureRect(furniture[i]);
    if (inRect(sx, sy, fr)) return { kind: 'furniture', idx: i, obj: furniture[i] };
  }
  // Test wall children
  for (const wall of state.data.walls) {
    for (let i = wall.windows.length - 1; i >= 0; i--) {
      const r = childRect(wall, wall.windows[i]);
      if (inRect(sx, sy, r)) return { kind:'window', wall, idx: i, obj: wall.windows[i] };
    }
    for (let i = wall.doors.length - 1; i >= 0; i--) {
      const r = childRect(wall, wall.doors[i]);
      if (inRect(sx, sy, r)) return { kind:'door', wall, idx: i, obj: wall.doors[i] };
    }
  }
  for (const wall of state.data.walls) {
    const r = wallRect(wall);
    if (inRect(sx, sy, r)) return { kind:'wall', wall };
  }
  return null;
}

function wallEndpointCursor(wall) {
  return wallIsHorizontal(wall) ? 'ew-resize' : 'ns-resize';
}

function inRect(sx, sy, r) {
  return sx >= r.x - 3 && sx <= r.x + r.w + 3 && sy >= r.y - 3 && sy <= r.y + r.h + 3;
}

// ─────────────────────────────────────────────
