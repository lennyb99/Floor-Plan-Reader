// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────
let selectedFile = null;
let selectedFileUrl = null;
let previewController = null;
let previewTimer = null;
document.body.classList.toggle('debug-mode', new URLSearchParams(location.search).get('debug') === '1');

// ─────────────────────────────────────────────
//  UI HELPERS
// ─────────────────────────────────────────────
function showState(id) {
  ['state-upload','state-prepare','state-loading','state-success','state-error']
    .forEach(s => document.getElementById(s).style.display = s === id ? '' : 'none');
  const preparationActive = id !== 'state-upload' && !!selectedFile;
  document.body.classList.toggle('prepare-mode', id === 'state-prepare');
  document.getElementById('nav-upload-step').classList.toggle('active', !preparationActive);
  document.getElementById('nav-prepare-step').classList.toggle('active', preparationActive);
}

function formatBytes(b) {
  return b > 1e6 ? (b/1e6).toFixed(1)+' MB' : (b/1024).toFixed(0)+' KB';
}

function resolvedApiUrl() {
  return new URL(document.getElementById('api-url').value.trim(), window.location.href);
}

// ─────────────────────────────────────────────
//  FILE SELECTION
// ─────────────────────────────────────────────
const fileInput   = document.getElementById('file-input');
const dropZone    = document.getElementById('drop-zone');
const previewStrip = document.getElementById('preview-strip');
const btnAnalyze  = document.getElementById('btn-analyze');
const btnPrepare  = document.getElementById('btn-prepare');

function setFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > 20 * 1024 * 1024) {
    document.getElementById('error-msg').textContent = 'The image is larger than 20 MB.';
    showState('state-error');
    return;
  }
  selectedFile = file;

  // Thumbnail
  if (selectedFileUrl) URL.revokeObjectURL(selectedFileUrl);
  selectedFileUrl = URL.createObjectURL(file);
  document.getElementById('preview-img').src = selectedFileUrl;
  document.getElementById('prepare-original').src = selectedFileUrl;
  document.getElementById('preview-name').textContent = file.name;
  document.getElementById('preview-size').textContent = formatBytes(file.size);
  document.getElementById('nav-source').textContent = file.name;
  previewStrip.style.display = 'flex';
  btnPrepare.disabled = false;

  // Store image as base64 so revise.html can use it as a reference underlay
  const reader = new FileReader();
  reader.onload = ev => {
    try { localStorage.setItem('floorplan_image', ev.target.result); }
    catch { /* Large photos may exceed localStorage; the prepared PNG replaces it later. */ }
  };
  reader.readAsDataURL(file);
}

function clearFile() {
  selectedFile = null;
  fileInput.value = '';
  previewStrip.style.display = 'none';
  btnPrepare.disabled = true;
  btnAnalyze.disabled = true;
  if (selectedFileUrl) URL.revokeObjectURL(selectedFileUrl);
  selectedFileUrl = null;
  document.getElementById('prepare-original').removeAttribute('src');
  document.getElementById('prepare-result').removeAttribute('src');
  localStorage.removeItem('floorplan_image');
}

fileInput.addEventListener('change', e => setFile(e.target.files[0]));

document.getElementById('btn-clear').addEventListener('click', clearFile);

// Drag-and-drop
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  setFile(e.dataTransfer.files[0]);
});

function preparationEndpoint() {
  return new URL('/preprocess', resolvedApiUrl().origin).href;
}

function setPreparationLoading(loading, message = '') {
  document.getElementById('prepare-loading').classList.toggle('hidden', !loading);
  if (message) {
    const error = document.createElement('span');
    error.className = 'prep-error';
    error.textContent = message;
    document.getElementById('prep-meta').replaceChildren(error);
  }
  btnAnalyze.disabled = loading || !selectedFile;
}

function renderPreparationMetadata(meta) {
  const crop = meta.auto_crop ? 'Smart crop' : 'Centered square';
  const cleanup = meta.cleanup_applied ? 'Paper cleanup on' : 'Clean source retained';
  document.getElementById('prep-meta').innerHTML = `
    <span>${meta.original_width} × ${meta.original_height} source</span>
    <span>${crop}</span>
    <span>${cleanup}</span>
    <span>γ ${Number(meta.gamma).toFixed(2)}</span>`;
}

async function refreshPreparationPreview() {
  if (!selectedFile) return;
  if (previewController) previewController.abort();
  previewController = new AbortController();
  setPreparationLoading(true);

  const form = new FormData();
  form.append('file', selectedFile);
  form.append('gamma', document.getElementById('gamma-input').value);
  form.append('auto_crop', String(document.getElementById('auto-crop-input').checked));

  try {
    const response = await fetch(preparationEndpoint(), {
      method: 'POST',
      body: form,
      signal: previewController.signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `Preview failed (${response.status})`);
    }
    const data = await response.json();
    document.getElementById('prepare-result').src = `data:image/png;base64,${data.preview_image_base64}`;
    renderPreparationMetadata(data.metadata);
    setPreparationLoading(false);
  } catch (error) {
    if (error.name === 'AbortError') return;
    setPreparationLoading(false, error.message);
    btnAnalyze.disabled = true;
  }
}

