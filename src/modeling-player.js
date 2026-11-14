import './modeling-style.css';
import './brand.js';
import './site-theme.css';
import { CrucibleRenderer } from './renderer.js';
import { createLanternScene } from './modeling-scene.js';
import { mountButton } from './site-controls.js';

const canvas = document.querySelector('#modeling-canvas');
const notice = document.querySelector('#modeling-notice');
const query = new URLSearchParams(location.search);
const exporting = query.get('export') === '1';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
function brushedMaps() {
  const normal = document.createElement('canvas');
  const packed = document.createElement('canvas');
  normal.width = normal.height = packed.width = packed.height = 256;
  const normalContext = normal.getContext('2d');
  const packedContext = packed.getContext('2d');
  const normals = normalContext.createImageData(256, 256);
  const surfaces = packedContext.createImageData(256, 256);
  for (let row = 0; row < 256; row++) {
    for (let column = 0; column < 256; column++) {
      const offset = (row * 256 + column) * 4;
      const brushed = Math.sin(row * 3.7 + Math.sin(column * 0.3) * 0.15);
      normals.data.set([128, Math.round(128 + brushed * 4), 255, 255], offset);
      surfaces.data.set([255, Math.round(218 + brushed * 15), 255, 255], offset);
    }
  }
  normalContext.putImageData(normals, 0, 0);
  packedContext.putImageData(surfaces, 0, 0);
  return { normalMap: { image: normal, colorSpace: 'linear' }, metallicRoughnessMap: { image: packed, colorSpace: 'linear' }, normalScale: [0.5, 0.5] };
}
const scene = createLanternScene({ textures: { brass: brushedMaps() } });
const state = { time: 0, playing: !exporting && !reducedMotion.matches, yaw: Math.atan2(4.2, 5.2), pitch: 0.23, distance: 6.87 };
let scheduled = 0;
let lastTime = performance.now();
let pointer;
let renderer;
let failed = false;
document.body.classList.toggle('modeling-export', exporting);
function boundedOption(name, fallback, minimum, maximum) {
  const value = Number(query.get(name) ?? fallback);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}
if (exporting) {
  const stage = document.querySelector('.modeling-stage');
  stage.style.width = `${boundedOption('width', 1280, 64, 4096)}px`;
  stage.style.height = `${boundedOption('height', 720, 64, 4096)}px`;
}
function fail(error) {
  failed = true;
  state.playing = false;
  play.update({ label: 'Animate', 'aria-pressed': false, disabled: true });
  notice.hidden = false;
  notice.querySelector('span').textContent = `The scene could not render: ${error.message}. Reload the page to retry.`;
  window.__modelingError = error.message;
}
function renderAt(time) {
  const frame = scene.sample(time, canvas.clientWidth / canvas.clientHeight);
  if (!exporting) {
    const distance = state.distance * (canvas.clientWidth < canvas.clientHeight ? 1.15 : 1);
    frame.eye = [Math.sin(state.yaw) * Math.cos(state.pitch) * distance, 1.35 + Math.sin(state.pitch) * distance, Math.cos(state.yaw) * Math.cos(state.pitch) * distance];
  }
  renderer.updateParts(scene.parts);
  renderer.render(frame);
  return frame;
}
function tick(now) {
  scheduled = 0;
  if (document.hidden) return;
  if (state.playing) state.time += Math.min(0.1, Math.max(0, (now - lastTime) / 1000));
  lastTime = now;
  try { renderAt(state.time); } catch (error) { fail(error); }
  if (state.playing) invalidate();
}
function invalidate() {
  if (!failed && !scheduled && !document.hidden) scheduled = requestAnimationFrame(tick);
}
function setPlaying(value) {
  state.playing = value;
  lastTime = performance.now();
  play.update({ label: value ? 'Pause' : 'Animate', 'aria-pressed': value });
  invalidate();
}
const play = mountButton(document.querySelector('#modeling-play'), { label: state.playing ? 'Pause' : 'Animate', 'aria-pressed': state.playing, onClick: () => setPlaying(!state.playing) });
mountButton(document.querySelector('#modeling-reset'), { onClick: () => { state.yaw = Math.atan2(4.2, 5.2); state.pitch = 0.23; state.distance = 6.87; invalidate(); } });
const save = mountButton(document.querySelector('#modeling-save'), { onClick: async () => {
  save.update({ disabled: true, label: 'Saving…' });
  try {
    renderAt(state.time);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG encoding returned no image');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'crucible-aster-lantern.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { fail(error); }
  finally { save.update({ disabled: false, label: 'Save PNG' }); }
} });
try {
  renderer = new CrucibleRenderer(canvas, scene.parts, { ground: true, hdr: true, samples: boundedOption('samples', 4, 1, 8), pixelRatio: exporting ? 1 : Math.min(devicePixelRatio, 1.5), memoryBudgetMiB: boundedOption('memory', 256, 32, 1024) });
  const triangles = scene.parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
  document.querySelector('#modeling-stat').textContent = `${scene.parts.length} parts · ${renderer.batches.length} draws · ${Math.round(triangles / 1000)}k triangles`;
  window.__scene = { scene, renderer, duration: 12, renderAt, pause: () => setPlaying(false) };
  window.renderAt = renderAt;
  renderAt(0);
  if (state.playing) invalidate();
} catch (error) { fail(error); }
canvas.addEventListener('pointerdown', event => { canvas.setPointerCapture(event.pointerId); canvas.focus({ preventScroll: true }); pointer = { id: event.pointerId, x: event.clientX, y: event.clientY }; });
canvas.addEventListener('pointermove', event => {
  if (!pointer || pointer.id !== event.pointerId) return;
  state.yaw -= (event.clientX - pointer.x) * 0.008;
  state.pitch = Math.max(-1.2, Math.min(1.2, state.pitch + (event.clientY - pointer.y) * 0.008));
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  invalidate();
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(event, () => { pointer = null; });
canvas.addEventListener('wheel', event => { event.preventDefault(); state.distance = Math.max(1.5, Math.min(30, state.distance * Math.exp(event.deltaY * 0.001))); invalidate(); }, { passive: false });
canvas.addEventListener('keydown', event => {
  const actions = { ArrowLeft: () => { state.yaw -= 0.1; }, ArrowRight: () => { state.yaw += 0.1; }, ArrowUp: () => { state.pitch = Math.min(1.2, state.pitch + 0.1); }, ArrowDown: () => { state.pitch = Math.max(-1.2, state.pitch - 0.1); }, '+': () => { state.distance = Math.max(1.5, state.distance * 0.9); }, '-': () => { state.distance = Math.min(30, state.distance * 1.1); }, ' ': () => setPlaying(!state.playing) };
  if (actions[event.key]) { event.preventDefault(); actions[event.key](); invalidate(); }
});
const observer = new ResizeObserver(() => { if (renderer && !failed) { renderer.resize(); invalidate(); } });
observer.observe(canvas);
document.addEventListener('visibilitychange', () => { lastTime = performance.now(); if (!document.hidden) invalidate(); });
reducedMotion.addEventListener('change', event => { if (event.matches && state.playing) setPlaying(false); });
canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); if (scheduled) cancelAnimationFrame(scheduled); scheduled = 0; fail(new Error('Graphics context lost')); });
window.addEventListener('pagehide', () => { if (scheduled) cancelAnimationFrame(scheduled); observer.disconnect(); renderer?.dispose(); });
