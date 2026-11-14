import './view2d.css';
import './brand.js';
import { vec3 } from 'gl-matrix';
import { CrucibleRenderer } from './renderer.js';
import { createModel } from './model.js';
import { createCanvas2D } from './canvas2d.js';
import { cameraView, fitOrthographicHeight } from './camera.js';

const canvas = document.querySelector('#viewport');
const parameters = new URLSearchParams(location.search);
const exporting = parameters.get('export') === '1';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const poster = createCanvas2D();
const model = createModel();
const modelBounds = { minimum: [-1.241, 0.0515, -0.761], maximum: [1.241, 2.876, 0.934] };
const initialView = ['front', 'top', 'right', 'perspective'].includes(parameters.get('view')) ? parameters.get('view') : 'front';
const state = { scene: parameters.get('scene') === 'model' ? 'model' : 'poster', view: initialView, time: 0, playing: false, zoom: 1, pan: [0, 0], exporting };
let renderer;
let requestedFrame = 0;
let lastFrameTime = 0;
let dragging;

if (exporting) {
  document.body.classList.add('export-view');
  const width = Number(parameters.get('width'));
  const height = Number(parameters.get('height'));
  if (width > 0 && height > 0) {
    document.querySelector('.workspace').style.width = `${width}px`;
    document.querySelector('.workspace').style.height = `${height}px`;
  }
}

function notify(message, failure = false) {
  const notice = document.querySelector('#notice');
  notice.textContent = `${failure ? '⚠' : '✓'} ${message}`;
  notice.hidden = false;
}

function camera() {
  const aspect = Math.max(1, canvas.clientWidth) / Math.max(1, canvas.clientHeight);
  const target = state.scene === 'poster' ? [0, 0, 0] : [0, 1.46, 0];
  const view = cameraView(state.scene === 'poster' ? 'front' : state.view, { target, distance: 7.8 });
  const bounds = state.scene === 'poster' ? poster.bounds : modelBounds;
  const fitted = fitOrthographicHeight(bounds, view, aspect, state.scene === 'poster' ? 1.14 : 1.2);
  view.orthographicHeight = fitted * state.zoom;
  const forward = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), view.target, view.eye));
  const right = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), forward, view.up));
  const shift = vec3.scale(vec3.create(), right, state.pan[0]);
  vec3.scaleAndAdd(shift, shift, view.up, state.pan[1]);
  view.target = view.target.map((value, axis) => value + shift[axis]);
  view.eye = view.eye.map((value, axis) => value + shift[axis]);
  if (view.projection === 'perspective') {
    const distance = Math.max(5, fitted * 1.55) * state.zoom;
    const direction = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), view.eye, view.target));
    view.eye = Array.from(vec3.scaleAndAdd(vec3.create(), view.target, direction, distance));
  }
  return { ...view, armorColor: [0.73, 0.43, 0.065], armorSurface: [0.62, 0.43], exposure: 1, time: state.time, assemblyAmount: 0 };
}

function renderAt(time) {
  if (!renderer || !Number.isFinite(time)) return;
  state.time = Math.max(0, Math.min(poster.duration, time));
  if (state.scene === 'poster') {
    const changed = poster.animate(state.time);
    renderer.updateParts(changed, { shadows: false });
  }
  renderer.render(camera());
  document.querySelector('#time').value = String(state.time);
  document.querySelector('#time-value').textContent = `${state.time.toFixed(2)} / ${poster.duration.toFixed(2)} s`;
}

function tick(time) {
  requestedFrame = 0;
  if (document.hidden) return;
  if (state.playing) {
    state.time = (state.time + Math.min((time - lastFrameTime) / 1000, 0.05)) % poster.duration;
  }
  lastFrameTime = time;
  renderAt(state.time);
  if (state.playing) invalidate();
}

function invalidate() {
  if (!requestedFrame && renderer && !document.hidden) requestedFrame = requestAnimationFrame(tick);
}

function setPlaying(playing) {
  state.playing = playing;
  lastFrameTime = performance.now();
  const button = document.querySelector('#play');
  button.textContent = playing ? 'Ⅱ Pause' : '▶ Play';
  button.setAttribute('aria-label', playing ? 'Pause timeline' : 'Play timeline');
  invalidate();
}

