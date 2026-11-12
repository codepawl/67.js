// Renders N copies of one small mesh through the native "cycles" kernel, either as shared instances or flattened into one
// triangle soup, and writes the linear RGBA floats beside a JSON report. Usage:
//   node bench/instancing/render-copies.mjs <instanced|flattened> <output folder> [copies] [width] [height] [samples] [variant] [seed] [kernel]
// kernel is "cycles" (default) or "legacy"; legacy reads the flattened scene only.
// A variant sets how the copies are placed: translate (default), rotscale (rotated, non-uniform scale), mirror (negative
// determinant), mirror-rotscale, or emissive (translate, with one emissive material).
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildNativeInputV2, traceNative } from '../../packages/render-native/index.mjs';
import { buildNativeInput } from '../../packages/render-native/pack-input.mjs';
import * as pack from '../../src/path-tracer-gpu-pack.js';
import { buildCopyScene } from './copies-scene.mjs';
import { createCamera } from '../../src/path-tracer.js';
import { buildTraceScene } from '../../src/path-tracer-scene.js';

const [mode, outputFolder, copiesText = '1000', widthText = '160', heightText = '120', samplesText = '64', variant = 'translate', seedText = '1', kernel = 'cycles'] = process.argv.slice(2);
if (mode !== 'instanced' && mode !== 'flattened') throw new RangeError('Pass "instanced" or "flattened" as the first argument.');
const copyCount = Number(copiesText);
const width = Number(widthText);
const height = Number(heightText);
const samples = Number(samplesText);
const seed = Number(seedText);

const { geometry, parts, environment } = buildCopyScene(variant, copyCount);
const camera = createCamera({ eye: [0, 0, 14], target: [0, 0, -3], fov: 50 }, width, height);

const packStarted = performance.now();
const scene = buildTraceScene(parts, environment, { instancing: mode === 'instanced' });
const packOptions = { width, height, samples, seed };
const input = kernel === 'legacy' ? buildNativeInput(scene, camera, packOptions, pack) : buildNativeInputV2(scene, camera, packOptions);
const packSeconds = (performance.now() - packStarted) / 1000;
const traced = traceNative(input, { width, height, samples, kernel });
const kernelSuffix = kernel === 'cycles' ? '' : `-${kernel}`;
const stem = `${variant}-${mode}-seed${seed}${kernelSuffix}`;

mkdirSync(outputFolder, { recursive: true });
writeFileSync(`${outputFolder}/${stem}.f32`, Buffer.from(traced.rgba.buffer, traced.rgba.byteOffset, traced.rgba.byteLength));
const report = {
  mode, variant, seed, kernel, copyCount, width, height, samples, adapter: traced.adapter, packSeconds,
  instanceCount: input.instanceCount, triangleCount: input.triangleCount, geometryTriangles: geometry.indices.length / 3,
  trianglesBytes: input.triangles.byteLength, instancesBytes: input.instances.byteLength,
  setupSeconds: traced.setupSeconds, accelerationBuildSeconds: traced.accelerationBuildSeconds, uploadSeconds: traced.uploadSeconds,
};
writeFileSync(`${outputFolder}/${stem}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
