import './view2d.css';
import './brand.js';
import './asset-viewer.css';
import { vec3 } from 'gl-matrix';
import { CrucibleRenderer, exportGlb, cameraView, fitOrthographicHeight } from './index.js';
import { loadGltf, parseGltf } from './gltf.js';
import { createMotionScene } from './motion.js';

const canvas = document.querySelector('#viewport');
const parameters = new URLSearchParams(location.search);
if (parameters.get('export') === '1') {
  document.body.classList.add('export-view');
  const width = Number(parameters.get('width'));
  const height = Number(parameters.get('height'));
  if (width > 0 && height > 0) {
    document.querySelector('.workspace').style.width = `${width}px`;
    document.querySelector('.workspace').style.height = `${height}px`;
  }
}
const state = { view: 'perspective', yaw: 0.65, pitch: 0.3, zoom: 1, time: 0, clip: 0, playing: false };
let asset;
let renderer;
let bounds;
let scheduledFrame = 0;
let lastTime = 0;
let pointer;
let loadingRequest = 0;

function notice(message, failed = false, waiting = false) {
  const element = document.querySelector('#notice');
  element.textContent = `${waiting ? '◷' : failed ? '⚠' : '✓'} ${message}`;
  element.hidden = false;
}

function measureBounds(parts) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const transformed = vec3.create();
  for (const part of parts) {
    for (let index = 0; index < part.geometry.positions.length; index += 3) {
      vec3.transformMat4(transformed, part.geometry.positions.subarray(index, index + 3), part.matrix);
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis], transformed[axis]);
        maximum[axis] = Math.max(maximum[axis], transformed[axis]);
      }
    }
  }
  return { minimum, maximum };
}

function duration() {
  return asset?.animations[state.clip]?.duration ?? 0;
}

function frame() {
  const aspect = canvas.width / canvas.height;
  const target = bounds.minimum.map((value, axis) => (value + bounds.maximum[axis]) / 2);
  const extent = Math.max(...bounds.maximum.map((value, axis) => value - bounds.minimum[axis]), 0.01);
  const view = cameraView(state.view, { target, distance: extent * 2.5 });
  const height = Math.max(extent * 0.01, fitOrthographicHeight(bounds, view, aspect, 1.25)) * state.zoom;
  view.orthographicHeight = height;
  view.near = Math.max(0.0001, extent / 1000);
  view.far = extent * 100;
  if (state.view === 'perspective') {
    const distance = height * 1.7;
    view.eye = [target[0] + Math.sin(state.yaw) * Math.cos(state.pitch) * distance, target[1] + Math.sin(state.pitch) * distance, target[2] + Math.cos(state.yaw) * Math.cos(state.pitch) * distance];
  }
  return { ...view, time: state.time, exposure: Number(document.querySelector('#exposure').value), effects: { bloom: { strength: Number(document.querySelector('#bloom').value), threshold: 0.8 } } };
}

function renderAt(time = state.time) {
  if (!renderer) return;
  state.time = Math.max(0, Math.min(duration(), time));
  if (asset.animations.length) renderer.updateParts(asset.applyAnimation(state.time, state.clip));
  renderer.render(frame());
  document.querySelector('#time').value = String(state.time);
  document.querySelector('#time-value').textContent = `${state.time.toFixed(2)} s`;
}

function tick(timestamp) {
  scheduledFrame = 0;
  if (document.hidden) return;
  if (state.playing && duration()) state.time = (state.time + Math.min((timestamp - lastTime) / 1000, 0.05)) % duration();
  lastTime = timestamp;
  try {
    renderAt();
  } catch (error) {
    pause();
    notice(error.message, true);
  }
  if (state.playing) invalidate();
}

function invalidate() {
  if (!scheduledFrame && renderer && !document.hidden) scheduledFrame = requestAnimationFrame(tick);
}

function pause() {
  state.playing = false;
  document.querySelector('#play').textContent = '▶ Play';
}

function syncAnimation() {
  document.querySelector('#time').max = String(duration() || 1);
  document.querySelector('#time').disabled = !duration();
  document.querySelector('#play').disabled = !duration();
}

