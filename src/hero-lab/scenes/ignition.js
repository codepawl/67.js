// Scene 2: a night desert test. The camera creeps in on a quiet tower under the stars, the sky flashes, a fireball climbs
// and the mountain ring lights up. Procedural, nothing to download. The fireball is the renderer's volumetric post pass.
import '../../world-material-shader.js';
import '../../explosion-shader.js';
import { Renderer67 } from '../../renderer.js';
import { createCameraSpline } from '../camera-spline.js';
import { createTestSiteParts } from '../test-site.js';

const NIGHT = {
  fogColor: [0.012, 0.02, 0.032],
  fogDensity: 0.005,
  skyTop: [0.05, 0.09, 0.15],
  skyBottom: [0.2, 0.26, 0.35],
  lightDirection: [-0.5, 0.6, 0.5],
  daylight: 0.32,
};
const BLAST_LIT = {
  fogColor: [0.34, 0.15, 0.06],
  fogDensity: 0.0045,
  skyTop: [0.18, 0.1, 0.1],
  skyBottom: [0.9, 0.42, 0.14],
  lightDirection: [-0.3, 0.55, 0.25],
  daylight: 0.95,
};
const SHADOWS = { extent: 55, target: [0, 6, 0], eye: [-35, 45, 35], near: 1, far: 140 };
const IGNITION_START = 0.5;
const IGNITION_END = 0.8;

// The tower sits right of centre so the headline has open sky and desert to its left; the camera then backs away to take in the whole fireball.
const cameraAt = createCameraSpline([
  { at: 0, eye: [20, 4, 30], target: [-7, 9, 0], fov: 38 },
  { at: 0.34, eye: [14, 3, 22], target: [-4, 10, 0], fov: 40 },
  { at: 0.5, eye: [15, 3.5, 23], target: [-4.5, 10, 0], fov: 42 },
  { at: 0.8, eye: [30, 8, 42], target: [-10, 14, 0], fov: 48 },
  { at: 1, eye: [40, 10, 56], target: [-12, 15, 0], fov: 50 },
]);

function smoothstep(start, end, value) {
  const amount = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return amount * amount * (3 - 2 * amount);
}

function blend(from, to, amount) {
  return from.map((value, axis) => value + (to[axis] - value) * amount);
}

function environmentAt(lit) {
  return {
    fogColor: blend(NIGHT.fogColor, BLAST_LIT.fogColor, lit),
    fogDensity: NIGHT.fogDensity + (BLAST_LIT.fogDensity - NIGHT.fogDensity) * lit,
    skyTop: blend(NIGHT.skyTop, BLAST_LIT.skyTop, lit),
    skyBottom: blend(NIGHT.skyBottom, BLAST_LIT.skyBottom, lit),
    lightDirection: blend(NIGHT.lightDirection, BLAST_LIT.lightDirection, lit),
    daylight: NIGHT.daylight + (BLAST_LIT.daylight - NIGHT.daylight) * lit,
  };
}

export async function createScene(canvas) {
  const parts = createTestSiteParts();
  const renderer = new Renderer67(canvas, parts, {
    world: true,
    ground: false,
    hdr: true,
    depth: true,
    environment: environmentAt(0),
    shadowBounds: SHADOWS,
    pixelRatio: Math.min(devicePixelRatio, 1.25),
    memoryBudgetMiB: 256,
    samples: 4,
  });
  return {
    label: 'A night desert test site, the tower, then the ignition',
    openHref: '/film.html',
    ambient: false,
    staticProgress: 0.58,
    render(progress, seconds, override) {
      const fire = smoothstep(IGNITION_START, IGNITION_END, progress);
      const lit = smoothstep(IGNITION_START, IGNITION_START + 0.1, progress);
      const flash = progress >= IGNITION_START ? Math.exp(-(progress - IGNITION_START) * 30) : 0;
      renderer.render({
        ...(override ?? cameraAt(progress)),
        time: seconds + progress * 12,
        exposure: 0.95 + flash * 1.4,
        cinematic: true,
        volumeExplosion: fire > 0.001,
        explosionProgress: fire,
        environment: environmentAt(lit),
        effects: { bloom: { strength: 0.18 + flash * 0.3 }, saturation: 0.82, contrast: 1.12, temperature: 0.03, vignette: 0.14, grain: 0.014 },
      });
    },
    resize: () => renderer.resize(),
    dispose: () => renderer.dispose(),
  };
}
