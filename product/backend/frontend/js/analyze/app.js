// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────
let selectedFile = null;
document.body.classList.toggle('debug-mode', new URLSearchParams(location.search).get('debug') === '1');

// ─────────────────────────────────────────────
//  UI HELPERS
// ─────────────────────────────────────────────
function showState(id) {
  ['state-upload','state-loading','state-success','state-error']
    .forEach(s => document.getElementById(s).style.display = s === id ? '' : 'none');
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

function setFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > 20 * 1024 * 1024) {
    document.getElementById('error-msg').textContent = 'The image is larger than 20 MB.';
    showState('state-error');
    return;
  }
  selectedFile = file;

  // Thumbnail
  const url = URL.createObjectURL(file);
  document.getElementById('preview-img').src = url;
  document.getElementById('preview-name').textContent = file.name;
  document.getElementById('preview-size').textContent = formatBytes(file.size);
  previewStrip.style.display = 'flex';
  btnAnalyze.disabled = false;

  // Store image as base64 so revise.html can use it as a reference underlay
  const reader = new FileReader();
  reader.onload = ev => localStorage.setItem('floorplan_image', ev.target.result);
  reader.readAsDataURL(file);
}

function clearFile() {
  selectedFile = null;
  fileInput.value = '';
  previewStrip.style.display = 'none';
  btnAnalyze.disabled = true;
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
    form.append('auto_crop', 'true');
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

document.getElementById('btn-retry').addEventListener('click', () => showState('state-upload'));

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
      unet: 'unet_final_onlymax.pt',
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
          ? { yolo: filename, unet: 'unet_final_onlymax.pt' }
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

// Load model list on page load
loadModelList();
