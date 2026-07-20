//  HISTORY  (undo / redo, max 50 steps)
// ─────────────────────────────────────────────
const HISTORY_MAX = 50;
const appHistory = { stack: [], cursor: -1 };

function pushHistory() {
  // Discard any redo states ahead of cursor
  appHistory.stack = appHistory.stack.slice(0, appHistory.cursor + 1);
  const snapshot = JSON.stringify(state.data);
  if (appHistory.stack[appHistory.cursor] === snapshot) {
    updateHistoryButtons();
    return;
  }
  appHistory.stack.push(snapshot);
  if (appHistory.stack.length > HISTORY_MAX) appHistory.stack.shift();
  appHistory.cursor = appHistory.stack.length - 1;
  updateHistoryButtons();
}

function undo() {
  if (appHistory.cursor <= 0) return;
  appHistory.cursor--;
  state.data     = JSON.parse(appHistory.stack[appHistory.cursor]);
  state.selected = null;
  state.rooms = calculateRooms(state.data);
  syncStorage();
  updateHistoryButtons();
  updateSidebar();
  updateInspector();
  render();
}

function redo() {
  if (appHistory.cursor >= appHistory.stack.length - 1) return;
  appHistory.cursor++;
  state.data     = JSON.parse(appHistory.stack[appHistory.cursor]);
  state.selected = null;
  state.rooms = calculateRooms(state.data);
  syncStorage();
  updateHistoryButtons();
  updateSidebar();
  updateInspector();
  render();
}

function updateHistoryButtons() {
  document.getElementById('tb-undo').disabled = appHistory.cursor <= 0;
  document.getElementById('tb-redo').disabled = appHistory.cursor >= appHistory.stack.length - 1;
}

document.getElementById('tb-undo').addEventListener('click', undo);
document.getElementById('tb-redo').addEventListener('click', redo);

// Build flat object lookup: id → wall / child
function buildIndex() {
  const idx = {};
  state.data.walls.forEach(w => {
    idx[w.id] = { kind:'wall', wall: w };
    w.windows.forEach((win, i) => idx[`${w.id}_win_${i}`] = { kind:'window', wall: w, idx: i, obj: win });
    w.doors.forEach((d, i)     => idx[`${w.id}_door_${i}`] = { kind:'door',   wall: w, idx: i, obj: d });
  });
  return idx;
}

// ─────────────────────────────────────────────
