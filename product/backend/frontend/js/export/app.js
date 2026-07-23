import { downloadGlbModel } from './glb-export.js?v=20260723.1';
import { downloadIfcModel } from '../view3d/ifc-export.js?v=20260722.4';

const wallCount = document.getElementById('count-walls');
const objectCount = document.getElementById('count-objects');
const modelState = document.getElementById('model-state');
const downloadButton = document.getElementById('btn-download');
const selectedFormat = document.getElementById('selected-format');
const selectedCategory = document.getElementById('selected-category');
const navSource = document.getElementById('nav-source');

let currentData = null;
let toastTimer;

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
}

function parseFloorplan(value) {
  if (!value) return null;
  try {
    const data = JSON.parse(value);
    return data && Array.isArray(data.walls) ? data : null;
  } catch {
    return null;
  }
}

function countTrackedObjects(data) {
  if (!data) return 0;
  const openings = data.walls.reduce(
    (total, wall) => total + (wall.doors || []).length + (wall.windows || []).length,
    0,
  );
  return openings + (data.furniture || []).length;
}

function updateModelSummary() {
  currentData = parseFloorplan(localStorage.getItem('floorplan'));
  const source = localStorage.getItem('floorplan_source') || '';
  navSource.textContent = source;
  wallCount.textContent = String(currentData?.walls.length || 0);
  objectCount.textContent = String(countTrackedObjects(currentData));
  modelState.hidden = Boolean(currentData);
  downloadButton.disabled = !currentData?.walls.length;
}

function selectedOption() {
  return document.querySelector('input[name="export-format"]:checked');
}

function updateSelectedFormat() {
  const option = selectedOption();
  selectedFormat.textContent = option?.dataset.label || '';
  selectedCategory.textContent = option?.dataset.category || '';
}

function exportSettings(data) {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem('floorplan_3d_settings') || '{}');
  } catch {
    stored = {};
  }
  const calibratedScale = Number(data?.metadata?.measurement?.meters_per_pixel);
  return {
    scale: Number(stored.scale) > 0
      ? Number(stored.scale)
      : (Number.isFinite(calibratedScale) && calibratedScale > 0 ? calibratedScale : 0.02),
    wallHeight: Number(stored.wallH) > 0 ? Number(stored.wallH) : 2.8,
    doorHeight: Number(stored.doorH) > 0 ? Number(stored.doorH) : 2.1,
    windowSill: Number(stored.winSill) >= 0 ? Number(stored.winSill) : 0.9,
    windowHeight: Number(stored.winH) > 0 ? Number(stored.winH) : 1.3,
  };
}

function fileBaseName() {
  const source = (localStorage.getItem('floorplan_source') || 'floorplan').replace(/\.[^.]+$/, '');
  return source.replace(/[^a-z0-9_-]+/gi, '_') || 'floorplan';
}

document.querySelectorAll('input[name="export-format"]').forEach(input => {
  input.addEventListener('change', updateSelectedFormat);
});

downloadButton.addEventListener('click', async () => {
  const option = selectedOption();
  if (!currentData || !option) return;
  const originalLabel = downloadButton.textContent;
  downloadButton.disabled = true;
  downloadButton.textContent = 'Preparing…';
  try {
    const settings = exportSettings(currentData);
    const baseName = fileBaseName();
    if (option.value === 'glb') {
      await downloadGlbModel(currentData, { ...settings, fileName: `${baseName}.glb` });
    } else if (option.value === 'ifc') {
      downloadIfcModel(currentData, { ...settings, fileName: `${baseName}.ifc` });
    }
  } catch (error) {
    console.error('Export failed', error);
    showToast('Export failed.');
  } finally {
    downloadButton.textContent = originalLabel;
    downloadButton.disabled = !currentData?.walls.length;
  }
});

window.addEventListener('storage', event => {
  if (event.key === 'floorplan' || event.key === 'floorplan_source') updateModelSummary();
});

updateSelectedFormat();
updateModelSummary();
