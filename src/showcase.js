import './site.css';
import './brand.js';
import './showcase.css';
import './pointer-light.js';
import { Renderer67 } from './renderer.js';
import { createSharedTextures, loadGltf } from './gltf.js';
import { loadHdri } from './hdri.js';
import { createCascadedShadows } from './cascaded-shadows.js';
import { applyWaterReflection, attachWaterReflection } from './water-reflection.js';

// The mirror redraws every second lit frame while the camera moves: about 1.3 ms off the orbiting port frame
// (issue #504), and An saw no stutter in a side-by-side. A still camera keeps its picture either way.
const WATER_REFLECTION_OPTIONS = { updateEvery: 2 };
import { createDownloadMeter, downloadBlob, inWholeWorldOrder, readByteLength, readPartRanks } from './showcase-download.js';

// Each scene lives in public/showcase/<id>/scene.json: its GLB, sky, camera, renderer and frame options, and credits.
// Optional fields: "bounds" ({ min, max } the camera target stays inside), "minDistance" and "maxDistance".
// A world can load in stages (scripts/split-showcase-glb.mjs): "glb" is then the first part, the ground and the hero the opening
// camera frames, "glbRest" lists the other parts and "hdriPreview" is a small sky for the first frame. The page draws the first
// frame from those two, then streams the rest in and swaps in the full sky.
const SCENE_LABELS = { airport: 'Airport ramp', datacenter: 'AI data center', port: 'Container port' };
const SCENE_GLOWS = { airport: '#ff6a2b', datacenter: '#3b82f6', port: '#f59e0b' };
const SCENE_IDS = Object.keys(SCENE_LABELS);
const MIN_PITCH = 0.05;
const MAX_PITCH = 1.45;
const DEFAULT_MAX_DISTANCE_FACTOR = 3;
const DEFAULT_MIN_DISTANCE_FACTOR = 0.05;
const BOUNDS_MARGIN = 0.25;
const MAX_SAMPLED_VERTICES_PER_PART = 4000;
const KEY_MOVE_PER_SECOND = 0.6;
const KEY_TURN_PER_SECOND = 1.6;

const SPINNER_ICON = '<svg class="status-icon spinner" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="3"/><path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
const ERROR_ICON = '<svg class="status-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.2v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

const canvas = document.querySelector('#showcase-viewport');
const frame = document.querySelector('.showcase-frame');
const status = document.querySelector('#showcase-status');
const tabs = document.querySelector('#showcase-tabs');
const resetButton = document.querySelector('#showcase-reset');
const title = document.querySelector('#showcase-title');
const blurb = document.querySelector('#showcase-blurb');
const creditList = document.querySelector('#showcase-credits');
const orbit = { yaw: 0, pitch: 0, distance: 1, target: [0, 0, 0] };
const limits = { minDistance: 0.1, maxDistance: 10, boundsMin: [-1, -1, -1], boundsMax: [1, 1, 1] };
const homeView = { yaw: 0, pitch: 0, distance: 1, target: [0, 0, 0] };
const pointers = new Map();
const pressedKeys = new Set();
let renderer = null;
let scene = null;
let currentId = null;
let loadingId = null;
let loadingRequest = 0;
let loadingAbort = null;
let scheduledFrame = 0;
let dragMode = 'orbit';
let keyFrame = 0;
let keyTimestamp = 0;

function setLoadingState(id) {
  loadingId = id;
  frame.dataset.loading = id ? 'true' : 'false';
  for (const button of tabs.querySelectorAll('button')) {
    button.disabled = Boolean(id) && (button.dataset.scene === id || button.dataset.scene === currentId);
  }
}

function showStatus(kind, message) {
  status.hidden = false;
  status.dataset.kind = kind;
  status.innerHTML = kind === 'error' ? ERROR_ICON : SPINNER_ICON;
  const text = document.createElement('span');
  text.className = 'status-text';
  text.textContent = message;
  status.append(text);
}

