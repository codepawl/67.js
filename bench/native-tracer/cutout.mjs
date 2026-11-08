// Alpha cutouts on the native tracer: a ground plane under a few hundred masked leaf cards (a green disc in a transparent
// square, alphaMode "mask") is traced by the native ray query tracer and by the CPU tracer, the reference that has always
// stepped through cutouts. Run it through gpu-lock.
//   node bench/native-tracer/cutout.mjs <output directory> [--leaves 300] [--samples 64] [--width 960] [--height 540]
// Writes cutout-native.png, cutout-cpu.png and cutout.json (seconds); score the pair with bench/webgpu-tracer/flip.py.
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { buildNativeInput, traceNative } from '../../packages/render-native/index.mjs';
import { encodePng } from '../../src/export-png.js';
import * as pack from '../../src/path-tracer-gpu-pack.js';
import { createCamera, renderPathTracedImage, toneMapToRgba8 } from '../../src/path-tracer.js';
import { buildTraceScene } from '../../src/path-tracer-scene.js';

const argumentsGiven = process.argv.slice(2);
const outputDirectory = resolve(argumentsGiven[0]);

function valueAfter(flag, fallback) {
  const index = argumentsGiven.indexOf(flag);
  return index >= 0 ? argumentsGiven[index + 1] : fallback;
}

const leafCount = Number(valueAfter('--leaves', 300));
const options = { width: Number(valueAfter('--width', 960)), height: Number(valueAfter('--height', 540)),
  samples: Number(valueAfter('--samples', 64)), bounces: 4, seed: 0, fireflyClamp: 20 };

const TEXTURE_SIZE = 64;

// A green disc in a transparent square: texels outside the disc have alpha 0, so a cutout that is ignored shows squares.
function leafTexture() {
  const data = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let row = 0; row < TEXTURE_SIZE; row++) {
    for (let column = 0; column < TEXTURE_SIZE; column++) {
      const offsetX = (column + 0.5) / TEXTURE_SIZE - 0.5;
      const offsetY = (row + 0.5) / TEXTURE_SIZE - 0.5;
      const inside = Math.hypot(offsetX, offsetY) < 0.45;
      data.set([60, 170, 70, inside ? 255 : 0], (row * TEXTURE_SIZE + column) * 4);
    }
  }
  return { image: { data, width: TEXTURE_SIZE, height: TEXTURE_SIZE }, colorSpace: 'srgb', wrapS: 33071 };
}

function quad(center, along, across, size) {
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([first, second]) => center.map((value, axis) => value + (along[axis] * first + across[axis] * second) * size));
  const normal = [along[1] * across[2] - along[2] * across[1], along[2] * across[0] - along[0] * across[2], along[0] * across[1] - along[1] * across[0]];
  return {
    positions: new Float32Array(corners.flat()),
    normals: new Float32Array([...normal, ...normal, ...normal, ...normal]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

let randomState = 12345;
function random() {
  randomState = (randomState * 1664525 + 1013904223) >>> 0;
  return randomState / 4294967296;
}

function tiltedAxes() {
  const angle = random() * Math.PI * 2;
  const tilt = (random() - 0.5) * 1.6;
  const along = [Math.cos(angle), 0, Math.sin(angle)];
  const across = [-Math.sin(angle) * Math.cos(tilt), Math.sin(tilt), Math.cos(angle) * Math.cos(tilt)];
  return { along, across };
}

const texture = leafTexture();
const parts = [{ name: 'ground', geometry: quad([0, 0, 0], [1, 0, 0], [0, 0, -1], 8), material: { color: [0.6, 0.55, 0.45], roughness: 0.9 } }];
for (let leaf = 0; leaf < leafCount; leaf++) {
  const { along, across } = tiltedAxes();
  const center = [(random() - 0.5) * 5, 0.2 + random() * 1.6, (random() - 0.5) * 5];
  parts.push({ name: `leaf-${leaf}`, geometry: quad(center, along, across, 0.35),
    material: { color: [1, 1, 1], roughness: 0.7, map: texture, alphaMode: 'mask', alphaCutoff: 0.5 } });
}
const environment = { keyColor: [3, 2.8, 2.5], lightDirection: [0.4, 0.8, 0.35], pointLights: [], areaLights: [], skyColor: [0.5, 0.6, 0.8], skyIntensity: 0.6 };
const camera = createCamera({ eye: [0, 3.2, 6], target: [0, 0.8, 0], fov: 45 }, options.width, options.height);

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(outputDirectory, { recursive: true });
const scene = buildTraceScene(parts, environment);
const nativeStarted = performance.now();
const traced = traceNative(buildNativeInput(scene, camera, options, pack), options);
const nativeSeconds = (performance.now() - nativeStarted) / 1000;
const linear = new Float32Array(options.width * options.height * 3);
for (let pixel = 0; pixel < options.width * options.height; pixel++) linear.set(traced.rgba.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
const toneMapped = toneMapToRgba8(linear, options.width, options.height, { viewTransform: 'aces', look: null });
await writeFile(`${outputDirectory}/cutout-native.png`, encodePng(toneMapped, options.width, options.height));

const cpuStarted = performance.now();
const reference = await renderPathTracedImage({ parts, environment, camera: { eye: [0, 3.2, 6], target: [0, 0.8, 0], fov: 45 } },
  { ...options, backend: 'cpu', denoise: false, threads: 8, maxSeconds: 1800 });
const cpuSeconds = (performance.now() - cpuStarted) / 1000;
await writeFile(`${outputDirectory}/cutout-cpu.png`, encodePng(reference.rgba, options.width, options.height));

const record = { ...options, leafCards: leafCount, triangles: scene.indices.length / 3, nativeSeconds, nativeTracedSeconds: traced.tracedSeconds, cpuSeconds, adapter: traced.adapter };
await writeFile(`${outputDirectory}/cutout.json`, JSON.stringify(record, null, 1));
console.log(JSON.stringify(record));
