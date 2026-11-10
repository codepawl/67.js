// Home hero: five live worlds played one after another in an endless loop. A camera flies an authored route through each world,
// the next world crossfades in, and the one that just left is freed. At most two worlds hold GPU memory at once.
//   ?capture=1   no real-time clock: the page waits for window.__loop.step(seconds) so a recorder can render exact frames
//   ?measure=1   reads a pixel back after every draw so frame times include the GPU, and keeps per-scene samples
//   ?samples=1   overrides the anti-aliasing sample count (previews)
import './lab.css';
import './loop/loop.css';
import { clamp, prefersReducedMotion, showStageError, smoothstep, startLoop, metrics } from './stage.js';
import { SCENES } from './loop/scenes.js';
import { createFlight } from './loop/camera.js';
import { buildWorld, fetchWorld } from './loop/world.js';

const parameters = new URLSearchParams(location.search);
const captureMode = parameters.has('capture');
const measureMode = parameters.has('measure');

const FADE_SECONDS = 1;
const REDUCED_FADE_SECONDS = 2.2;
const REDUCED_HOLD_SECONDS = 5;
const REDUCED_FLIGHT_POSITION = 0.38;
const BUILD_AFTER_SECONDS = 1.5;
const STILL_SCENE_TIME = 1;

const root = document.querySelector('.hero-loop');
const stage = document.querySelector('#stage');
const tabs = document.querySelector('#scene-tabs');
const attribution = document.querySelector('#attribution');
const creditsToggle = document.querySelector('#credits-toggle');
const creditsPanel = document.querySelector('#credits-panel');

const fadeSeconds = prefersReducedMotion ? REDUCED_FADE_SECONDS : FADE_SECONDS;
const flights = SCENES.map(scene => createFlight({ keys: scene.keys, duration: scene.seconds + FADE_SECONDS, near: scene.near, far: scene.far }));
const playSeconds = scene => (prefersReducedMotion ? REDUCED_HOLD_SECONDS : scene.seconds);

let clock = 0;
let active = null;
let incoming = null;
let pending = null;
let skipRequested = false;
let loopRound = 0;

const loopState = window.__loop = {
  events: [],
  samples: [],
  worldsAlive: () => [active, incoming, pending?.world && pending].filter(Boolean).length,
  peakWorlds: 0,
};

function note(kind, detail = {}) {
  loopState.events.push({ kind, at: Math.round(performance.now()), clock: +clock.toFixed(2), ...detail });
}

function createCanvas() {
  const canvas = document.createElement('canvas');
  canvas.className = 'world';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.opacity = '0';
  stage.append(canvas);
  return canvas;
}

function sizeOverrides() {
  return parameters.has('samples') ? { samples: Number(parameters.get('samples')) } : {};
}

async function buildFrom(download) {
  const world = await buildWorld(download, createCanvas(), sizeOverrides());
  if (measureMode) {
    const context = world.canvas.getContext('webgl2');
    const probe = new Uint8Array(4);
    const draw = world.render;
    world.render = (...drawArguments) => {
      draw(...drawArguments);
      context.readPixels(0, 0, 1, 1, context.RGBA, context.UNSIGNED_BYTE, probe);
    };
  }
  return world;
}

// Fetches the next world right away; building it (parsing and GPU upload) waits until the current world has played a moment
// so the upload does not land on the opening frames, unless a visitor asked for it.
function prepare(index, { immediately = false } = {}) {
  const entry = { index, world: null, error: null, permit: null, skipped: false };
  entry.permission = new Promise(resolve => { entry.permit = resolve; });
  if (immediately) entry.permit();
  entry.ready = fetchWorld(SCENES[index].description)
    .then(async download => {
      note('fetched', { scene: SCENES[index].id, bytes: download.bytes });
      loopState.bytes ??= {};
      loopState.bytes[SCENES[index].id] = download.bytes;
      await entry.permission;
      if (entry.skipped) return;
      const started = performance.now();
      entry.world = await buildFrom(download);
      note('built', { scene: SCENES[index].id, ms: Math.round(performance.now() - started) });
      loopState.peakWorlds = Math.max(loopState.peakWorlds, loopState.worldsAlive());
    })
    .catch(error => {
      entry.error = error;
      note('failed', { scene: SCENES[index].id, message: error.message });
    });
  pending = entry;
  return entry;
}