// Real bytes fetched so far; the total appears once every file's size is known, so the figure never shrinks.
function showProgress(label, meter) {
  const { received, total } = meter.summary();
  const megabytes = bytes => (bytes / 1e6).toFixed(1);
  showStatus('loading', `${label}…  ${total ? `${megabytes(received)} of ${megabytes(total)} MB` : `${megabytes(received)} MB`}`);
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(vector) {
  const length = Math.hypot(...vector) || 1;
  return vector.map(value => value / length);
}

function orbitFromCamera(eye, target) {
  const offset = eye.map((value, axis) => value - target[axis]);
  const distance = Math.hypot(...offset);
  orbit.target = [...target];
  orbit.distance = distance;
  orbit.yaw = Math.atan2(offset[0], offset[2]);
  orbit.pitch = Math.asin(offset[1] / distance);
}

function eyeFromOrbit() {
  const horizontal = Math.cos(orbit.pitch) * orbit.distance;
  return [
    orbit.target[0] + Math.sin(orbit.yaw) * horizontal,
    orbit.target[1] + Math.sin(orbit.pitch) * orbit.distance,
    orbit.target[2] + Math.cos(orbit.yaw) * horizontal,
  ];
}

function clampOrbit() {
  orbit.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, orbit.pitch));
  orbit.distance = Math.max(limits.minDistance, Math.min(limits.maxDistance, orbit.distance));
  orbit.target = orbit.target.map((value, axis) => Math.max(limits.boundsMin[axis], Math.min(limits.boundsMax[axis], value)));
}

// The part bounds, sampled so a scene with millions of vertices still opens quickly, plus a margin.
function boundsOfParts(parts) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const positions = part.geometry?.positions;
    const matrix = part.matrix;
    if (!positions || !matrix) continue;
    const vertexCount = positions.length / 3;
    const stride = Math.max(1, Math.floor(vertexCount / MAX_SAMPLED_VERTICES_PER_PART));
    for (let vertex = 0; vertex < vertexCount; vertex += stride) {
      const x = positions[vertex * 3];
      const y = positions[vertex * 3 + 1];
      const z = positions[vertex * 3 + 2];
      for (let axis = 0; axis < 3; axis++) {
        const value = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
        minimum[axis] = Math.min(minimum[axis], value);
        maximum[axis] = Math.max(maximum[axis], value);
      }
    }
  }
  return minimum.every(Number.isFinite) ? { min: minimum, max: maximum } : null;
}

// The limits follow the opening view, so working them out again once every part has loaded gives the same result as a one-piece load.
function applyLimits(description, parts, view = orbit) {
  const bounds = description.bounds ?? boundsOfParts(parts) ?? {
    min: view.target.map(value => value - view.distance),
    max: view.target.map(value => value + view.distance),
  };
  const margin = bounds.max.map((value, axis) => (value - bounds.min[axis]) * BOUNDS_MARGIN);
  limits.boundsMin = bounds.min.map((value, axis) => Math.min(value - margin[axis], view.target[axis]));
  limits.boundsMax = bounds.max.map((value, axis) => Math.max(value + margin[axis], view.target[axis]));
  limits.minDistance = description.minDistance ?? view.distance * DEFAULT_MIN_DISTANCE_FACTOR;
  limits.maxDistance = description.maxDistance ?? view.distance * DEFAULT_MAX_DISTANCE_FACTOR;
}

function draw() {
  scheduledFrame = 0;
  if (!renderer || !scene) return;
  clampOrbit();
  renderer.render({ ...scene.frame, eye: eyeFromOrbit(), target: orbit.target });
}

function requestDraw() {
  if (!scheduledFrame) scheduledFrame = requestAnimationFrame(draw);
}

// Screen-space pan: the target slides along the camera's right and up directions.
function panByPixels(deltaX, deltaY) {
  const forward = normalize(orbit.target.map((value, axis) => value - eyeFromOrbit()[axis]));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const scale = orbit.distance * 0.0016;
  orbit.target = orbit.target.map((value, axis) => value - right[axis] * deltaX * scale + up[axis] * deltaY * scale);
  requestDraw();
}

function moveOnGround(forwardAmount, rightAmount) {
  const forward = [-Math.sin(orbit.yaw), 0, -Math.cos(orbit.yaw)];
  const right = [Math.cos(orbit.yaw), 0, -Math.sin(orbit.yaw)];
  orbit.target = orbit.target.map((value, axis) => value + forward[axis] * forwardAmount + right[axis] * rightAmount);
}

function keyboardStep(timestamp) {
  keyFrame = 0;
  if (!pressedKeys.size) return;
  const seconds = Math.min(0.1, (timestamp - keyTimestamp) / 1000);
  keyTimestamp = timestamp;
  const step = orbit.distance * KEY_MOVE_PER_SECOND * seconds;
  const axis = (positive, negative) => Number(pressedKeys.has(positive)) - Number(pressedKeys.has(negative));
  moveOnGround(step * (axis('w', 's') + axis('arrowup', 'arrowdown')), step * (axis('d', 'a') + axis('arrowright', 'arrowleft')));
  orbit.yaw += KEY_TURN_PER_SECOND * seconds * axis('q', 'e');
  requestDraw();
  keyFrame = requestAnimationFrame(keyboardStep);
}

