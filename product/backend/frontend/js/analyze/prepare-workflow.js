(function () {
  'use strict';

  const body = document.body;
  const modeButtons = Array.from(document.querySelectorAll('[data-view-mode]'));
  const progressButtons = Array.from(document.querySelectorAll('[data-workflow-goto]'));
  const steps = Array.from(document.querySelectorAll('[data-prepare-step]'));
  const stage = document.querySelector('.prepare-stage');
  const track = document.querySelector('.prepare-track');
  const previousButton = document.getElementById('btn-workflow-previous');
  const nextButton = document.getElementById('btn-workflow-next');
  const backButton = document.getElementById('btn-back-upload-bottom');
  const analyzeButton = document.getElementById('btn-analyze');

  let mode = 'easy';
  let currentStep = 0;
  let started = false;
  let resizeFrame = null;

  function isCompact() {
    return mode === 'compact';
  }

  function resizeStage() {
    if (!stage || !steps.length) return;
    if (isCompact()) {
      stage.style.height = 'auto';
      return;
    }
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      stage.style.height = `${steps[currentStep].scrollHeight}px`;
    });
  }

  function syncStepVisibility() {
    steps.forEach((step, index) => {
      const active = index === currentStep;
      step.toggleAttribute('inert', !isCompact() && !active);
      step.setAttribute('aria-hidden', String(!isCompact() && !active));
    });
  }

  function syncProgress() {
    progressButtons.forEach((button, index) => {
      const active = index === currentStep;
      button.toggleAttribute('aria-current', active);
      if (active) button.setAttribute('aria-current', 'step');
      button.classList.toggle('is-complete', index < currentStep);
    });
  }

  function syncActions() {
    if (isCompact()) {
      backButton.hidden = false;
      previousButton.hidden = true;
      nextButton.hidden = true;
      nextButton.style.display = 'none';
      analyzeButton.style.display = 'inline-flex';
      return;
    }

    const first = currentStep === 0;
    const last = currentStep === steps.length - 1;
    backButton.hidden = !first;
    previousButton.hidden = first;
    nextButton.hidden = last;
    nextButton.style.display = last ? 'none' : 'inline-flex';
    analyzeButton.style.display = last ? 'inline-flex' : 'none';
  }

  function syncTrack() {
    track.style.transform = isCompact() ? 'none' : `translateX(-${currentStep * 100}%)`;
  }

  function emitChange() {
    document.dispatchEvent(new CustomEvent('prepareworkflowchange', {
      detail: { mode, currentStep, started },
    }));
  }

  function setStep(nextStep, { focus = false } = {}) {
    currentStep = Math.max(0, Math.min(steps.length - 1, Number(nextStep) || 0));
    syncTrack();
    syncStepVisibility();
    syncProgress();
    syncActions();
    resizeStage();
    if (focus && !isCompact()) {
      const heading = steps[currentStep].querySelector('h2');
      heading?.setAttribute('tabindex', '-1');
      requestAnimationFrame(() => heading?.focus({ preventScroll: true }));
    }
    emitChange();
  }

  function setMode(nextMode) {
    if (started || !['easy', 'compact'].includes(nextMode)) return;
    mode = nextMode;
    body.classList.toggle('view-easy', !isCompact());
    body.classList.toggle('view-compact', isCompact());
    modeButtons.forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.viewMode === mode));
    });
    setStep(currentStep);
  }

  function start() {
    started = true;
    body.classList.add('process-started');
    setStep(0);
  }

  modeButtons.forEach(button => {
    button.addEventListener('click', () => setMode(button.dataset.viewMode));
  });

  progressButtons.forEach(button => {
    button.addEventListener('click', () => setStep(button.dataset.workflowGoto, { focus: true }));
  });

  previousButton.addEventListener('click', () => setStep(currentStep - 1, { focus: true }));
  nextButton.addEventListener('click', () => setStep(currentStep + 1, { focus: true }));
  window.addEventListener('resize', resizeStage);

  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(resizeStage);
    steps.forEach(step => observer.observe(step));
  }

  window.PrepareWorkflow = {
    start,
    resize: resizeStage,
    setStep,
    getMode: () => mode,
  };

  setMode('easy');
}());