function discardPending() {
  if (!pending) return;
  pending.skipped = true;
  pending.permit();
  const entry = pending;
  pending = null;
  entry.ready.then(() => entry.world?.dispose());
}

function nextIndex(index) {
  return (index + 1) % SCENES.length;
}

// ---- Indicator: the scene names as quiet text buttons, a progress ring on the one playing.
const RING_LENGTH = 2 * Math.PI * 7;
const ringMarks = SCENES.map((scene, index) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'scene-tab';
  button.dataset.index = String(index);
  button.innerHTML = '<svg viewBox="0 0 18 18" aria-hidden="true"><circle class="ring-track" cx="9" cy="9" r="7"/><circle class="ring-fill" cx="9" cy="9" r="7"/><circle class="ring-dot" cx="9" cy="9" r="2.2"/></svg><span></span>';
  button.querySelector('span').textContent = scene.name;
  button.addEventListener('click', () => requestScene(index));
  tabs.append(button);
  return { button, fill: button.querySelector('.ring-fill') };
});
ringMarks.forEach(mark => { mark.fill.style.strokeDasharray = String(RING_LENGTH); mark.fill.style.strokeDashoffset = String(RING_LENGTH); });

function paintIndicator(progress) {
  ringMarks.forEach((mark, index) => {
    const isActive = active && index === active.index;
    mark.button.toggleAttribute('aria-current', Boolean(isActive));
    if (isActive) mark.button.setAttribute('aria-current', 'true');
    mark.button.dataset.state = isActive ? 'playing' : pending?.index === index && !pending.world ? 'loading' : 'idle';
  });
  if (active) ringMarks[active.index].fill.style.strokeDashoffset = String(RING_LENGTH * (1 - clamp(progress, 0, 1)));
}

function paintScene(index) {
  const scene = SCENES[index];
  root.dataset.scene = scene.id;
  root.style.setProperty('--scrim', String(scene.scrim));
  stage.setAttribute('aria-label', `A live 3D scene: ${scene.name}`);
  ringMarks.forEach(mark => { mark.fill.style.strokeDashoffset = String(RING_LENGTH); });
  const simready = scene.credits.find(credit => credit.label.startsWith('NVIDIA'));
  attribution.hidden = !simready;
  if (simready) {
    attribution.href = simready.href;
    attribution.querySelector('span').textContent = `${simready.label}, ${simready.licence}`;
  }
}

// ---- Credits: every attribution the five worlds need, one list.
function buildCredits() {
  const items = SCENES.flatMap(scene => scene.credits.map(credit => ({ ...credit, scene: scene.name })));
  creditsPanel.replaceChildren(...items.map(credit => {
    const row = document.createElement('a');
    row.href = credit.href;
    row.target = '_blank';
    row.rel = 'noopener';
    row.innerHTML = '<span class="credit-name"></span><span class="credit-meta"></span>';
    row.querySelector('.credit-name').textContent = credit.label;
    row.querySelector('.credit-meta').textContent = `${credit.scene}, ${credit.licence}`;
    return row;
  }));
  const rest = document.createElement('p');
  rest.textContent = 'Everything else is CodePawl work (MIT) or CC0 from Poly Haven and ambientCG.';
  creditsPanel.append(rest);
}
buildCredits();
creditsToggle.addEventListener('click', () => {
  const open = creditsPanel.hidden;
  creditsPanel.hidden = !open;
  creditsToggle.setAttribute('aria-expanded', String(open));
});

function requestScene(index) {
  if (!active || incoming || index === active.index) return;
  skipRequested = true;
  if (pending?.index !== index) {
    discardPending();
    prepare(index, { immediately: true });
  } else {
    pending.permit();
  }
  note('requested', { scene: SCENES[index].id });
}

// ---- The loop.
function drawWorld(entry, flightSeconds, sceneTime) {
  const pose = flights[entry.index].at(flightSeconds);
  const started = performance.now();
  entry.world.render(pose, sceneTime);
  if (measureMode) loopState.samples.push({ scene: SCENES[entry.index].id, drawMs: performance.now() - started, blending: Boolean(incoming) });
}