function schedulePreparationPreview() {
  clearTimeout(previewTimer);
  setPreparationLoading(true);
  previewTimer = setTimeout(refreshPreparationPreview, 220);
}

function openPreparation() {
  if (!selectedFile) return;
  showState('state-prepare');
  location.hash = 'prepare';
  refreshPreparationPreview();
}

function backToUpload() {
  if (previewController) previewController.abort();
  history.replaceState(null, '', location.pathname + location.search);
  showState('state-upload');
}

btnPrepare.addEventListener('click', openPreparation);
document.getElementById('btn-back-upload').addEventListener('click', backToUpload);
document.getElementById('btn-back-upload-bottom').addEventListener('click', backToUpload);
document.getElementById('btn-reset-preprocess').addEventListener('click', () => {
  document.getElementById('gamma-input').value = '1.25';
  document.getElementById('gamma-value').value = '1.25';
  document.getElementById('auto-crop-input').checked = true;
  schedulePreparationPreview();
});

// ─────────────────────────────────────────────
//  ANALYZE
// ─────────────────────────────────────────────
document.getElementById('btn-analyze').addEventListener('click', async () => {
  if (!selectedFile) return;

  const apiUrl = resolvedApiUrl().href;
  showState('state-loading');

  try {
    const form = new FormData();
    form.append('file', selectedFile);
    form.append('gamma', document.getElementById('gamma-input').value);
    form.append('auto_crop', String(document.getElementById('auto-crop-input').checked));
    form.append('detection_confidence', document.getElementById('confidence-input').value);

    const res = await fetch(apiUrl, { method: 'POST', body: form });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.detail || `Server responded ${res.status}`);
    }

    const responseData = await res.json();
    const data = { ...responseData };
    delete data.preview_image_base64;

    // Hand off to revise.html via localStorage
    localStorage.setItem('floorplan', JSON.stringify(data));
    localStorage.setItem('floorplan_source', selectedFile.name);
    if (responseData.preview_image_base64) {
      localStorage.setItem('floorplan_image', `data:image/png;base64,${responseData.preview_image_base64}`);
    }

    // /analyze always returns { walls: [...] } — the merged result
    let summary = 'Analysis complete.';
    if (data.walls) {
      const wins  = data.walls.reduce((a, w) => a + w.windows.length, 0);
      const doors = data.walls.reduce((a, w) => a + w.doors.length, 0);
      const gamma = data.metadata?.preprocessing?.gamma ?? '—';
      summary = `${data.walls.length} walls · ${wins} windows · ${doors} doors · 512 × 512 px · γ ${gamma}`;
    }
    document.getElementById('success-summary').textContent = summary;
    showState('state-success');

    // Fade out with transition overlay, then navigate
    setTimeout(() => {
      document.getElementById('page-transition').classList.add('visible');
      setTimeout(() => { window.location.href = 'revise.html'; }, 400);
    }, 900);

  } catch (err) {
    document.getElementById('error-msg').textContent = err.message;
    showState('state-error');
  }
});

document.getElementById('btn-retry').addEventListener('click', () => {
  showState(selectedFile ? 'state-prepare' : 'state-upload');
});

// ─────────────────────────────────────────────
//  CAMERA
// ─────────────────────────────────────────────
const modal        = document.getElementById('camera-modal');
const video        = document.getElementById('camera-video');
const canvas       = document.getElementById('camera-canvas');
const preview      = document.getElementById('camera-preview');
const camError     = document.getElementById('cam-error');
const btnCapture   = document.getElementById('btn-cam-capture');
const btnRetake    = document.getElementById('btn-cam-retake');
const btnUse       = document.getElementById('btn-cam-use');
let   cameraStream = null;

function setHidden(element, hidden) {
  element.classList.toggle('is-hidden', hidden);
}

async function openCamera() {
  camError.classList.remove('is-visible');
  preview.classList.remove('is-visible');
  setHidden(video, false);
  setHidden(btnCapture, false);
  setHidden(btnRetake, true);
  setHidden(btnUse, true);
  modal.classList.add('open');

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 } },
      audio: false,
    });
    video.srcObject = cameraStream;
  } catch (err) {
    camError.textContent = `Camera unavailable: ${err.message}`;
    camError.classList.add('is-visible');
    setHidden(btnCapture, true);
  }
}

function closeCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  video.srcObject = null;
  modal.classList.remove('open');
}

