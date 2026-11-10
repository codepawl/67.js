// Direction C: type first. A small procedural scene (a ring of spheres around a torus, no downloads) that
// brightens and speeds up while the call to action is hovered or focused.
import './lab.css';
import { mat4, quat } from 'gl-matrix';
import { Renderer67 } from '../renderer.js';
import { sphere, torus } from '../geometry.js';
import { damp, prefersReducedMotion, showStageError, startLoop } from './stage.js';

const stage = document.querySelector('#stage');
const canvas = document.querySelector('#viewport');
const cta = document.querySelector('#cta');

const SPHERE_COUNT = 7;
const RING_RADIUS = 1.5;
const IDLE_SPEED = 0.28;
const EXCITED_SPEED = 1.1;
const LIGHT_RATE = 9;

function transform(position, scale, rotation = [0, 0, 0]) {
  const orientation = quat.fromEuler(quat.create(), ...rotation.map(angle => angle * 180 / Math.PI));
  return mat4.fromRotationTranslationScale(mat4.create(), orientation, position, scale);
}

function buildParts() {
  const ball = sphere(48, 32);
  const ring = torus(0.06, 96, 20);
  const parts = [
    { name: 'ring', geometry: ring, matrix: transform([0, 0, 0], [RING_RADIUS, RING_RADIUS, RING_RADIUS], [Math.PI / 2, 0, 0]), material: { tag: 'ring', color: [0.8, 0.8, 0.84], metallic: 1, roughness: 0.22, emission: 0 } },
    { name: 'core', geometry: ball, matrix: transform([0, 0, 0], [0.62, 0.62, 0.62]), material: { tag: 'core', color: [1, 0.26, 0.05], metallic: 0.1, roughness: 0.35, emission: 0.9 } },
  ];
  for (let index = 0; index < SPHERE_COUNT; index++) {
    parts.push({ name: `bead-${index}`, geometry: ball, matrix: transform([0, 0, 0], [0.2, 0.2, 0.2]), material: { tag: `bead-${index}`, color: [0.92, 0.9, 0.96], metallic: 0.9, roughness: 0.16, emission: 0 } });
  }
  return parts;
}

function placeBeads(parts, turn, lift) {
  for (let index = 0; index < SPHERE_COUNT; index++) {
    const angle = turn + index / SPHERE_COUNT * Math.PI * 2;
    const bob = Math.sin(angle * 2 + turn) * 0.16 * lift;
    parts[2 + index].matrix = transform([Math.cos(angle) * RING_RADIUS, bob, Math.sin(angle) * RING_RADIUS], [0.2, 0.2, 0.2]);
  }
}

function start() {
  const parts = buildParts();
  const renderer = new Renderer67(canvas, parts, { hdr: true, transparent: true, samples: 4, ground: false, pixelRatio: Math.min(devicePixelRatio, 2), memoryBudgetMiB: 128 });
  const state = { turn: 0.6, speed: IDLE_SPEED, light: 0, wanted: 0 };

  const setExcited = value => {
    state.wanted = value;
    loop.wake();
  };
  cta.addEventListener('pointerenter', () => setExcited(1));
  cta.addEventListener('pointerleave', () => setExcited(0));
  cta.addEventListener('focus', () => setExcited(1));
  cta.addEventListener('blur', () => setExcited(0));

  const loop = startLoop(stage, seconds => {
    state.light = damp(state.light, state.wanted, LIGHT_RATE, seconds);
    const idleSpeed = prefersReducedMotion ? 0 : IDLE_SPEED;
    const speed = idleSpeed + (EXCITED_SPEED - IDLE_SPEED) * state.light * (prefersReducedMotion ? 0.25 : 1);
    state.turn += speed * seconds;
    placeBeads(parts, state.turn, 1);
    renderer.updateParts(parts, { shadows: false });
    const aimed = [0.2, 1.3, 7.4];
    renderer.render({
      target: [0, 0, 0],
      eye: aimed,
      exposure: 1 + state.light * 0.55,
      effects: { vignette: 0.1, bloom: { strength: 0.18 + state.light * 0.55, threshold: 0.9, radius: 1.1 } },
    });
    const resting = prefersReducedMotion && state.light < 0.002 && state.wanted === 0;
    return !resting;
  });
  window.__heroState = { state, renderer };
}

try {
  start();
} catch (error) {
  showStageError(stage, `Live view unavailable: ${error.message}`);
}
