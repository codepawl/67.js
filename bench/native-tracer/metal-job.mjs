// The frame step of a native render job on the `metal` reference scene: the same chooseDenoiser and traceFrameNative calls the
// job runner makes, fed with the tables the job page would export, so the kernel, noiseThreshold and denoiser defaults can be
// measured without a browser. Writes a PNG and a linear .npy per run for bench/cycles-parity score scripts.
//   node bench/native-tracer/metal-job.mjs <output directory> [--samples 256] [--noise-threshold 0] [--kernel cycles|legacy] [--denoise true|false|oidn|wavelet|none]
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCamera } from '../../src/path-tracer.js';
import * as packModule from '../../src/path-tracer-gpu-pack.js';
import { buildTraceScene } from '../../src/path-tracer-scene.js';
import { buildNativeInput } from '../../packages/render-native/pack-input.mjs';
import * as renderNative from '../../packages/render-native/index.mjs';
import { encodeNativeTables } from '../../scripts/native-bake-page.js';
import { chooseDenoiser } from '../../scripts/agent-path-trace-denoise.mjs';
import { traceFrameNative } from '../../scripts/agent-native-trace.mjs';
import { loadReferenceScene } from '../cycles-parity/scene-bridge.mjs';
import { writeFloat32Npy } from '../cycles-parity/npy.mjs';

const WIDTH = 960;
const HEIGHT = 540;
const argumentsGiven = process.argv.slice(2);

function valueAfter(flag, fallback) {
  const index = argumentsGiven.indexOf(flag);
  return index >= 0 ? argumentsGiven[index + 1] : fallback;
}

const outputDirectory = resolve(argumentsGiven[0]);
const samples = Number(valueAfter('--samples', 256));
const noiseThreshold = Number(valueAfter('--noise-threshold', 0));
const kernel = valueAfter('--kernel', 'cycles');
const denoiseArgument = valueAfter('--denoise', 'true');
const requested = denoiseArgument === 'true' ? true : denoiseArgument === 'false' ? false : denoiseArgument;
const label = valueAfter('--label', `${kernel}-${samples}-${String(requested)}`);

const loaded = await loadReferenceScene('metal');
const source = loaded.traceSource;
const options = { width: WIDTH, height: HEIGHT, bounces: 8, seed: 1, fireflyClamp: 20, noiseThreshold };
const input = buildNativeInput(buildTraceScene(source.parts, source.environment), createCamera(source.camera, WIDTH, HEIGHT), options, packModule);
const exported = { tables: encodeNativeTables(input), triangleCount: input.triangleCount, triangles: input.triangleCount, ignored: [] };

let captured;
const tracer = { traceNative(tables, traceOptions) {
  captured = renderNative.traceNative(tables, traceOptions);
  return captured;
} };
const choice = await chooseDenoiser(requested, { preferOidn: true });
const denoise = choice.denoise === true ? 'wavelet' : choice.denoise === false ? 'none' : choice.denoise;
await traceFrameNative({ tracer, exported, width: WIDTH, height: HEIGHT, samples, bounces: 8, seed: 1, denoise, denoiser: choice.denoiser, maxSeconds: 600, noiseThreshold, kernel });
// Warm run above compiles the kernel; the measured run below is the one the report describes.
const measured = await traceFrameNative({ tracer, exported, width: WIDTH, height: HEIGHT, samples, bounces: 8, seed: 1, denoise, denoiser: choice.denoiser, maxSeconds: 600, noiseThreshold, kernel });
const features = { width: WIDTH, height: HEIGHT, color: new Float32Array(WIDTH * HEIGHT * 3), albedo: captured.albedo, normal: new Float32Array(captured.normal), depth: captured.depth, variance: captured.variance };
for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) features.color.set(captured.rgba.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
for (let offset = 0; offset < features.normal.length; offset += 3) {
  const length = Math.hypot(features.normal[offset], features.normal[offset + 1], features.normal[offset + 2]);
  if (length > 1e-6) for (let axis = 0; axis < 3; axis++) features.normal[offset + axis] /= length;
}
let linear = features.color;
if (measured.report.denoiser === 'oidn') linear = await choice.denoiser.denoiseWithOidn(features);
else if (measured.report.denoiser === 'wavelet') linear = (await import('../../src/path-tracer-denoise.js')).denoiseRadiance(features);
await mkdir(outputDirectory, { recursive: true });
await writeFile(`${outputDirectory}/job-${label}.png`, Buffer.from(measured.data, 'base64'));
await writeFloat32Npy(`${outputDirectory}/job-${label}.npy`, linear, [HEIGHT, WIDTH, 3]);
const { gpu, nativeBackend, kernel: ranKernel, averageSamples, noiseThreshold: threshold, denoiser, denoised, tracedSeconds, denoiseSeconds, seconds } = measured.report;
const summary = { label, gpu, nativeBackend, kernel: ranKernel, samples, noiseThreshold: threshold, averageSamples, denoiser, denoised, denoiserNote: choice.note, tracedSeconds, denoiseSeconds, seconds };
await writeFile(`${outputDirectory}/job-${label}.json`, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
