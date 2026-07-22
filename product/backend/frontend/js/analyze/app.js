// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────
let selectedFile = null;
let selectedFileUrl = null;
let previewController = null;
let previewTimer = null;
let previewBusy = false;
let autoRecommendationPending = false;
let previewRefreshQueued = false;
let modelBusy = false;
let gammaTouched = false;
let manualModelOverride = false;
let modelsReady = false;
let pendingResolvedMode = null;
let lastAppliedPipeline = null;
let manualCrop = null;
let manualCropDrag = null;
let pipelineChoiceTouched = false;
let recommendedPipelineMode = null;
const pipelineProfiles = {};
document.body.classList.toggle('debug-mode', new URLSearchParams(location.search).get('debug') === '1');

// ─────────────────────────────────────────────
//  UI HELPERS
// ─────────────────────────────────────────────
function showState(id) {
  ['state-upload','state-prepare','state-loading','state-success','state-error']
    .forEach(s => {
      const element = document.getElementById(s);
      const active = s === id;
      element.hidden = !active;
      // Several states have a stylesheet default of display:none. An empty
      // inline value does not override that rule, so make the active state
      // explicit instead of relying on cascade order.
      element.style.display = active ? 'block' : 'none';
    });
  const preparationActive = id !== 'state-upload' && !!selectedFile;
  document.body.classList.toggle('prepare-mode', id === 'state-prepare');
  document.getElementById('nav-upload-step').classList.toggle('active', !preparationActive);
  document.getElementById('nav-prepare-step').classList.toggle('active', preparationActive);
  if (id === 'state-prepare') window.PrepareWorkflow?.resize();
}

function formatBytes(b) {
  return b > 1e6 ? (b/1e6).toFixed(1)+' MB' : (b/1024).toFixed(0)+' KB';
}

function resolvedApiUrl() {
  return new URL(document.getElementById('api-url').value.trim(), window.location.href);
}

function selectedPipelineMode() {
  return document.querySelector('input[name="pipeline-mode"]:checked')?.value || 'auto';
}

function setRecommendedPipeline(mode) {
  recommendedPipelineMode = mode;
  document.querySelectorAll('[data-pipeline-card]').forEach(card => {
    const recommended = card.dataset.pipelineCard === mode;
    card.classList.toggle('is-recommended', recommended);
    card.querySelector('.recommendation-badge').hidden = !recommended;
  });
}

function resetPlanTypeChoice() {
  pipelineChoiceTouched = false;
  recommendedPipelineMode = null;
  pendingResolvedMode = null;
  lastAppliedPipeline = null;
  manualModelOverride = false;
  document.querySelectorAll('input[name="pipeline-mode"]').forEach(input => {
    input.checked = false;
  });
  setRecommendedPipeline(null);
}

function refreshAnalyzeEnabled() {
  btnAnalyze.disabled = previewBusy || modelBusy || !selectedFile;
}

// ─────────────────────────────────────────────
//  FILE SELECTION
// ─────────────────────────────────────────────
const fileInput   = document.getElementById('file-input');
const dropZone    = document.getElementById('drop-zone');
const previewStrip = document.getElementById('preview-strip');
const btnAnalyze  = document.getElementById('btn-analyze');
const btnPrepare  = document.getElementById('btn-prepare');
const prepareOriginal = document.getElementById('prepare-original');
const originalPreviewFrame = document.getElementById('original-preview-frame');
const manualCropLayer = document.getElementById('manual-crop-layer');
const manualCropBox = document.getElementById('manual-crop-box');
const manualCropControls = document.getElementById('manual-crop-controls');
const MANUAL_CROP_MAX_SPAN = 1.25;

function resetManualCrop() {
  if (!prepareOriginal.naturalWidth || !prepareOriginal.naturalHeight) return;
  const size = Math.max(prepareOriginal.naturalWidth, prepareOriginal.naturalHeight);
  manualCrop = {
    left: (prepareOriginal.naturalWidth - size) / 2,
    top: (prepareOriginal.naturalHeight - size) / 2,
    size,
  };
  updateManualCropUI();
}

function clampManualCrop(crop) {
  if (!prepareOriginal.naturalWidth || !prepareOriginal.naturalHeight) return crop;
  return clampManualCropGeometry(
    crop,
    prepareOriginal.naturalWidth,
    prepareOriginal.naturalHeight,
    MANUAL_CROP_MAX_SPAN,
  );
}

