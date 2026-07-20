//  SIDEBAR: HIERARCHY + COORDS
// ─────────────────────────────────────────────
function updateSidebar() {
  updateCoordsStrip();
  buildHierarchy();
  updateSelectionHint();
}

function updateInspector() {
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
  
  if (insp.getAttribute('data-insp-id') === targetId) {
    if (r.kind === 'wall') {
      const len = Math.hypot(r.obj.end.x - r.obj.start.x, r.obj.end.y - r.obj.start.y).toFixed(1);
      document.getElementById('insp-len-val').textContent = len;
      if (document.activeElement !== document.getElementById('insp-thick')) {
        document.getElementById('insp-thick').value = r.obj.thickness;
        document.getElementById('insp-thick-val').textContent = r.obj.thickness;
      }
    } else if (r.kind === 'window' || r.kind === 'door') {
      if (document.activeElement !== document.getElementById('insp-width')) {
        document.getElementById('insp-width').value = r.obj.width;
        document.getElementById('insp-width-val').textContent = r.obj.width;
      }
    } else if (r.kind === 'furniture') {
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
    body.innerHTML = `
      <div class="insp-row">
        <label>ID <span class="val">${w.id}</span></label>
      </div>
      <div class="insp-row">
        <label>Length <span class="val"><span id="insp-len-val">${len}</span> px</span></label>
      </div>
      <div class="insp-note">Drag this segment in the canvas or use the arrow keys. Doors and windows move with their wall.</div>
      <div class="insp-row">
        <label>Thickness <span class="val"><span id="insp-thick-val">${w.thickness}</span> px</span></label>
        <input type="range" id="insp-thick" min="4" max="80" value="${w.thickness}">
      </div>`;
      
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
    body.innerHTML = `
      <div class="insp-row">
        <label>Type <span class="val">${r.kind.toUpperCase()}</span></label>
      </div>
      <div class="insp-row">
        <label>Width <span class="val"><span id="insp-width-val">${obj.width}</span> px</span></label>
        <input type="range" id="insp-width" min="10" max="250" value="${obj.width}">
      </div>`;
      
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
    body.innerHTML = `
      <div class="insp-row">
        <label>Class <span class="val">${obj.class}</span></label>
      </div>
      <div class="insp-row">
        <label>Width <span class="val"><span id="insp-width-val">${obj.width}</span> px</span></label>
        <input type="range" id="insp-width" min="10" max="400" value="${obj.width}">
      </div>
      <div class="insp-row">
        <label>Height <span class="val"><span id="insp-height-val">${obj.height}</span> px</span></label>
        <input type="range" id="insp-height" min="10" max="400" value="${obj.height}">
      </div>`;
      
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

function updateCoordsStrip() {
  const c    = getCenter();
  const inpX = document.getElementById('inp-x');
  const inpY = document.getElementById('inp-y');
  if (c) {
    inpX.disabled = false; inpX.value = c.x;
    inpY.disabled = false; inpY.value = c.y;
  } else {
    inpX.disabled = true; inpX.value = '';
    inpY.disabled = true; inpY.value = '';
  }
}

document.getElementById('inp-x').addEventListener('change', e => {
  const r = getSelectedObject();
  if (!r) return;
  const val = parseInt(e.target.value, 10);
  if (isNaN(val)) return;
  if (r.kind === 'wall') {
    const d = val - Math.round((r.obj.start.x + r.obj.end.x) / 2);
    moveWallBy(r.obj, d, 0);
  } else { r.obj.center.x = val; }
  syncStorage();
  pushHistory();
  updateInspector();
  render();
});

document.getElementById('inp-y').addEventListener('change', e => {
  const r = getSelectedObject();
  if (!r) return;
  const val = parseInt(e.target.value, 10);
  if (isNaN(val)) return;
  if (r.kind === 'wall') {
    const d = val - Math.round((r.obj.start.y + r.obj.end.y) / 2);
    moveWallBy(r.obj, 0, d);
  } else { r.obj.center.y = val; }
  syncStorage();
  pushHistory();
  updateInspector();
  render();
});

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
    const collapsed   = !!state.collapsed[wall.id];
    const selWall     = state.selected && state.selected.kind === 'wall' && state.selected.wallId === wall.id;

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

    const icon  = document.createElement('span');
    icon.className = 'icon icon-wall';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = wall.id;

    row.append(toggle, icon, label);

    const trash = makeTrashBtn(() => {
      state.selected = { kind:'wall', wallId: wall.id };
      deleteSelected();
    });
    row.append(trash);

    row.addEventListener('click', () => {
      state.selected = { kind:'wall', wallId: wall.id };
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
    const collapsed    = !!state.collapsed['__furniture__'];
    const header       = document.createElement('div');
    header.className   = 'hier-row';
    header.style.marginTop = '4px';

    const toggle = document.createElement('span');
    toggle.className   = 'toggle';
    toggle.textContent = collapsed ? '▶' : '▼';
    toggle.addEventListener('click', ev => {
      ev.stopPropagation();
      state.collapsed['__furniture__'] = !state.collapsed['__furniture__'];
      buildHierarchy();
    });

    const icon  = document.createElement('span');
    icon.className = 'icon icon-furniture';

    const label = document.createElement('span');
    label.className   = 'label';
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
  label.className   = 'label';
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
