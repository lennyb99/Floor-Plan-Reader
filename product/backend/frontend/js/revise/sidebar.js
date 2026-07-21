//  SIDEBAR: HIERARCHY + COORDS
// ─────────────────────────────────────────────
function updateSidebar() {
  buildHierarchy();
  updateSelectionHint();
}

function escapeInspectorText(value) {
  return String(value).replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function coordinateField(id, label, value) {
  return `<label class="coordinate-field" for="${id}"><span>${label}</span><input type="number" id="${id}" step="0.1" value="${Number(value).toFixed(1)}"></label>`;
}

function roomSummaryMarkup() {
  const factor = getMetersPerPixel(state.data);
  const rooms = state.rooms || [];
  if (!rooms.length) {
    return `<section class="room-summary"><div class="insp-section-title">Rooms</div><p>No closed room boundary found. Close remaining wall gaps to calculate areas.</p></section>`;
  }
  const rows = rooms.map(room => `<li><span>${escapeInspectorText(room.id.replace('_', ' '))}</span><strong>${factor ? `${room.area_m2.toFixed(2)} m²` : `${room.area_px2.toLocaleString()} px²`}</strong></li>`).join('');
  return `<section class="room-summary"><div class="insp-section-title">Rooms <span>${rooms.length}</span></div><ul>${rows}</ul>${factor ? '' : '<p>Enter one known wall length to convert every area to m².</p>'}</section>`;
}

function bindInspectorNumber(id, callback) {
  const input = document.getElementById(id);
  if (!input) return;
  input.addEventListener('change', event => {
    const value = Number(event.currentTarget.value);
    if (!Number.isFinite(value)) return;
    callback(value);
  });
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.currentTarget.blur();
  });
}

function bindCenterCoordinates(r) {
  bindInspectorNumber('insp-center-x', value => {
    r.obj.center.x = value;
    if (r.wall) keepOpeningPositionOnWall(r.wall, r.obj, r.obj.center);
    commitFloorplanChange({ normalize: false });
  });
  bindInspectorNumber('insp-center-y', value => {
    r.obj.center.y = value;
    if (r.wall) keepOpeningPositionOnWall(r.wall, r.obj, r.obj.center);
    commitFloorplanChange({ normalize: false });
  });
}

function bindWallCoordinates(wall) {
  const originalHorizontal = wallIsHorizontal(wall);
  const openingState = captureOpeningRatios(wall, wall.start, wall.end);
  const commitCoordinate = (endpoint, axis, value) => {
    wall[endpoint][axis] = value;
    if (originalHorizontal && axis === 'y') {
      wall.start.y = value;
      wall.end.y = value;
    } else if (!originalHorizontal && axis === 'x') {
      wall.start.x = value;
      wall.end.x = value;
    }
    repositionAttachedOpenings(wall, openingState);
    commitFloorplanChange({ normalize: true, announceTopology: true });
  };
  bindInspectorNumber('insp-start-x', value => commitCoordinate('start', 'x', value));
  bindInspectorNumber('insp-start-y', value => commitCoordinate('start', 'y', value));
  bindInspectorNumber('insp-end-x', value => commitCoordinate('end', 'x', value));
  bindInspectorNumber('insp-end-y', value => commitCoordinate('end', 'y', value));
}

function updateInspectorLiveValues(r) {
  const setValue = (id, value) => {
    const input = document.getElementById(id);
    if (input && document.activeElement !== input) input.value = Number(value).toFixed(1);
  };
  if (r.kind === 'wall') {
    setValue('insp-start-x', r.obj.start.x);
    setValue('insp-start-y', r.obj.start.y);
    setValue('insp-end-x', r.obj.end.x);
    setValue('insp-end-y', r.obj.end.y);
  } else {
    setValue('insp-center-x', r.obj.center.x);
    setValue('insp-center-y', r.obj.center.y);
  }
}