function renderedOriginalImageRect() {
  const width = originalPreviewFrame.clientWidth;
  const height = originalPreviewFrame.clientHeight;
  if (!prepareOriginal.naturalWidth || !prepareOriginal.naturalHeight || !width || !height) return null;
  const manualMode = !document.getElementById('auto-crop-input').checked;
  const displayScale = manualMode ? 1 / MANUAL_CROP_MAX_SPAN : 1;
  const scale = Math.min(width / prepareOriginal.naturalWidth, height / prepareOriginal.naturalHeight)
    * displayScale;
  const renderedWidth = prepareOriginal.naturalWidth * scale;
  const renderedHeight = prepareOriginal.naturalHeight * scale;
  return {
    left: (width - renderedWidth) / 2,
    top: (height - renderedHeight) / 2,
    width: renderedWidth,
    height: renderedHeight,
    scale,
  };
}

function updateManualCropUI() {
  const enabled = !document.getElementById('auto-crop-input').checked;
  originalPreviewFrame.classList.toggle('manual-crop-active', enabled);
  manualCropLayer.hidden = !enabled;
  manualCropControls.hidden = !enabled;
  if (!enabled) return;
  if (!manualCrop) resetManualCrop();
  const imageRect = renderedOriginalImageRect();
  if (!manualCrop || !imageRect) return;
  manualCrop = clampManualCrop(manualCrop);
  manualCropBox.style.left = `${imageRect.left + manualCrop.left * imageRect.scale}px`;
  manualCropBox.style.top = `${imageRect.top + manualCrop.top * imageRect.scale}px`;
  manualCropBox.style.width = `${manualCrop.size * imageRect.scale}px`;
  manualCropBox.style.height = `${manualCrop.size * imageRect.scale}px`;
}

function appendManualCrop(form) {
  if (document.getElementById('auto-crop-input').checked || !manualCrop) return;
  const crop = clampManualCrop(manualCrop);
  form.append('manual_crop_left', crop.left.toFixed(3));
  form.append('manual_crop_top', crop.top.toFixed(3));
  form.append('manual_crop_size', crop.size.toFixed(3));
}

prepareOriginal.addEventListener('load', () => {
  resetManualCrop();
  updateManualCropUI();
});
new ResizeObserver(updateManualCropUI).observe(originalPreviewFrame);

manualCropBox.addEventListener('pointerdown', event => {
  if (!manualCrop) return;
  event.preventDefault();
  manualCropBox.setPointerCapture(event.pointerId);
  manualCropDrag = {
    pointerId: event.pointerId,
    mode: event.target.dataset.cropHandle || 'move',
    startX: event.clientX,
    startY: event.clientY,
    original: { ...manualCrop },
  };
});

manualCropBox.addEventListener('pointermove', event => {
  if (!manualCropDrag || manualCropDrag.pointerId !== event.pointerId) return;
  const imageRect = renderedOriginalImageRect();
  if (!imageRect) return;
  const dx = (event.clientX - manualCropDrag.startX) / imageRect.scale;
  const dy = (event.clientY - manualCropDrag.startY) / imageRect.scale;
  const original = manualCropDrag.original;
  if (manualCropDrag.mode === 'move') {
    manualCrop = clampManualCrop({ ...original, left: original.left + dx, top: original.top + dy });
  } else {
    const handle = manualCropDrag.mode;
    const signedX = handle.includes('e') ? dx : -dx;
    const signedY = handle.includes('s') ? dy : -dy;
    const delta = Math.abs(signedX) > Math.abs(signedY) ? signedX : signedY;
    const nextSize = Math.max(32, original.size + delta);
    const next = {
      size: nextSize,
      left: handle.includes('w') ? original.left + original.size - nextSize : original.left,
      top: handle.includes('n') ? original.top + original.size - nextSize : original.top,
    };
    manualCrop = clampManualCrop(next);
  }
  updateManualCropUI();
});

function finishManualCrop(event) {
  if (!manualCropDrag || manualCropDrag.pointerId !== event.pointerId) return;
  manualCropDrag = null;
  schedulePreparationPreview();
}
manualCropBox.addEventListener('pointerup', finishManualCrop);
manualCropBox.addEventListener('pointercancel', finishManualCrop);

document.getElementById('btn-reset-crop').addEventListener('click', () => {
  resetManualCrop();
  schedulePreparationPreview();
});

function setFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > 20 * 1024 * 1024) {
    document.getElementById('error-msg').textContent = 'The image is larger than 20 MB.';
    showState('state-error');
    return;
  }
  resetPlanTypeChoice();
  selectedFile = file;

  // Thumbnail
  if (selectedFileUrl) URL.revokeObjectURL(selectedFileUrl);
  selectedFileUrl = URL.createObjectURL(file);
  document.getElementById('preview-img').src = selectedFileUrl;
  document.getElementById('prepare-original').src = selectedFileUrl;
  document.getElementById('preview-name').textContent = file.name;
  document.getElementById('preview-size').textContent = formatBytes(file.size);
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
  document.getElementById('contrast-preview').removeAttribute('src');
  localStorage.removeItem('floorplan_image');
  manualCrop = null;
  document.getElementById('auto-crop-input').checked = true;
  resetPlanTypeChoice();
  updateManualCropUI();
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
  previewBusy = loading;
  document.getElementById('prepare-loading').classList.toggle('hidden', !loading);
  const status = document.getElementById('prepare-status');
  status.textContent = message;
  status.classList.toggle('is-error', Boolean(message));
  refreshAnalyzeEnabled();
}

