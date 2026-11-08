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

const label = argumentsGiven.includes('--opaque') ? '-opaque' : argumentsGiven.includes('--solid') ? '-solid' : '';
const leafCount = Number(valueAfter('--leaves', 300));
const options = { width: Number(valueAfter('--width', 960)), height: Number(valueAfter('--height', 540)),
  samples: Number(valueAfter('--samples', 64)), bounces: 4, seed: 0, fireflyClamp: 20 };

import { CUTOUT_CAMERA, CUTOUT_ENVIRONMENT, buildCutoutParts } from './cutout-scene.js';

const parts = buildCutoutParts(leafCount, !argumentsGiven.includes('--opaque'), argumentsGiven.includes('--solid'));
const environment = CUTOUT_ENVIRONMENT;
const camera = createCamera(CUTOUT_CAMERA, options.width, options.height);

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(outputDirectory, { recursive: true });
const scene = buildTraceScene(parts, environment);
const nativeStarted = performance.now();
const traced = traceNative(buildNativeInput(scene, camera, options, pack), options);
const nativeSeconds = (performance.now() - nativeStarted) / 1000;
const linear = new Float32Array(options.width * options.height * 3);
for (let pixel = 0; pixel < options.width * options.height; pixel++) linear.set(traced.rgba.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
const toneMapped = toneMapToRgba8(linear, options.width, options.height, { viewTransform: 'aces', look: null });
await writeFile(`${outputDirectory}/cutout-native${label}.png`, encodePng(toneMapped, options.width, options.height));

const cpuStarted = performance.now();
const reference = await renderPathTracedImage({ parts, environment, camera: CUTOUT_CAMERA },
  { ...options, backend: 'cpu', denoise: false, threads: 8, maxSeconds: 1800 });
const cpuSeconds = (performance.now() - cpuStarted) / 1000;
await writeFile(`${outputDirectory}/cutout-cpu${label}.png`, encodePng(reference.rgba, options.width, options.height));

const record = { ...options, leafCards: leafCount, triangles: scene.indices.length / 3, nativeSeconds, nativeTracedSeconds: traced.tracedSeconds, cpuSeconds, adapter: traced.adapter };
await writeFile(`${outputDirectory}/cutout.json`, JSON.stringify(record, null, 1));
console.log(JSON.stringify(record));