function resetView() {
  orbit.yaw = homeView.yaw;
  orbit.pitch = homeView.pitch;
  orbit.distance = homeView.distance;
  orbit.target = [...homeView.target];
  requestDraw();
}

function renderTabs() {
  for (const id of SCENE_IDS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.scene = id;
    button.textContent = SCENE_LABELS[id];
    button.addEventListener('click', () => selectScene(id));
    tabs.append(button);
  }
}

async function readDescription(id) {
  const response = await fetch(`/showcase/${id}/scene.json`);
  if (!response.ok) throw new Error(`scene ${id} is not available (${response.status})`);
  return response.json();
}

function showCredits(credits = []) {
  creditList.replaceChildren(...credits.map(credit => {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = credit.source;
    link.textContent = credit.model;
    item.append(link, ` by ${credit.author}, ${credit.licence}`);
    return item;
  }));
}

function markPressedTab(id) {
  for (const button of tabs.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.scene === id));
}

// Adds the other parts of a staged world once they have downloaded, then swaps the first frame's small sky for the full one.
async function finishWorld(world) {
  const { request, description, asset, sharedTextures, detachReflection, remainingDownloads, abort } = world;
  const isCurrent = () => request === loadingRequest;
  try {
    const [remainingModels, fullMap] = await remainingDownloads;
    if (!isCurrent()) return;
    const files = [{ parts: asset.parts, ranks: world.ranks }];
    for (const [index, model] of remainingModels.entries()) {
      const baseUrl = new URL('.', new URL(description.glbRest[index], location.href)).href;
      const remaining = await loadGltf(model, { baseUrl, sharedTextures, ...(description.gltfOptions ?? {}) });
      files.push({ parts: remaining.parts, ranks: await readPartRanks(model) });
    }
    if (!isCurrent()) return;
    // The renderer adds textured parts through this opt-in addon, which stays out of the core bundle.
    await import('./replace-textured-parts.js');
    if (!isCurrent()) return;
    const allParts = inWholeWorldOrder(files);
    // The reflecting surface is found over the whole world, as in a one-piece load, so a part that arrives late can take the mirror.
    const reflection = description.waterReflection ? applyWaterReflection(allParts) : { parts: allParts, surface: null };
    renderer.replaceParts(reflection.parts);
    detachReflection();
    attachWaterReflection(renderer, reflection.surface, WATER_REFLECTION_OPTIONS);
    applyLimits(description, allParts, homeView);
    if (fullMap) scene.frame = { ...scene.frame, environment: { map: fullMap } };
    window.__showcase.complete = true;
    status.hidden = true;
    requestDraw();
  } catch (error) {
    if (!isCurrent() || abort.signal.aborted) return;
    showStatus('error', `Could not finish loading ${SCENE_LABELS[world.id]}: ${error.message}`);
  }
}

