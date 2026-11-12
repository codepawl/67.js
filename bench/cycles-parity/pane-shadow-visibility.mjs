// A small room lit only by the sky through a window with a glass pane, traced by the native "cycles" kernel with the pane
// blocking shadow rays (the default) and with `rayVisibility: { shadow: false }` (#1054). For each setting it renders 64 and 512 spp and a
// 4096 spp reference of the same setting, and writes the mean radiance, the relMSE against that reference and a side-by-side image.
//
// node bench/cycles-parity/pane-shadow-visibility.mjs <output directory>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildFlattenedJobNativeInput } from '../../packages/render-native/job-input.mjs';
import { traceNative } from '../../packages/render-native/index.mjs';
import { box } from '../../src/geometry.js';
import { createCamera } from '../../src/path-tracer.js';
import * as pack from '../../src/path-tracer-gpu-pack.js';
import { buildTraceScene, resolveTexture } from '../../src/path-tracer-scene.js';

const WIDTH = 128;
const HEIGHT = 96;
const BOUNCES = 8;
const REFERENCE_SAMPLES = 4096;
const SAMPLE_COUNTS = [64, 512];
const RELATIVE_MSE_FLOOR = 0.01;
const SKY_WIDTH = 32;
const SKY_HEIGHT = 16;
const SKY_INTENSITY = 3;

const camera = createCamera({ eye: [0, 1.6, 2.6], target: [0, 1.2, -1], fov: 70 }, WIDTH, HEIGHT);

// An equirectangular sky, brighter and bluer toward the zenith.
function skyMap() {
  const data = new Float32Array(SKY_WIDTH * SKY_HEIGHT * 3);
  for (let row = 0; row < SKY_HEIGHT; row++) {
    const height = 1 - (row + 0.5) / SKY_HEIGHT;
    for (let column = 0; column < SKY_WIDTH; column++) {
      const base = (row * SKY_WIDTH + column) * 3;
      data[base] = 0.35 + 0.35 * height;
      data[base + 1] = 0.5 + 0.35 * height;
      data[base + 2] = 0.8 + 0.2 * height;
    }
  }
  return { width: SKY_WIDTH, height: SKY_HEIGHT, channels: 3, data, intensity: SKY_INTENSITY, rotation: 0 };
}

function slab(name, center, size, material, extra = {}) {
  const matrix = new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, center[0], center[1], center[2], 1]);
  return { name, geometry: box(0, 1), matrix, material, ...extra };
}

// A 4 x 3 x 6 m room whose back wall has a 2 x 1.4 m window, closed by a 4 mm two-sided pane of clear glass.
function roomParts(paneExtra) {
  const wall = { tag: 'surface', color: [0.7, 0.68, 0.64], roughness: 0.9, metallic: 0 };
  const glass = { tag: 'surface', color: [1, 1, 1], roughness: 0, metallic: 0, transmission: 1, ior: 1.5 };
  return [
    slab('floor', [0, -0.1, 0], [4.4, 0.2, 6.4], wall),
    slab('ceiling', [0, 3.1, 0], [4.4, 0.2, 6.4], wall),
    slab('left wall', [-2.1, 1.5, 0], [0.2, 3.2, 6.4], wall),
    slab('right wall', [2.1, 1.5, 0], [0.2, 3.2, 6.4], wall),
    slab('front wall', [0, 1.5, 3.1], [4.4, 3.2, 0.2], wall),
    slab('back wall below', [0, 0.5, -3.1], [4.4, 1, 0.2], wall),
    slab('back wall above', [0, 2.7, -3.1], [4.4, 0.6, 0.2], wall),
    slab('back wall left', [-1.5, 1.7, -3.1], [1, 1.4, 0.2], wall),
    slab('back wall right', [1.5, 1.7, -3.1], [1, 1.4, 0.2], wall),
    slab('pane', [0, 1.7, -3.1], [2, 1.4, 0.004], glass, paneExtra),
  ];
}