function showAsset(loaded, title) {
  const nextBounds = measureBounds(loaded.parts);
  const center = nextBounds.minimum.map((value, axis) => (value + nextBounds.maximum[axis]) / 2);
  const extent = Math.max(...nextBounds.maximum.map((value, axis) => value - nextBounds.minimum[axis]), 0.01);
  renderer?.dispose();
  renderer = null;
  asset?.dispose();
  asset = null;
  let nextRenderer;
  try {
    nextRenderer = new CrucibleRenderer(canvas, loaded.parts, { ground: false, hdr: true, samples: Number(parameters.get('samples') ?? 4), pixelRatio: parameters.get('export') === '1' ? 1 : Math.min(devicePixelRatio, 1.5), memoryBudgetMiB: Number(parameters.get('memory') ?? 256), shadowBounds: { target: center, eye: [center[0] - extent, center[1] + extent * 2, center[2] + extent], extent: extent * 1.5, near: extent * 0.01, far: extent * 8 } });
  } catch (error) {
    loaded.dispose();
    throw error;
  }
  renderer = nextRenderer;
  asset = loaded;
  bounds = nextBounds;
  state.zoom = 1;
  state.time = 0;
  state.clip = 0;
  pause();
  const clip = document.querySelector('#clip');
  clip.replaceChildren();
  const names = asset.animations.length ? asset.animations.map((animation, index) => animation.name || `Clip ${index + 1}`) : ['No animation'];
  names.forEach((name, index) => clip.add(new Option(name, String(index))));
  clip.disabled = !asset.animations.length;
  syncAnimation();
  document.querySelector('#metrics').textContent = `${asset.parts.length.toLocaleString()} parts · ${renderer.batches.length} draws`;
  document.querySelector('#notice').hidden = true;
  document.title = `${title} · Crucible asset viewer`;
  invalidate();
}

async function openFile(file) {
  if (!file) return;
  const request = ++loadingRequest;
  pause();
  notice('Loading asset…', false, true);
  try {
    const loaded = await loadGltf(file, { maxBytes: 32 * 1024 * 1024, maxTexturePixels: 4 * 1024 * 1024 });
    if (request !== loadingRequest) {
      loaded.dispose();
      return;
    }
    showAsset(loaded, file.name);
  } catch (error) {
    if (request === loadingRequest) notice(error.message, true);
  }
}

document.querySelector('#open').addEventListener('click', () => document.querySelector('#file').click());
document.querySelector('#file').addEventListener('change', event => openFile(event.target.files[0]));
document.querySelector('#fit').addEventListener('click', () => { state.zoom = 1; invalidate(); });
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  state.view = button.dataset.view;
  document.querySelectorAll('[data-view]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  invalidate();
}));
for (const id of ['exposure', 'bloom']) document.querySelector(`#${id}`).addEventListener('input', invalidate);
document.querySelector('#clip').addEventListener('change', event => { state.clip = Number(event.target.value); state.time = 0; syncAnimation(); invalidate(); });
document.querySelector('#time').addEventListener('input', event => { pause(); state.time = Number(event.target.value); invalidate(); });
document.querySelector('#play').addEventListener('click', () => { state.playing = !state.playing; document.querySelector('#play').textContent = state.playing ? 'Ⅱ Pause' : '▶ Play'; lastTime = performance.now(); invalidate(); });
canvas.addEventListener('pointerdown', event => { pointer = { x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); });
canvas.addEventListener('pointermove', event => {
  if (!pointer || state.view !== 'perspective') return;
  state.yaw -= (event.clientX - pointer.x) * 0.008;
  state.pitch = Math.max(-1.4, Math.min(1.4, state.pitch + (event.clientY - pointer.y) * 0.008));
  pointer = { x: event.clientX, y: event.clientY };
  invalidate();
});
canvas.addEventListener('pointerup', () => { pointer = null; });
canvas.addEventListener('wheel', event => { event.preventDefault(); state.zoom = Math.max(0.1, Math.min(10, state.zoom * Math.exp(event.deltaY * 0.001))); invalidate(); }, { passive: false });
canvas.addEventListener('keydown', event => { if (event.key.toLowerCase() === 'f') { state.zoom = 1; invalidate(); } });
document.querySelector('.stage').addEventListener('dragover', event => event.preventDefault());
document.querySelector('.stage').addEventListener('drop', event => { event.preventDefault(); openFile(event.dataTransfer.files[0]); });
document.addEventListener('visibilitychange', () => { lastTime = performance.now(); if (!document.hidden) invalidate(); });
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  pause();
  renderer?.dispose();
  renderer = null;
  notice('Graphics context lost. Open the asset again after recovery.', true);
});
window.addEventListener('pagehide', () => {
  loadingRequest++;
  pause();
  if (scheduledFrame) cancelAnimationFrame(scheduledFrame);
  renderer?.dispose();
  renderer = null;
  asset?.dispose();
  asset = null;
});
new ResizeObserver(() => { if (renderer) { renderer.resize(); invalidate(); } }).observe(canvas);
document.querySelector('#save').addEventListener('click', async () => {
  if (!renderer) return notice('Open a valid GLB asset before saving an image', true);
  pause();
  renderAt();
  const blob = await new Promise(resolve => canvas.toBlob(resolve));
  if (!blob) return notice('Image capture failed', true);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'crucible-asset.png';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notice('Image saved');
});

window.__assetViewer = { state, openFile, showAsset, get renderer() { return renderer; }, get asset() { return asset; }, renderAt };
window.__scene = { get renderer() { return renderer; }, get duration() { return duration(); }, pause, renderAt };
const demo = createMotionScene();
demo.sample(3);
try { showAsset(await parseGltf(exportGlb(demo.parts)), 'Clockwork GLB study'); } catch (error) { notice(error.message, true); }