// The old scene stays on screen and interactive until the new one is ready.
async function selectScene(id) {
  const request = ++loadingRequest;
  loadingAbort?.abort();
  const abort = new AbortController();
  loadingAbort = abort;
  document.documentElement.style.setProperty('--glow', SCENE_GLOWS[id]);
  setLoadingState(id);
  markPressedTab(id);
  let progressLabel = `Loading ${SCENE_LABELS[id]}`;
  const meter = createDownloadMeter(() => { if (request === loadingRequest) showProgress(progressLabel, meter); });
  showProgress(progressLabel, meter);
  try {
    const description = await readDescription(id);
    const glbUrl = new URL(description.glb, location.href);
    const skyUrl = new URL(description.hdri, location.href).href;
    const previewUrl = description.hdriPreview ? new URL(description.hdriPreview, location.href).href : null;
    const remainingUrls = (description.glbRest ?? []).map(path => new URL(path, location.href).href);
    const download = (url, type) => downloadBlob(url, { meter, name: url, type, signal: abort.signal });
    const loadSky = async url => {
      const blob = await download(url, 'image/vnd.radiance');
      return loadHdri(url, { ...(description.hdriOptions ?? {}), fetchImplementation: async () => new Response(blob) });
    };
    meter.register(glbUrl.href);
    meter.register(previewUrl ?? skyUrl);
    // Files that load after the first frame register now with their sizes from a header request, so the total is known early.
    const laterUrls = [...remainingUrls, ...(previewUrl ? [skyUrl] : [])];
    for (const url of laterUrls) {
      meter.register(url);
      readByteLength(url, abort.signal).then(total => meter.setTotal(url, total), () => {});
    }
    const [model, map] = await Promise.all([
      download(glbUrl.href, 'model/gltf-binary'),
      loadSky(previewUrl ?? skyUrl),
    ]);
    // The rest starts the moment the first part is in, so the link stays busy while the page decodes and draws it.
    const remainingDownloads = Promise.all([
      Promise.all(remainingUrls.map(url => download(url, 'model/gltf-binary'))),
      previewUrl ? loadSky(skyUrl) : null,
    ]);
    remainingDownloads.catch(() => {});
    const sharedTextures = createSharedTextures();
    const asset = await loadGltf(model, { baseUrl: new URL('.', glbUrl).href, sharedTextures, ...(description.gltfOptions ?? {}) });
    if (request !== loadingRequest) return;
    renderer?.dispose();
    const rendererOptions = description.renderer ?? {};
    // scene.json stores cascades as plain options; the renderer takes the cascade object built from them.
    const shadowCascades = rendererOptions.shadowCascades ? createCascadedShadows(rendererOptions.shadowCascades) : undefined;
    // A scene that sets waterReflection mirrors itself in its largest flat, smooth surface (water or a polished floor).
    const reflection = description.waterReflection ? applyWaterReflection(asset.parts) : { parts: asset.parts, surface: null };
    renderer = new Renderer67(canvas, reflection.parts, {
      ground: false, hdr: true, samples: 4, memoryBudgetMiB: 384,
      ...rendererOptions,
      shadowCascades,
      environment: { ...(rendererOptions.environment ?? {}), map },
    });
    const detachReflection = attachWaterReflection(renderer, reflection.surface, WATER_REFLECTION_OPTIONS);
    scene = { frame: { exposure: description.exposure ?? 1, ...(description.frame ?? {}) } };
    orbitFromCamera(description.eye, description.target);
    applyLimits(description, asset.parts);
    Object.assign(homeView, { yaw: orbit.yaw, pitch: orbit.pitch, distance: orbit.distance, target: [...orbit.target] });
    currentId = id;
    history.replaceState(null, '', `?scene=${id}`);
    title.textContent = description.title;
    blurb.textContent = description.blurb;
    showCredits(description.credits);
    const staged = remainingUrls.length > 0 || previewUrl !== null;
    window.__showcase = { renderer, scene, orbit, draw, limits, complete: !staged };
    setLoadingState(null);
    requestDraw();
    if (!staged) {
      status.hidden = true;
      return;
    }
    progressLabel = `Loading the rest of ${SCENE_LABELS[id]}`;
    showProgress(progressLabel, meter);
    finishWorld({ id, request, description, asset, sharedTextures, ranks: await readPartRanks(model), detachReflection, remainingDownloads, abort });
  } catch (error) {
    if (request !== loadingRequest) return;
    markPressedTab(currentId);
    setLoadingState(null);
    showStatus('error', `Could not open ${SCENE_LABELS[id]}: ${error.message}`);
  }
}

function pairMetrics() {
  const [first, second] = [...pointers.values()];
  return {
    distance: Math.hypot(first.x - second.x, first.y - second.y) || 1,
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('pointerdown', event => {
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  dragMode = event.button === 2 || event.button === 1 || event.shiftKey ? 'pan' : 'orbit';
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => {
  const previous = pointers.get(event.pointerId);
  if (!previous) return;
  if (pointers.size === 2) {
    const before = pairMetrics();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const after = pairMetrics();
    orbit.distance *= before.distance / after.distance;
    panByPixels(after.x - before.x, after.y - before.y);
    return;
  }
  const deltaX = event.clientX - previous.x;
  const deltaY = event.clientY - previous.y;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (dragMode === 'pan') {
    panByPixels(deltaX, deltaY);
    return;
  }
  orbit.yaw -= deltaX * 0.005;
  orbit.pitch += deltaY * 0.004;
  requestDraw();
});
const endPointer = event => { pointers.delete(event.pointerId); };
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  orbit.distance *= Math.exp(event.deltaY * 0.001);
  requestDraw();
}, { passive: false });

canvas.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (!'wasdqe'.includes(key) && !key.startsWith('arrow')) return;
  event.preventDefault();
  if (pressedKeys.has(key)) return;
  pressedKeys.add(key);
  if (!keyFrame) {
    keyTimestamp = performance.now();
    keyFrame = requestAnimationFrame(keyboardStep);
  }
});
canvas.addEventListener('keyup', event => { pressedKeys.delete(event.key.toLowerCase()); });
canvas.addEventListener('blur', () => pressedKeys.clear());

resetButton.addEventListener('click', resetView);
window.addEventListener('resize', () => {
  renderer?.resize();
  requestDraw();
});

renderTabs();
const requested = new URLSearchParams(location.search).get('scene');
selectScene(SCENE_IDS.includes(requested) ? requested : SCENE_IDS[0]);