function render(paneExtra, samples, seed, sun) {
  const environment = { ...sun, map: skyMap() };
  const scene = buildTraceScene(roomParts(paneExtra), environment);
  const options = { width: WIDTH, height: HEIGHT, samples, bounces: BOUNCES, seed, noiseThreshold: 0 };
  const input = buildFlattenedJobNativeInput(scene, camera, options, pack, resolveTexture);
  return traceNative(input, { width: WIDTH, height: HEIGHT, samples, kernel: 'cycles', maxSeconds: 900 }).rgba;
}

function meanRadiance(rgba) {
  let sum = 0;
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) sum += (rgba[pixel * 4] + rgba[pixel * 4 + 1] + rgba[pixel * 4 + 2]) / 3;
  return sum / (WIDTH * HEIGHT);
}

function relativeMeanSquaredError(rgba, reference) {
  let sum = 0;
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const difference = rgba[pixel * 4 + channel] - reference[pixel * 4 + channel];
      sum += (difference * difference) / (reference[pixel * 4 + channel] ** 2 + RELATIVE_MSE_FLOOR);
    }
  }
  return sum / (WIDTH * HEIGHT * 3);
}

// Display encode: exposure 1, sRGB curve; panels side by side, rows top first.
function toPpmPanel(panels) {
  const pixels = Buffer.alloc(WIDTH * panels.length * HEIGHT * 3);
  panels.forEach((rgba, panel) => {
    for (let row = 0; row < HEIGHT; row++) {
      for (let column = 0; column < WIDTH; column++) {
        for (let channel = 0; channel < 3; channel++) {
          const linear = Math.min(1, Math.max(0, rgba[(row * WIDTH + column) * 4 + channel]));
          const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
          pixels[(row * WIDTH * panels.length + panel * WIDTH + column) * 3 + channel] = Math.round(encoded * 255);
        }
      }
    }
  });
  return Buffer.concat([Buffer.from(`P6\n${WIDTH * panels.length} ${HEIGHT}\n255\n`), pixels]);
}

const outputDirectory = resolve(process.argv[2] ?? 'artifacts/pane-shadow-visibility');
mkdirSync(outputDirectory, { recursive: true });
const settings = { 'pane blocks shadow rays': {}, 'pane with shadow rays off': { rayVisibility: { shadow: false } } };
// The sun is a small bright source that only a shadow ray can find, so the sky-only room tests the soft light and the sun room the hard one.
const suns = {
  'sky only': { keyColor: [0, 0, 0], lightDirection: [0, 1, 0] },
  'sky and sun': { keyColor: [6, 5.6, 5], lightDirection: [-0.35, 0.55, -0.75] },
};
const report = { width: WIDTH, height: HEIGHT, bounces: BOUNCES, referenceSamples: REFERENCE_SAMPLES, relativeMseFloor: RELATIVE_MSE_FLOOR, lighting: {} };
const panels = [];
for (const [lightingName, sun] of Object.entries(suns)) {
  report.lighting[lightingName] = {};
  for (const [name, paneExtra] of Object.entries(settings)) {
    const reference = render(paneExtra, REFERENCE_SAMPLES, 1000, sun);
    const entry = { referenceMeanRadiance: meanRadiance(reference), samples: {} };
    const rendered = [];
    for (const samples of SAMPLE_COUNTS) {
      const startedAt = performance.now();
      const rgba = render(paneExtra, samples, 7, sun);
      entry.samples[samples] = { meanRadiance: meanRadiance(rgba), relativeMse: relativeMeanSquaredError(rgba, reference), seconds: (performance.now() - startedAt) / 1000 };
      rendered.push(rgba);
    }
    report.lighting[lightingName][name] = entry;
    if (lightingName === 'sky and sun') panels.push(...rendered, reference);
  }
}
writeFileSync(join(outputDirectory, 'pane-shadow-visibility.json'), JSON.stringify(report, null, 2));
// Panels of the sky and sun room: blocked 64, 512, reference, then shadow off 64, 512, reference.
writeFileSync(join(outputDirectory, 'pane-shadow-visibility.ppm'), toPpmPanel(panels));
console.log(JSON.stringify(report, null, 2));