function startTransition() {
  incoming = { index: pending.index, world: pending.world, startedAt: clock };
  pending = null;
  skipRequested = false;
  root.style.setProperty('--scrim', String(SCENES[incoming.index].scrim));
  note('fade-start', { from: SCENES[active.index].id, to: SCENES[incoming.index].id });
}

function finishTransition() {
  const leaving = active;
  active = incoming;
  incoming = null;
  active.world.canvas.style.opacity = '1';
  leaving.world.dispose();
  note('freed', { scene: SCENES[leaving.index].id });
  if (active.index === 0) loopRound++;
  paintScene(active.index);
  prepare(nextIndex(active.index));
}

function tick(seconds) {
  clock += seconds;
  const scene = SCENES[active.index];
  const activeSeconds = clock - active.startedAt;
  if (pending?.error) {
    const failed = pending.index;
    pending = null;
    prepare(nextIndex(failed));
  }
  if (!incoming && pending?.world && (skipRequested || activeSeconds >= playSeconds(scene))) startTransition();
  if (!incoming && pending && !pending.world && activeSeconds >= BUILD_AFTER_SECONDS) pending.permit();

  const flightSeconds = prefersReducedMotion ? flights[active.index].duration * REDUCED_FLIGHT_POSITION : activeSeconds;
  const sceneTime = prefersReducedMotion ? STILL_SCENE_TIME : clock;
  const stillHeld = prefersReducedMotion && !incoming && active.drawn;
  if (!stillHeld) drawWorld(active, flightSeconds, sceneTime);
  active.drawn = true;
  if (incoming) {
    const amount = smoothstep(0, 1, (clock - incoming.startedAt) / fadeSeconds);
    const incomingSeconds = prefersReducedMotion ? flights[incoming.index].duration * REDUCED_FLIGHT_POSITION : clock - incoming.startedAt;
    drawWorld(incoming, incomingSeconds, sceneTime);
    incoming.world.canvas.style.opacity = String(amount);
    if (amount >= 1) finishTransition();
  }
  paintIndicator(incoming ? 1 : prefersReducedMotion ? 0 : activeSeconds / scene.seconds);
}

async function start() {
  const first = prepare(0, { immediately: true });
  await first.ready;
  if (first.error) throw first.error;
  active = { index: 0, world: first.world, startedAt: 0, drawn: false };
  active.world.canvas.style.opacity = '1';
  paintScene(0);
  prepare(1);

  window.addEventListener('resize', () => [active, incoming].forEach(entry => entry?.world.resize()));
  if (captureMode) {
    // The recorder owns time: each call advances the clock, waits for a due world, and draws exactly once.
    loopState.step = async seconds => {
      const scene = SCENES[active.index];
      if (!incoming && clock - active.startedAt + seconds >= playSeconds(scene) && pending) {
        pending.permit();
        await pending.ready;
        if (pending.error) throw pending.error;
      }
      tick(seconds);
      revealPoster();
    };
    loopState.ready = true;
    return;
  }
  const loop = startLoop(stage, seconds => {
    tick(seconds);
    return true;
  });
  loopState.wake = loop.wake;
  loopState.ready = true;
  window.addEventListener('keydown', () => loop.wake());
}

function revealPoster() {
  if (stage.dataset.live === 'true') return;
  metrics.firstLiveFrameMs = Math.round(performance.now());
  requestAnimationFrame(() => { stage.dataset.live = 'true'; });
}

Object.assign(loopState, { get clock() { return clock; }, get round() { return loopRound; }, get active() { return active && SCENES[active.index].id; }, scenes: SCENES });
// ?scout=1: no loop; window.__loop.scout(id) builds one world and returns a function that draws it from any pose (for authoring flights).
loopState.scout = async id => {
  const index = SCENES.findIndex(scene => scene.id === id);
  const world = await buildFrom(await fetchWorld(SCENES[index].description));
  world.canvas.style.opacity = '1';
  stage.dataset.live = 'true';
  return (eye, target, fov) => world.render({ eye, target, fov }, 1);
};
if (!parameters.has('scout')) start().catch(error => showStageError(stage, `Live view unavailable: ${error.message}`));