function captureFrame() {
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  // Show preview, hide live feed
  preview.src    = canvas.toDataURL('image/jpeg', 0.92);
  preview.classList.add('is-visible');
  setHidden(video, true);
  setHidden(btnCapture, true);
  setHidden(btnRetake, false);
  setHidden(btnUse, false);
}

function retake() {
  preview.classList.remove('is-visible');
  setHidden(video, false);
  setHidden(btnCapture, false);
  setHidden(btnRetake, true);
  setHidden(btnUse, true);
}

function usePhoto() {
  canvas.toBlob(blob => {
    const file = new File([blob], 'camera-capture.jpg', { type: 'image/jpeg' });
    setFile(file);   // reuse existing setFile — shows preview strip, enables Analyze
    closeCamera();
  }, 'image/jpeg', 0.92);
}

document.getElementById('btn-camera').addEventListener('click', e => {
  e.stopPropagation();
  openCamera();
});
document.getElementById('btn-cam-close').addEventListener('click',   closeCamera);
document.getElementById('btn-cam-capture').addEventListener('click', captureFrame);
document.getElementById('btn-cam-retake').addEventListener('click',  retake);
document.getElementById('btn-cam-use').addEventListener('click',     usePhoto);

// ─────────────────────────────────────────────
//  MODEL SELECTOR
// ─────────────────────────────────────────────
const selYolo    = document.getElementById('sel-yolo');
const selUnet    = document.getElementById('sel-unet');
const modelStatus = document.getElementById('model-status');

function setModelStatus(msg, type = '') {
  modelStatus.textContent = msg;
  modelStatus.className   = type;
}

async function loadModelList() {
  const base = resolvedApiUrl().origin;
  try {
    const res  = await fetch(`${base}/models`);
    const data = await res.json();

    const populate = (sel, files, profiles = []) => {
      sel.innerHTML = '';
      files.forEach(f => {
        const opt = document.createElement('option');
        const profile = profiles.find(item => item.file === f);
        opt.value = f;
        opt.textContent = profile?.label || f;
        sel.appendChild(opt);
      });
      sel.disabled = files.length === 0;
    };

    populate(selYolo, data.yolo_models, data.yolo_profiles);
    populate(selUnet, data.unet_models, data.unet_profiles);

    const productionPair = data.production_pair || {
      yolo: 'yolo_real1.pt',
      unet: 'unet_real_finetuned_v1.pt',
    };

    // Analyze is the production path. Debug pages retain unrestricted weight
    // switching, while this screen starts from the calibrated compatible pair.
    if (data.active_yolo !== productionPair.yolo || data.active_unet !== productionPair.unet) {
      const pairRes = await fetch(`${base}/active-models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(productionPair),
      });
      if (!pairRes.ok) throw new Error('Could not activate production weights.');
    }
    selYolo.value = productionPair.yolo;
    selUnet.value = productionPair.unet;
    selYolo.disabled = true;
    selUnet.disabled = true;
    selYolo.title = 'Production preset is fixed here; use YOLO Debug to compare weights.';
    selUnet.title = 'Production preset is fixed here; use UNet Debug to compare weights.';

    setModelStatus(
      `Ready on ${data.device ?? 'CPU'} · production ensemble active`,
      'ok'
    );
  } catch {
    setModelStatus('Could not reach server to load model list.', 'err');
  }
}

async function swapModel(type, filename) {
  const base = resolvedApiUrl().origin;
  setModelStatus('Loading model…');
  try {
    const res  = await fetch(`${base}/active-models`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        type === 'yolo' && filename === 'yolo_real1.pt'
          ? { yolo: filename, unet: 'unet_real_finetuned_v1.pt' }
          : { [type]: filename }
      ),
    });
    if (!res.ok) {
      const err = await res.json();
      setModelStatus(err.detail || 'Swap failed.', 'err');
      return;
    }
    const data = await res.json();
    selYolo.value = data.active_yolo;
    selUnet.value = data.active_unet;
    setModelStatus(
      `Active: YOLO=${data.active_yolo ?? '—'}  UNet=${data.active_unet ?? '—'}`,
      'ok'
    );
  } catch {
    setModelStatus('Server unreachable.', 'err');
  }
}

selYolo.addEventListener('change', () => swapModel('yolo', selYolo.value));
selUnet.addEventListener('change', () => swapModel('unet', selUnet.value));

function bindRangeValue(inputId, outputId) {
  const input = document.getElementById(inputId);
  const output = document.getElementById(outputId);
  input.addEventListener('input', () => { output.value = Number(input.value).toFixed(2); });
}

bindRangeValue('gamma-input', 'gamma-value');
bindRangeValue('confidence-input', 'confidence-value');
document.getElementById('gamma-input').addEventListener('input', schedulePreparationPreview);
document.getElementById('auto-crop-input').addEventListener('change', schedulePreparationPreview);

// Load model list on page load
loadModelList();