function initialize() {
  setPlaying(false);
  renderer?.dispose();
  const parts = state.scene === 'poster' ? poster.parts : model;
  renderer = new CrucibleRenderer(canvas, parts, { ground: false, samples: Number(parameters.get('samples') ?? 4), pixelRatio: exporting ? 1 : 1.25, memoryBudgetMiB: Number(parameters.get('memory') ?? 192) });
  document.querySelector('#scene').value = state.scene;
  document.querySelector('#view-controls').hidden = state.scene === 'poster';
  document.querySelectorAll('[data-view]').forEach(control => control.setAttribute('aria-pressed', String(control.dataset.view === state.view)));
  document.querySelector('#scene-title').textContent = state.scene === 'poster' ? 'Orbital field' : 'WALL·E study';
  document.querySelector('#view-title').textContent = state.scene === 'poster' ? 'Flat vector geometry · orthographic' : `${state.view[0].toUpperCase()}${state.view.slice(1)} · ${state.view === 'perspective' ? 'perspective' : 'orthographic'}`;
  document.querySelector('#metrics').textContent = `${parts.length} parts · ${renderer.batches.length} draws`;
  document.querySelector('#time').disabled = state.scene === 'model';
  document.querySelector('#play').disabled = state.scene === 'model';
  canvas.setAttribute('aria-label', `${state.scene === 'poster' ? 'Vector poster' : 'WALL-E camera view'}. Drag to pan, scroll to zoom. Arrow keys pan, plus and minus zoom.`);
  invalidate();
}

document.querySelector('#scene').addEventListener('change', event => {
  state.scene = event.target.value;
  state.pan = [0, 0];
  state.zoom = 1;
  initialize();
});
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  state.view = button.dataset.view;
  state.pan = [0, 0];
  state.zoom = 1;
  document.querySelectorAll('[data-view]').forEach(control => control.setAttribute('aria-pressed', String(control === button)));
  document.querySelector('#view-title').textContent = `${button.textContent} · ${state.view === 'perspective' ? 'perspective' : 'orthographic'}`;
  invalidate();
}));
document.querySelector('#time').addEventListener('input', event => {
  setPlaying(false);
  renderAt(Number(event.target.value));
});
document.querySelector('#play').addEventListener('click', () => setPlaying(!state.playing));
document.querySelector('#fit').addEventListener('click', () => {
  state.zoom = 1;
  state.pan = [0, 0];
  invalidate();
});

canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  dragging = { id: event.pointerId, x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => {
  if (!dragging || dragging.id !== event.pointerId) return;
  const scale = camera().orthographicHeight / canvas.clientHeight;
  state.pan[0] -= (event.clientX - dragging.x) * scale;
  state.pan[1] += (event.clientY - dragging.y) * scale;
  dragging.x = event.clientX;
  dragging.y = event.clientY;
  invalidate();
});
for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(eventName, () => { dragging = null; });
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  state.zoom = Math.max(0.25, Math.min(4, state.zoom * Math.exp(event.deltaY * 0.001)));
  invalidate();
}, { passive: false });
canvas.addEventListener('keydown', event => {
  const movement = { ArrowLeft: [-0.15, 0], ArrowRight: [0.15, 0], ArrowUp: [0, 0.15], ArrowDown: [0, -0.15] }[event.key];
  if (movement) {
    event.preventDefault();
    state.pan = state.pan.map((value, axis) => value + movement[axis] * state.zoom);
    invalidate();
  }
  if (event.key === '+' || event.key === '=' || event.key === '-') {
    event.preventDefault();
    state.zoom = Math.max(0.25, Math.min(4, state.zoom * (event.key === '-' ? 1.1 : 0.9)));
    invalidate();
  }
  if (event.key.toLowerCase() === 'f') document.querySelector('#fit').click();
});

document.querySelector('#download').addEventListener('click', () => {
  renderAt(state.time);
  canvas.toBlob(blob => {
    if (!blob) return notify('PNG could not be created', true);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `crucible-${state.scene}-${state.view}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('PNG saved');
  }, 'image/png');
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (requestedFrame) cancelAnimationFrame(requestedFrame);
    requestedFrame = 0;
    setPlaying(false);
  } else invalidate();
});
reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) setPlaying(false); });
window.addEventListener('pagehide', () => {
  if (requestedFrame) cancelAnimationFrame(requestedFrame);
  renderer?.dispose();
});
new ResizeObserver(() => {
  renderer?.resize();
  invalidate();
}).observe(canvas);

window.__scene = { get renderer() { return renderer; }, renderAt, duration: poster.duration };
window.__views = { state, poster, model, camera, renderAt, get renderer() { return renderer; } };
try { initialize(); } catch (error) { notify(error.message, true); }
