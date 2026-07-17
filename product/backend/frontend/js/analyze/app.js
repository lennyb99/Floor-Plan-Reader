// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────
let selectedFile = null;

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

// ─────────────────────────────────────────────
//  FILE SELECTION
// ─────────────────────────────────────────────
const fileInput   = document.getElementById('file-input');
const dropZone    = document.getElementById('drop-zone');
const previewStrip = document.getElementById('preview-strip');
const btnAnalyze  = document.getElementById('btn-analyze');

function setFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
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

  const apiUrl = document.getElementById('api-url').value.trim();
  showState('state-loading');

  try {
    const form = new FormData();
    form.append('file', selectedFile);

    const res = await fetch(apiUrl, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Server responded ${res.status}`);

    const data = await res.json();

    // Hand off to revise.html via localStorage
    localStorage.setItem('floorplan', JSON.stringify(data));
    localStorage.setItem('floorplan_source', selectedFile.name);

    // /analyze always returns { walls: [...] } — the merged result
    let summary = 'Analysis complete.';
    if (data.walls) {
      const wins  = data.walls.reduce((a, w) => a + w.windows.length, 0);
      const doors = data.walls.reduce((a, w) => a + w.doors.length, 0);
      summary = `${data.walls.length} walls · ${wins} windows · ${doors} doors detected.`;
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

async function openCamera() {
  camError.style.display = 'none';
  preview.style.display  = 'none';
  video.style.display    = 'block';
  btnCapture.style.display = '';
  btnRetake.style.display  = 'none';
  btnUse.style.display     = 'none';
  modal.classList.add('open');

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 } },
      audio: false,
    });
    video.srcObject = cameraStream;
  } catch (err) {
    camError.textContent = `Camera unavailable: ${err.message}`;
    camError.style.display = 'block';
    btnCapture.style.display = 'none';
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
  preview.style.display = 'block';
  video.style.display   = 'none';
  btnCapture.style.display = 'none';
  btnRetake.style.display  = '';
  btnUse.style.display     = '';
}

function retake() {
  preview.style.display    = 'none';
  video.style.display      = 'block';
  btnCapture.style.display = '';
  btnRetake.style.display  = 'none';
  btnUse.style.display     = 'none';
}

function usePhoto() {
  canvas.toBlob(blob => {
    const file = new File([blob], 'camera-capture.jpg', { type: 'image/jpeg' });
    setFile(file);   // reuse existing setFile — shows preview strip, enables Analyze
    closeCamera();
  }, 'image/jpeg', 0.92);
}

document.getElementById('btn-camera').addEventListener('click',  openCamera);
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
  const base = new URL(document.getElementById('api-url').value).origin;
  try {
    const res  = await fetch(`${base}/models`);
    const data = await res.json();

    const populate = (sel, files) => {
      sel.innerHTML = '';
      files.forEach(f => {
        const opt = document.createElement('option');
        opt.value = opt.textContent = f;
        sel.appendChild(opt);
      });
      sel.disabled = files.length === 0;
    };

    populate(selYolo, data.yolo_models);
    populate(selUnet, data.unet_models);

    if (data.active_yolo) selYolo.value = data.active_yolo;
    if (data.active_unet) selUnet.value = data.active_unet;

    setModelStatus(
      `Active: YOLO=${data.active_yolo ?? '—'}  UNet=${data.active_unet ?? '—'}`,
      'ok'
    );
  } catch {
    setModelStatus('Could not reach server to load model list.', 'err');
  }
}

async function swapModel(type, filename) {
  const base = new URL(document.getElementById('api-url').value).origin;
  setModelStatus('Loading model…');
  try {
    const res  = await fetch(`${base}/active-models`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ [type]: filename }),
    });
    if (!res.ok) {
      const err = await res.json();
      setModelStatus(err.detail || 'Swap failed.', 'err');
      return;
    }
    const data = await res.json();
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

// Load model list on page load
loadModelList();