function renderPreparationMetadata(meta) {
  const pipeline = meta.pipeline;
  if (!pipeline) return;
  pendingResolvedMode = pipeline.resolved_mode;
  const requestedAuto = pipeline.requested_mode === 'auto';
  if (requestedAuto) {
    setRecommendedPipeline(pipeline.resolved_mode);
    if (!pipelineChoiceTouched) {
      const recommendedInput = document.querySelector(
        `input[name="pipeline-mode"][value="${pipeline.resolved_mode}"]`,
      );
      if (recommendedInput) recommendedInput.checked = true;
    }
  }
  if (!gammaTouched) {
    document.getElementById('gamma-input').value = Number(meta.gamma).toFixed(2);
    document.getElementById('gamma-value').value = Number(meta.gamma).toFixed(2);
  }
  applyPipelineModels(pipeline.resolved_mode);
}

async function refreshPreparationPreview() {
  if (!selectedFile) return;
  if (previewController) previewController.abort();
  previewController = new AbortController();
  setPreparationLoading(true);

  const form = new FormData();
  const requestedMode = selectedPipelineMode();
  const isRecommendationRequest = requestedMode === 'auto' && !recommendedPipelineMode;
  if (isRecommendationRequest) autoRecommendationPending = true;
  form.append('file', selectedFile);
  if (gammaTouched) form.append('gamma', document.getElementById('gamma-input').value);
  form.append('auto_crop', String(document.getElementById('auto-crop-input').checked));
  form.append('pipeline_mode', requestedMode);
  appendManualCrop(form);

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
    const previewSource = `data:image/png;base64,${data.preview_image_base64}`;
    document.getElementById('prepare-result').src = previewSource;
    document.getElementById('contrast-preview').src = previewSource;
    renderPreparationMetadata(data.metadata);
    setPreparationLoading(false);
  } catch (error) {
    if (error.name === 'AbortError') return;
    setPreparationLoading(false, error.message);
    btnAnalyze.disabled = true;
  } finally {
    if (isRecommendationRequest) {
      autoRecommendationPending = false;
      const shouldRefresh = previewRefreshQueued && document.body.classList.contains('prepare-mode');
      previewRefreshQueued = false;
      if (shouldRefresh) {
        schedulePreparationPreview();
      }
    }
  }
}

function schedulePreparationPreview() {
  clearTimeout(previewTimer);
  if (autoRecommendationPending) {
    previewRefreshQueued = true;
    return;
  }
  setPreparationLoading(true);
  previewTimer = setTimeout(refreshPreparationPreview, 220);
}

function openPreparation() {
  if (!selectedFile) return;
  showState('state-prepare');
  window.PrepareWorkflow?.start();
  location.hash = 'prepare';
  refreshPreparationPreview();
}

function backToUpload() {
  if (previewController) previewController.abort();
  previewRefreshQueued = false;
  history.replaceState(null, '', location.pathname + location.search);
  showState('state-upload');
}

btnPrepare.addEventListener('click', openPreparation);
document.getElementById('btn-back-upload').addEventListener('click', backToUpload);
document.getElementById('btn-back-upload-bottom').addEventListener('click', backToUpload);
document.getElementById('btn-reset-preprocess').addEventListener('click', () => {
  gammaTouched = false;
  const mode = selectedPipelineMode();
  const gamma = pipelineProfiles[mode]?.default_gamma ?? 1.25;
  document.getElementById('gamma-input').value = Number(gamma).toFixed(2);
  document.getElementById('gamma-value').value = Number(gamma).toFixed(2);
  schedulePreparationPreview();
});