function updateInspector(force = false) {
  const insp = document.getElementById('inspector');
  const body = document.getElementById('insp-body');

  if (!state.selected) {
    insp.classList.remove('open');
    insp.removeAttribute('data-insp-id');
    return;
  }

  const r = getSelectedObject();
  if (!r) {
    insp.classList.remove('open');
    insp.removeAttribute('data-insp-id');
    return;
  }

  insp.classList.add('open');
  const targetId = r.kind === 'furniture' ? `furn_${r.idx}` : (r.kind === 'wall' ? r.obj.id : `${r.wall.id}_${r.kind}_${r.idx}`);
  if (!force && insp.getAttribute('data-insp-id') === targetId) {
    updateInspectorLiveValues(r);
    return;
  }
  insp.setAttribute('data-insp-id', targetId);

  if (r.kind === 'wall') {
    const w = r.obj;
    const lengthPx = wallPixelLength(w);
    const factor = getMetersPerPixel(state.data);
    const realLength = factor ? lengthPx * factor : '';
    body.innerHTML = `
      <div class="insp-row">
        <label>ID <span class="val">${escapeInspectorText(w.id)}</span></label>

  if (insp.getAttribute('data-insp-id') === targetId) {
    if (r.kind === 'wall') {
      const len = Math.hypot(r.obj.end.x - r.obj.start.x, r.obj.end.y - r.obj.start.y).toFixed(1);
      const cx = Math.round((r.obj.start.x + r.obj.end.x) / 2);
      const cy = Math.round((r.obj.start.y + r.obj.end.y) / 2);
      if (document.activeElement !== document.getElementById('insp-len')) {
        document.getElementById('insp-len').value = Math.round(len);
        document.getElementById('insp-len-val').textContent = len;
      }
      if (document.activeElement !== document.getElementById('insp-cx')) {
        document.getElementById('insp-cx').value = cx;
        document.getElementById('insp-cx-val').textContent = cx;
      }
      if (document.activeElement !== document.getElementById('insp-cy')) {
        document.getElementById('insp-cy').value = cy;
        document.getElementById('insp-cy-val').textContent = cy;
      }
      if (document.activeElement !== document.getElementById('insp-thick')) {
        document.getElementById('insp-thick').value = r.obj.thickness;
        document.getElementById('insp-thick-val').textContent = r.obj.thickness;
      }
      const bx = document.getElementById('btn-move-x');
      if (bx) {
        bx.style.borderColor = state.moveAxis === 'x' ? '#d39e53' : '#555';
        bx.style.color = state.moveAxis === 'x' ? '#d39e53' : '#d0d0d0';
      }
      const by = document.getElementById('btn-move-y');
      if (by) {
        by.style.borderColor = state.moveAxis === 'y' ? '#d39e53' : '#555';
        by.style.color = state.moveAxis === 'y' ? '#d39e53' : '#d0d0d0';
      }
      document.getElementById('insp-thick').value = r.obj.thickness;
      document.getElementById('insp-thick-val').textContent = r.obj.thickness;
    } else if (r.kind === 'window' || r.kind === 'door') {
      const cx = Math.round(r.obj.center.x);
      const cy = Math.round(r.obj.center.y);
      if (document.activeElement !== document.getElementById('insp-cx')) {
        document.getElementById('insp-cx').value = cx;
        document.getElementById('insp-cx-val').textContent = cx;
      }
      if (document.activeElement !== document.getElementById('insp-cy')) {
        document.getElementById('insp-cy').value = cy;
        document.getElementById('insp-cy-val').textContent = cy;
      }
      if (document.activeElement !== document.getElementById('insp-width')) {
        document.getElementById('insp-width').value = r.obj.width;
        document.getElementById('insp-width-val').textContent = r.obj.width;
      }
    } else if (r.kind === 'furniture') {
      const cx = Math.round(r.obj.center.x);
      const cy = Math.round(r.obj.center.y);
      if (document.activeElement !== document.getElementById('insp-cx')) {
        document.getElementById('insp-cx').value = cx;
        document.getElementById('insp-cx-val').textContent = cx;
      }
      if (document.activeElement !== document.getElementById('insp-cy')) {
        document.getElementById('insp-cy').value = cy;
        document.getElementById('insp-cy-val').textContent = cy;
      }
      if (document.activeElement !== document.getElementById('insp-width')) {
        document.getElementById('insp-width').value = r.obj.width;
        document.getElementById('insp-width-val').textContent = r.obj.width;
      }
      if (document.activeElement !== document.getElementById('insp-height')) {
        document.getElementById('insp-height').value = r.obj.height;
        document.getElementById('insp-height-val').textContent = r.obj.height;
      }
    }
    return;
  }

insp.setAttribute('data-insp-id', targetId);

if (r.kind === 'wall') {
  const w = r.obj;
  const len = Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y).toFixed(1);
  const cx = Math.round((w.start.x + w.end.x) / 2);
  const cy = Math.round((w.start.y + w.end.y) / 2);
  body.innerHTML = `
      <div class="insp-row">
        <label>ID <span class="val">${w.id}</span></label>
      </div>
      <div class="insp-row">
        <label>Center X <span class="val"><span id="insp-cx-val">${cx}</span> px</span></label>
        <div style="display:flex;gap:4px">
          <input type="number" id="insp-cx" value="${cx}" style="width:100%">
          <button id="btn-move-x" title="Move X" style="padding:0 6px;cursor:pointer;border:1px solid ${state.moveAxis === 'x' ? '#d39e53' : '#555'};background:transparent;color:${state.moveAxis === 'x' ? '#d39e53' : '#d0d0d0'};border-radius:3px">↔</button>
        </div>
      </div>
      <div class="insp-row">
        <label>Center Y <span class="val"><span id="insp-cy-val">${cy}</span> px</span></label>
        <div style="display:flex;gap:4px">
          <input type="number" id="insp-cy" value="${cy}" style="width:100%">
          <button id="btn-move-y" title="Move Y" style="padding:0 6px;cursor:pointer;border:1px solid ${state.moveAxis === 'y' ? '#d39e53' : '#555'};background:transparent;color:${state.moveAxis === 'y' ? '#d39e53' : '#d0d0d0'};border-radius:3px">↕</button>
        </div>
      </div>
      <div class="insp-row">
        <label>Length <span class="val"><span id="insp-len-val">${len}</span> px</span></label>
        <input type="number" id="insp-len" value="${Math.round(len)}">
      </div>
      <section class="insp-section"><div class="insp-section-title">Coordinates <span>px</span></div><div class="coordinate-grid">
        ${coordinateField('insp-start-x', 'Start X', w.start.x)}
        ${coordinateField('insp-start-y', 'Start Y', w.start.y)}
        ${coordinateField('insp-end-x', 'End X', w.end.x)}
        ${coordinateField('insp-end-y', 'End Y', w.end.y)}
      </div></section>
      <section class="insp-section"><div class="insp-section-title">Measurement</div>
        <div class="insp-row"><label>Detected length <span class="val">${lengthPx.toFixed(1)} px</span></label></div>
        <label class="number-setting" for="insp-real-length"><span>Known real length</span><span class="number-with-unit"><input type="number" id="insp-real-length" min="0.01" step="0.01" placeholder="e.g. 4.20" value="${realLength === '' ? '' : realLength.toFixed(3)}"><span>m</span></span></label>
        <p class="field-help">This reference calibrates every wall length and all closed room areas.</p>
        <div class="scale-readout">${factor ? `1 px = ${(factor * 1000).toFixed(2)} mm` : 'Scale not calibrated'}</div>
      </section>
      <div class="insp-row">
        <label>Thickness <span class="val"><span id="insp-thick-val">${w.thickness}</span> px</span></label>
        <input type="range" id="insp-thick" min="4" max="80" value="${w.thickness}">
      </div>
      <div class="insp-note">Doors keep their absolute position when an endpoint moves. Cross-sections are split and nearby L/T junctions snap after each edit.</div>
      ${roomSummaryMarkup()}`;

    bindWallCoordinates(w);
    bindInspectorNumber('insp-real-length', value => {
      if (!setScaleFromReferenceWall(state.data, w, value)) {
        showToast('Enter a positive real wall length.');
        return;
      }
      commitFloorplanChange({ normalize: false });
      showToast('Plan scale calibrated. All lengths and room areas updated.');
    });
    const inp = document.getElementById('insp-thick');
    inp.addEventListener('input', e => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('insp-thick-val').textContent = val;
      w.thickness = val;
      syncStorage();
      render();
    });
    inp.addEventListener('change', () => commitFloorplanChange({ normalize: true }));

  } else if (r.kind === 'window' || r.kind === 'door') {
    const obj = r.obj;
    const visibleWidth = openingExtentAlongWall(r.wall, obj);
    body.innerHTML = `
      </div>`;

  document.getElementById('insp-cx').addEventListener('change', e => {
    pushHistory();
    const val = parseInt(e.target.value, 10);
    if (isNaN(val)) return;
    const oldCX = (w.start.x + w.end.x) / 2;
    const dx = val - oldCX;
    const conStart = getConnectedPoints(w.start.x, w.start.y, w.id);
    const conEnd = getConnectedPoints(w.end.x, w.end.y, w.id);
    const conSeg = getPointsOnSegment(w.start, w.end, w.id);
    w.start.x += dx; w.end.x += dx;
    conStart.forEach(p => p.x += dx);
    conEnd.forEach(p => p.x += dx);
    conSeg.forEach(p => p.x += dx);
    w.windows.forEach(win => win.center.x += dx);
    w.doors.forEach(door => door.center.x += dx);
    document.getElementById('insp-cx-val').textContent = val;
    syncStorage(); render();
  });

  document.getElementById('insp-cy').addEventListener('change', e => {
    pushHistory();
    const val = parseInt(e.target.value, 10);
    if (isNaN(val)) return;
    const oldCY = (w.start.y + w.end.y) / 2;
    const dy = val - oldCY;
    const conStart = getConnectedPoints(w.start.x, w.start.y, w.id);
    const conEnd = getConnectedPoints(w.end.x, w.end.y, w.id);
    const conSeg = getPointsOnSegment(w.start, w.end, w.id);
    w.start.y += dy; w.end.y += dy;
    conStart.forEach(p => p.y += dy);
    conEnd.forEach(p => p.y += dy);
    conSeg.forEach(p => p.y += dy);
    w.windows.forEach(win => win.center.y += dy);
    w.doors.forEach(door => door.center.y += dy);
    document.getElementById('insp-cy-val').textContent = val;
    syncStorage(); render();
  });

  document.getElementById('insp-len').addEventListener('change', e => {
    pushHistory();
    const newLen = parseInt(e.target.value, 10);
    if (isNaN(newLen) || newLen < 1) return;
    const dx = w.end.x - w.start.x;
    const dy = w.end.y - w.start.y;
    const curLen = Math.hypot(dx, dy);
    if (curLen < 0.1) return;
    const mcx = (w.start.x + w.end.x) / 2;
    const mcy = (w.start.y + w.end.y) / 2;
    const nx = dx / curLen;
    const ny = dy / curLen;

    const conStart = getConnectedPoints(w.start.x, w.start.y, w.id);
    const conEnd = getConnectedPoints(w.end.x, w.end.y, w.id);

    w.start.x = mcx - nx * (newLen / 2);
    w.start.y = mcy - ny * (newLen / 2);
    w.end.x = mcx + nx * (newLen / 2);
    w.end.y = mcy + ny * (newLen / 2);

    conStart.forEach(p => { p.x = w.start.x; p.y = w.start.y; });
    conEnd.forEach(p => { p.x = w.end.x; p.y = w.end.y; });

    const scale = newLen / curLen;
    w.windows.forEach(win => {
        win.center.x = mcx + (win.center.x - mcx) * scale;
        win.center.y = mcy + (win.center.y - mcy) * scale;
    });
    w.doors.forEach(door => {
        door.center.x = mcx + (door.center.x - mcx) * scale;
        door.center.y = mcy + (door.center.y - mcy) * scale;
    });
    document.getElementById('insp-len-val').textContent = newLen;
    syncStorage(); render();
  });

  const btnX = document.getElementById('btn-move-x');
  if (btnX) btnX.addEventListener('click', () => { state.moveAxis = state.moveAxis === 'x' ? null : 'x'; updateInspector(); render(); });
  const btnY = document.getElementById('btn-move-y');
  if (btnY) btnY.addEventListener('click', () => { state.moveAxis = state.moveAxis === 'y' ? null : 'y'; updateInspector(); render(); });

  const inp = document.getElementById('insp-thick');
  inp.addEventListener('input', e => {
    const val = parseInt(e.target.value, 10);
    document.getElementById('insp-thick-val').textContent = val;
    w.thickness = val;
    syncStorage();
    render();
  });
  inp.addEventListener('change', () => pushHistory());

} else if (r.kind === 'window' || r.kind === 'door') {
  const obj = r.obj;
  const cx = Math.round(obj.center.x);
  const cy = Math.round(obj.center.y);
  body.innerHTML = `
      <div class="insp-row">
        <label>Type <span class="val">${r.kind.toUpperCase()}</span></label>
      </div>
      <section class="insp-section"><div class="insp-section-title">Coordinates <span>px</span></div><div class="coordinate-grid">
        ${coordinateField('insp-center-x', 'Center X', obj.center.x)}
        ${coordinateField('insp-center-y', 'Center Y', obj.center.y)}
      </div></section>
      <div class="insp-row">
        <label>Opening width <span class="val"><span id="insp-width-val">${visibleWidth}</span> px</span></label>
        <input type="range" id="insp-width" min="10" max="250" value="${visibleWidth}">
      </div>`;
    bindCenterCoordinates(r);
    const inp = document.getElementById('insp-width');
    inp.addEventListener('input', e => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('insp-width-val').textContent = val;
      obj.opening_width = val;
      if (wallIsHorizontal(r.wall)) obj.width = val;
      else obj.height = val;
      syncStorage();
      render();
    });
    inp.addEventListener('change', () => commitFloorplanChange({ normalize: false }));

  } else if (r.kind === 'furniture') {
    const obj = r.obj;
    body.innerHTML = `
        <label>Center X <span class="val"><span id="insp-cx-val">${cx}</span> px</span></label>
        <input type="number" id="insp-cx" value="${cx}">
      </div>
      <div class="insp-row">
        <label>Center Y <span class="val"><span id="insp-cy-val">${cy}</span> px</span></label>
        <input type="number" id="insp-cy" value="${cy}">
      </div>
      <div class="insp-row">
        <label>Width <span class="val"><span id="insp-width-val">${obj.width}</span> px</span></label>
        <input type="range" id="insp-width" min="10" max="250" value="${obj.width}">
      </div>`;

  document.getElementById('insp-cx').addEventListener('change', e => {
    pushHistory();
    const val = parseInt(e.target.value, 10);
    if (isNaN(val)) return;
    obj.center.x = val;
    document.getElementById('insp-cx-val').textContent = val;
    syncStorage(); render();
  });

  document.getElementById('insp-cy').addEventListener('change', e => {
    pushHistory();
    const val = parseInt(e.target.value, 10);
    if (isNaN(val)) return;
    obj.center.y = val;
    document.getElementById('insp-cy-val').textContent = val;
    syncStorage(); render();
  });

  const inp = document.getElementById('insp-width');
  inp.addEventListener('input', e => {
    const val = parseInt(e.target.value, 10);
    document.getElementById('insp-width-val').textContent = val;
    obj.width = val;
    syncStorage();
    render();
  });
  inp.addEventListener('change', () => pushHistory());

} else if (r.kind === 'furniture') {
  const obj = r.obj;
  const cx = Math.round(obj.center.x);
  const cy = Math.round(obj.center.y);
  body.innerHTML = `
      <div class="insp-row">
        <label>Class <span class="val">${escapeInspectorText(obj.class)}</span></label>
      </div>
      <section class="insp-section"><div class="insp-section-title">Coordinates <span>px</span></div><div class="coordinate-grid">
        ${coordinateField('insp-center-x', 'Center X', obj.center.x)}
        ${coordinateField('insp-center-y', 'Center Y', obj.center.y)}
      </div></section>
      <div class="insp-row">
        <label>Center X <span class="val"><span id="insp-cx-val">${cx}</span> px</span></label>
        <input type="number" id="insp-cx" value="${cx}">
      </div>
      <div class="insp-row">
        <label>Center Y <span class="val"><span id="insp-cy-val">${cy}</span> px</span></label>
        <input type="number" id="insp-cy" value="${cy}">
      </div>
      <div class="insp-row">
        <label>Width <span class="val"><span id="insp-width-val">${obj.width}</span> px</span></label>
        <input type="range" id="insp-width" min="10" max="400" value="${obj.width}">
      </div>
      <div class="insp-row">
        <label>Height <span class="val"><span id="insp-height-val">${obj.height}</span> px</span></label>
        <input type="range" id="insp-height" min="10" max="400" value="${obj.height}">
      </div>`;
    bindCenterCoordinates(r);
    const wInp = document.getElementById('insp-width');
    wInp.addEventListener('input', e => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('insp-width-val').textContent = val;
      obj.width = val;
      syncStorage();
      render();
    });
    wInp.addEventListener('change', () => commitFloorplanChange({ normalize: false }));
    
    const hInp = document.getElementById('insp-height');
    hInp.addEventListener('input', e => {
      const val = parseInt(e.target.value, 10);
      document.getElementById('insp-height-val').textContent = val;
      obj.height = val;
      syncStorage();
      render();
    });
    hInp.addEventListener('change', () => commitFloorplanChange({ normalize: false }));
  }
}


  document.getElementById('insp-cx').addEventListener('change', e => {
    pushHistory();
    const val = parseInt(e.target.value, 10);
    if (isNaN(val)) return;
    obj.center.x = val;
    document.getElementById('insp-cx-val').textContent = val;
    syncStorage(); render();
  });

  document.getElementById('insp-cy').addEventListener('change', e => {
    pushHistory();
    const val = parseInt(e.target.value, 10);
    if (isNaN(val)) return;
    obj.center.y = val;
    document.getElementById('insp-cy-val').textContent = val;
    syncStorage(); render();
  });

  const wInp = document.getElementById('insp-width');
  wInp.addEventListener('input', e => {
    const val = parseInt(e.target.value, 10);
    document.getElementById('insp-width-val').textContent = val;
    obj.width = val;
    syncStorage();
    render();
  });
  wInp.addEventListener('change', () => pushHistory());

  const hInp = document.getElementById('insp-height');
  hInp.addEventListener('input', e => {
    const val = parseInt(e.target.value, 10);
    document.getElementById('insp-height-val').textContent = val;
    obj.height = val;
    syncStorage();
    render();
  });
  hInp.addEventListener('change', () => pushHistory());
}
}



function makeTrashBtn(onDelete) {
  const btn = document.createElement('span');
  btn.className = 'trash';
  btn.title = 'Löschen (Entf)';
  btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
    <polyline points="1,3 11,3"/><path d="M4,3V2h4v1"/><path d="M2,3l.8,7.5h6.4L10,3"/>
    <line x1="4.5" y1="5.5" x2="4.5" y2="8.5"/><line x1="7.5" y1="5.5" x2="7.5" y2="8.5"/>
  </svg>`;
  btn.addEventListener('click', e => { e.stopPropagation(); onDelete(); });
  return btn;
}

function buildHierarchy() {
  const container = document.getElementById('hierarchy');
  container.innerHTML = '';
  const count = document.getElementById('element-count');
  if (!state.data) { count.textContent = '0'; return; }
  const elementTotal = state.data.walls.reduce(
    (sum, wall) => sum + 1 + (wall.windows || []).length + (wall.doors || []).length,
    (state.data.furniture || []).length,
  );
  count.textContent = String(elementTotal);

  // Group walls as parent rows
  state.data.walls.forEach(wall => {
    const hasChildren = wall.windows.length + wall.doors.length > 0;
    const collapsed = !!state.collapsed[wall.id];
    const selWall = state.selected && state.selected.kind === 'wall' && state.selected.wallId === wall.id;

    // Wall row
    const row = document.createElement('div');
    row.className = 'hier-row' + (selWall ? ' selected' : '');

    // Toggle arrow
    const toggle = document.createElement('span');
    toggle.className = 'toggle' + (hasChildren ? '' : ' spacer');
    toggle.textContent = hasChildren ? (collapsed ? '▶' : '▼') : '▶';
    if (hasChildren) {
      toggle.addEventListener('click', ev => {
        ev.stopPropagation();
        state.collapsed[wall.id] = !state.collapsed[wall.id];
        buildHierarchy();
      });
    }

    const icon = document.createElement('span');
    icon.className = 'icon icon-wall';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = wall.id;

    row.append(toggle, icon, label);

    const trash = makeTrashBtn(() => {
      state.selected = { kind: 'wall', wallId: wall.id };
      deleteSelected();
    });
    row.append(trash);

    row.addEventListener('click', () => {
      state.selected = { kind: 'wall', wallId: wall.id };
      updateSidebar();
      updateInspector();
      render();
    });
    container.appendChild(row);

    // Children
    if (!collapsed) {
      wall.windows.forEach((win, i) => {
        const cs = state.selected && state.selected.kind === 'window' && state.selected.wallId === wall.id && state.selected.idx === i;
        addChildRow(container, wall, 'window', `win_${win.detection_id}`, i, cs);
      });
      wall.doors.forEach((door, i) => {
        const cs = state.selected && state.selected.kind === 'door' && state.selected.wallId === wall.id && state.selected.idx === i;
        addChildRow(container, wall, 'door', `door_${door.detection_id}`, i, cs);
      });
    }
  });

  // ── Furniture section ──────────────────────────────────────────────────────
  const furniture = state.data.furniture || [];
  if (furniture.length > 0) {
    const collapsed = !!state.collapsed['__furniture__'];
    const header = document.createElement('div');
    header.className = 'hier-row';
    header.style.marginTop = '4px';

    const toggle = document.createElement('span');
    toggle.className = 'toggle';
    toggle.textContent = collapsed ? '▶' : '▼';
    toggle.addEventListener('click', ev => {
      ev.stopPropagation();
      state.collapsed['__furniture__'] = !state.collapsed['__furniture__'];
      buildHierarchy();
    });

    const icon = document.createElement('span');
    icon.className = 'icon icon-furniture';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'Furniture';

    header.append(toggle, icon, label);
    container.appendChild(header);

    if (!collapsed) {
      furniture.forEach((item, i) => {
        const fsel = state.selected && state.selected.kind === 'furniture' && state.selected.idx === i;
        addFurnitureRow(container, item, i, fsel);
      });
    }
  }
}

function addFurnitureRow(container, item, idx, selected) {
  const row = document.createElement('div');
  row.className = 'hier-row child-row' + (selected ? ' selected' : '');

  const toggle = document.createElement('span');
  toggle.className = 'toggle spacer';
  toggle.textContent = '▶';

  const icon = document.createElement('span');
  icon.className = 'icon icon-furniture';

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = `${item.class}`;

  row.append(toggle, icon, label);

  const trash = makeTrashBtn(() => {
    state.selected = { kind: 'furniture', idx };
    deleteSelected();
  });
  row.append(trash);

  row.addEventListener('click', () => {
    state.selected = { kind: 'furniture', idx };
    updateSidebar();
    updateInspector();
    render();
  });
  container.appendChild(row);
}

function addChildRow(container, wall, kind, name, idx, selected) {
  const row = document.createElement('div');
  row.className = 'hier-row child-row' + (selected ? ' selected' : '');

  const toggle = document.createElement('span');
  toggle.className = 'toggle spacer';
  toggle.textContent = '▶';

  const icon = document.createElement('span');
  icon.className = `icon icon-${kind}`;

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = name;

  row.append(toggle, icon, label);

  const trash = makeTrashBtn(() => {
    state.selected = { kind, wallId: wall.id, idx };
    deleteSelected();
  });
  row.append(trash);

  row.addEventListener('click', () => {
    state.selected = { kind, wallId: wall.id, idx };
    updateSidebar();
    updateInspector();
    render();
  });
  container.appendChild(row);
}

// ─────────────────────────────────────────────
