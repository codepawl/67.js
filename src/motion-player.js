import './motion-style.css';
import './brand.js';
import { CrucibleRenderer } from './renderer.js';
import { createMotionScene, MOTION_DURATION } from './motion.js';
import { EFFECT_PRESETS } from './effects.js';

const query = new URLSearchParams(location.search);
const exporting = query.get('export') === '1';
const canvas = document.querySelector('#motion-canvas');
const stage = document.querySelector('.motion-stage');
const slider = document.querySelector('#motion-time');
const playButton = document.querySelector('#motion-play');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const scene = createMotionScene();
const state = { time: 0, playing: false, aspect: ['landscape', 'portrait', 'square'].includes(query.get('aspect')) ? query.get('aspect') : 'landscape' };
let renderer;
let scheduledFrame = 0;
let playbackOrigin = 0;

function option(name, fallback, minimum, maximum) {
  const raw = query.get(name);
  const value = raw === null ? fallback : Number(raw);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

if (exporting) {
  document.body.classList.add('export-mode');
  stage.style.width = `${option('width', 1280, 64, 4096)}px`;
  stage.style.height = `${option('height', 720, 64, 4096)}px`;
}
stage.dataset.aspect = state.aspect;
document.querySelector('#motion-aspect').value = state.aspect;

function showError(error) {
  setPlaying(false);
  const notice = document.querySelector('#motion-error');
  notice.textContent = `⚠ Animation could not render: ${error.message}. Reload the page to retry.`;
  notice.hidden = false;
  window.__motionError = error.message;
}

function renderAt(time) {
  const frame = scene.sample(time, state.aspect);
  renderer.updateParts(scene.parts, { shadows: true });
  const look = document.querySelector('#motion-look').value;
  renderer.render({ ...frame.camera, time: frame.time, exposure: frame.exposure, effects: look === 'cinematic' ? frame.effects : EFFECT_PRESETS[look] });
  state.time = frame.time;
  slider.value = String(state.time);
  slider.setAttribute('aria-valuetext', `${state.time.toFixed(1)} of ${MOTION_DURATION} seconds`);
  document.querySelector('#motion-clock').value = `${state.time.toFixed(1)} / ${MOTION_DURATION.toFixed(1)} s`;
  document.querySelector('#motion-shot').textContent = `Shot ${frame.shot + 1} of 3`;
  document.querySelector('#motion-stat').textContent = `${Math.round(renderer.triangles / 1000)}k triangles · ${renderer.batches.length} draws · ${Math.round(renderer.memoryPlan.estimatedBytes / 1048576)} MB estimated`;
  return frame;
}

function setPlaying(playing) {
  state.playing = playing && !document.hidden;
  cancelAnimationFrame(scheduledFrame);
  scheduledFrame = 0;
  playButton.textContent = state.playing ? 'Ⅱ Pause' : state.time >= MOTION_DURATION ? '▶ Play again' : '▶ Play';
  playButton.setAttribute('aria-label', state.playing ? 'Pause animation' : 'Play animation');
  if (state.playing) {
    if (state.time >= MOTION_DURATION) renderAt(0);
    playbackOrigin = performance.now() - state.time * 1000;
    scheduledFrame = requestAnimationFrame(advance);
  }
}

function advance(timestamp) {
  scheduledFrame = 0;
  if (!state.playing || document.hidden) return;
  try {
    renderAt((timestamp - playbackOrigin) / 1000);
    if (state.time >= MOTION_DURATION) setPlaying(false);
    else scheduledFrame = requestAnimationFrame(advance);
  } catch (error) { showError(error); }
}

function initializeRenderer() {
  renderer = new CrucibleRenderer(canvas, scene.parts, {
    ground: false, hdr: true, pixelRatio: exporting ? 1 : 1.25,
    samples: option('samples', 4, 1, 8), memoryBudgetMiB: option('memory', 256, 32, 1024),
  });
  renderAt(state.time);
}

playButton.addEventListener('click', () => { if (renderer) setPlaying(!state.playing); });
document.querySelector('#motion-look').addEventListener('change', () => { if (renderer) renderAt(state.time); });
document.querySelector('#motion-save').addEventListener('click', () => {
  if (!renderer) return;
  setPlaying(false);
  renderAt(state.time);
  canvas.toBlob(blob => {
    if (!blob) { showError(new Error('Image capture failed')); return; }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'crucible-clockwork.png'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
});
document.querySelector('#motion-replay').addEventListener('click', () => {
  if (!renderer) return;
  setPlaying(false);
  renderAt(0);
  if (!reducedMotion.matches) setPlaying(true);
});
slider.addEventListener('input', () => {
  if (!renderer) return;
  setPlaying(false);
  renderAt(Number(slider.value));
});
document.querySelector('#motion-aspect').addEventListener('change', event => {
  state.aspect = event.target.value;
  stage.dataset.aspect = state.aspect;
  if (renderer) {
    renderer.resize();
    renderAt(state.time);
  }
});
canvas.addEventListener('keydown', event => {
  if (!renderer) return;
  if (event.code === 'Space') {
    event.preventDefault();
    setPlaying(!state.playing);
  } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    setPlaying(false);
    const time = event.key === 'Home' ? 0 : event.key === 'End' ? MOTION_DURATION : state.time + (event.key === 'ArrowRight' ? 0.25 : -0.25);
    renderAt(time);
  }
});
const resizeObserver = new ResizeObserver(() => {
  if (!renderer) return;
  renderer.resize();
  renderAt(state.time);
});
resizeObserver.observe(canvas);
document.addEventListener('visibilitychange', () => { if (document.hidden) setPlaying(false); });
reducedMotion.addEventListener('change', event => { if (event.matches) setPlaying(false); });
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  setPlaying(false);
  renderer?.dispose();
  renderer = null;
});
canvas.addEventListener('webglcontextrestored', () => {
  try { initializeRenderer(); } catch (error) { showError(error); }
});
window.addEventListener('pagehide', () => {
  setPlaying(false);
  resizeObserver.disconnect();
  renderer?.dispose();
  renderer = null;
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  try { initializeRenderer(); resizeObserver.observe(canvas); } catch (error) { showError(error); }
});
window.__scene = {
  get renderer() { return renderer; },
  duration: MOTION_DURATION,
  parts: scene.parts,
  state,
  renderAt: time => { setPlaying(false); return renderAt(time); },
  pause: () => setPlaying(false),
};
window.__motion = { scene, state, get renderer() { return renderer; }, renderAt };
try {
  initializeRenderer();
  if (!exporting && !reducedMotion.matches) setPlaying(true);
} catch (error) { showError(error); }