document.querySelectorAll('input[name="pipeline-mode"]').forEach(input => {
  input.addEventListener('change', () => {
    pipelineChoiceTouched = true;
    gammaTouched = false;
    manualModelOverride = false;
    lastAppliedPipeline = null;
    pendingResolvedMode = input.value;
    const gamma = pipelineProfiles[input.value]?.default_gamma ?? 1.25;
    document.getElementById('gamma-input').value = Number(gamma).toFixed(2);
    document.getElementById('gamma-value').value = Number(gamma).toFixed(2);
    schedulePreparationPreview();
  });
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
    if (gammaTouched) form.append('gamma', document.getElementById('gamma-input').value);
    form.append('auto_crop', String(document.getElementById('auto-crop-input').checked));
    form.append('detection_confidence', document.getElementById('confidence-input').value);
    form.append('pipeline_mode', selectedPipelineMode());
    appendManualCrop(form);

    const resolvedLabel = pipelineProfiles[pendingResolvedMode]?.label || 'selected';
    document.getElementById('loading-detail').textContent = `Running the ${resolvedLabel} pipeline with the active U-Net and YOLO weights…`;

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
      const pipeline = data.metadata?.pipeline?.label ?? 'Pipeline';
      summary = `${pipeline} · ${data.walls.length} walls · ${wins} windows · ${doors} doors · 512 × 512 px · γ ${gamma}`;
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
const activeModels = { yolo: null, unet: null };

function setModelStatus(msg, type = '') {
  modelStatus.textContent = msg;
  modelStatus.className   = type;
}

function setModelBusy(busy) {
  modelBusy = busy;
  selYolo.disabled = busy || selYolo.options.length === 0;
  selUnet.disabled = busy || selUnet.options.length === 0;
  selYolo.setAttribute('aria-busy', String(busy));
  selUnet.setAttribute('aria-busy', String(busy));
  refreshAnalyzeEnabled();
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
    (data.pipeline_profiles || []).forEach(profile => { pipelineProfiles[profile.id] = profile; });

    activeModels.yolo = data.active_yolo;
    activeModels.unet = data.active_unet;
    selYolo.value = data.active_yolo;
    selUnet.value = data.active_unet;
    setModelBusy(false);
    selYolo.title = 'Select the YOLO weights used by the next analysis.';
    selUnet.title = 'Select the U-Net weights used by the next analysis.';
    modelsReady = true;

    setModelStatus(
      `Ready on ${data.device ?? 'CPU'} · selected weights control the next analysis`,
      'ok'
    );
    if (pendingResolvedMode) applyPipelineModels(pendingResolvedMode);
  } catch {
    setModelStatus('Could not reach server to load model list.', 'err');
  }
}

async function activateModels(payload, { manual = false, pipelineId = null } = {}) {
  const base = resolvedApiUrl().origin;
  setModelBusy(true);
  setModelStatus(manual ? 'Loading manual model override…' : 'Loading pipeline-recommended weights…');
  try {
    const res  = await fetch(`${base}/active-models`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Swap failed.');
    }
    const data = await res.json();
    activeModels.yolo = data.active_yolo;
    activeModels.unet = data.active_unet;
    selYolo.value = data.active_yolo;
    selUnet.value = data.active_unet;
    if (manual) {
      manualModelOverride = true;
    } else if (pipelineId) {
      lastAppliedPipeline = pipelineId;
    }
    const prefix = manual ? 'Manual override' : `${pipelineProfiles[pipelineId]?.label || 'Pipeline'} preset`;
    setModelStatus(`${prefix}: YOLO=${data.active_yolo ?? '—'}  UNet=${data.active_unet ?? '—'}`, 'ok');
  } catch (error) {
    selYolo.value = activeModels.yolo;
    selUnet.value = activeModels.unet;
    setModelStatus(error.message || 'Server unreachable.', 'err');
  } finally {
    setModelBusy(false);
  }
}

function applyPipelineModels(pipelineId) {
  pendingResolvedMode = pipelineId;
  if (!modelsReady || manualModelOverride || lastAppliedPipeline === pipelineId) return;
  const profile = pipelineProfiles[pipelineId];
  if (!profile) return;
  const payload = {
    yolo: profile.recommended_yolo,
    unet: profile.recommended_unet,
  };
  if (activeModels.yolo === payload.yolo && activeModels.unet === payload.unet) {
    lastAppliedPipeline = pipelineId;
    setModelStatus(`${profile.label} preset active`, 'ok');
    return;
  }
  activateModels(payload, { pipelineId });
}

selYolo.addEventListener('change', () => activateModels({ yolo: selYolo.value }, { manual: true }));
selUnet.addEventListener('change', () => activateModels({ unet: selUnet.value }, { manual: true }));

function bindRangeValue(inputId, outputId) {
  const input = document.getElementById(inputId);
  const output = document.getElementById(outputId);
  input.addEventListener('input', () => { output.value = Number(input.value).toFixed(2); });
}

bindRangeValue('gamma-input', 'gamma-value');
bindRangeValue('confidence-input', 'confidence-value');
document.getElementById('gamma-input').addEventListener('input', () => {
  gammaTouched = true;
  schedulePreparationPreview();
});
document.getElementById('auto-crop-input').addEventListener('change', () => {
  if (!manualCrop) resetManualCrop();
  updateManualCropUI();
  schedulePreparationPreview();
});

// Load model list on page load
loadModelList();
