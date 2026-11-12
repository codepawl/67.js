// Renders N copies of one small mesh through the native "cycles" kernel, either as shared instances or flattened into one
// triangle soup, and writes the linear RGBA floats beside a JSON report. Usage:
//   node bench/instancing/render-copies.mjs <instanced|flattened> <output folder> [copies] [width] [height] [samples]
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildNativeInputV2, traceNative } from '../../packages/render-native/index.mjs';
import { createCamera } from '../../src/path-tracer.js';
import { buildTraceScene } from '../../src/path-tracer-scene.js';

const [mode, outputFolder, copiesText = '1000', widthText = '160', heightText = '120', samplesText = '64'] = process.argv.slice(2);
if (mode !== 'instanced' && mode !== 'flattened') throw new RangeError('Pass "instanced" or "flattened" as the first argument.');
const copyCount = Number(copiesText);
const width = Number(widthText);
const height = Number(heightText);
const samples = Number(samplesText);

function midpoint(positions, first, second) {
  return [0, 1, 2].map(axis => (positions[first * 3 + axis] + positions[second * 3 + axis]) / 2);
}

// An icosphere: 20 triangles, each split in four per level, so level 2 has 320.
function icosphere(levels) {
  const golden = (1 + Math.sqrt(5)) / 2;
  let positions = [-1, golden, 0, 1, golden, 0, -1, -golden, 0, 1, -golden, 0, 0, -1, golden, 0, 1, golden, 0, -1, -golden, 0, 1, -golden, golden, 0, -1, golden, 0, 1, -golden, 0, -1, -golden, 0, 1];
  let indices = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  for (let level = 0; level < levels; level++) {
    const next = [];
    const cache = new Map();
    const middle = (first, second) => {
      const key = first < second ? `${first}:${second}` : `${second}:${first}`;
      if (!cache.has(key)) {
        cache.set(key, positions.length / 3);
        positions = positions.concat(midpoint(positions, first, second));
      }
      return cache.get(key);
    };
    for (let triangle = 0; triangle < indices.length; triangle += 3) {
      const [a, b, c] = indices.slice(triangle, triangle + 3);
      const ab = middle(a, b);
      const bc = middle(b, c);
      const ca = middle(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    indices = next;
  }
  const unit = new Float32Array(positions.length);
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const length = Math.hypot(positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]);
    for (let axis = 0; axis < 3; axis++) unit[vertex * 3 + axis] = positions[vertex * 3 + axis] / length;
  }
  return { positions: unit, normals: Float32Array.from(unit), indices: Uint32Array.from(indices) };
}

const MATERIALS = [
  { color: [0.8, 0.25, 0.2], roughness: 0.5 },
  { color: [0.2, 0.6, 0.85], roughness: 0.3, metallic: 0.8 },
  { color: [0.85, 0.8, 0.3], roughness: 0.7 },
];

function buildParts(geometry) {
  const side = Math.ceil(Math.cbrt(copyCount));
  return Array.from({ length: copyCount }, (_, index) => {
    const column = index % side;
    const row = Math.floor(index / side) % side;
    const layer = Math.floor(index / (side * side));
    const scale = 0.3 + 0.1 * ((index * 7) % 5) / 4;
    // Every seventh copy is mirrored, which flips the winding and exercises the negative-scale flag.
    const mirror = index % 7 === 0 ? -1 : 1;
    const matrix = [scale * mirror, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, (column - side / 2) * 1.1, (row - side / 2) * 1.1, -layer * 1.1, 1];
    return { name: `copy-${index}`, geometry, matrix, material: MATERIALS[index % MATERIALS.length] };
  });
}

const geometry = icosphere(2);
const parts = buildParts(geometry);
const environment = { keyColor: [3, 3, 3], lightDirection: [0.4, 0.8, 0.5] };
const camera = createCamera({ eye: [0, 0, 14], target: [0, 0, -3], fov: 50 }, width, height);

const packStarted = performance.now();
const scene = buildTraceScene(parts, environment, { instancing: mode === 'instanced' });
const input = buildNativeInputV2(scene, camera, { width, height, samples, seed: 1 });
const packSeconds = (performance.now() - packStarted) / 1000;
const traced = traceNative(input, { width, height, samples, kernel: 'cycles' });

mkdirSync(outputFolder, { recursive: true });
writeFileSync(`${outputFolder}/${mode}.f32`, Buffer.from(traced.rgba.buffer, traced.rgba.byteOffset, traced.rgba.byteLength));
const report = {
  mode, copyCount, width, height, samples, adapter: traced.adapter, packSeconds,
  instanceCount: input.instanceCount, triangleCount: input.triangleCount, geometryTriangles: geometry.indices.length / 3,
  trianglesBytes: input.triangles.byteLength, instancesBytes: input.instances.byteLength,
  setupSeconds: traced.setupSeconds, accelerationBuildSeconds: traced.accelerationBuildSeconds, uploadSeconds: traced.uploadSeconds,
};
writeFileSync(`${outputFolder}/${mode}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
