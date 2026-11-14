// Times renderer.updateParts for matrix-only and colour-only updates: node scripts/benchmark-update-parts.mjs [partCount] [rounds]
// The renderer is built without a GL context and the buffer upload is a no-op, so the number is JavaScript time only.
import { constants, setPriority } from 'node:os';
import { mat3, mat4 } from 'gl-matrix';
import { box } from '../src/geometry.js';
import { CrucibleRenderer, groupParts } from '../src/renderer.js';
import { materialLayerState } from '../src/material-layers.js';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const partCount = Number(process.argv[2] ?? 25000);
const rounds = Number(process.argv[3] ?? 30);
const INSTANCE_STRIDE = 41;

function createParts(count) {
  const geometry = box();
  return Array.from({ length: count }, (_, index) => ({
    name: `part-${index}`,
    geometry,
    matrix: mat4.fromTranslation(mat4.create(), [index % 100, 0, Math.floor(index / 100)]),
    material: { color: [0.4, 0.5, 0.6], metallic: 0, roughness: 0.7, emission: 0 },
  }));
}

function createRenderer(parts) {
  const renderer = Object.create(CrucibleRenderer.prototype);
  renderer.context = { ARRAY_BUFFER: 34962, bindBuffer() {}, bufferSubData() {} };
  renderer.updateSkins = new Set();
  renderer.updateBatches = new Set();
  renderer.partLocations = new Map();
  renderer.batches = groupParts(parts).map(group => {
    const first = group[0];
    const batch = {
      instanceBuffer: {}, instanceData: new Float32Array(group.length * INSTANCE_STRIDE), castShadow: true,
      alphaMode: 'opaque', alphaCutoff: 0, opacity: 1, doubleSided: false,
    };
    group.forEach((part, index) => renderer.partLocations.set(part, {
      batch, index, geometry: first.geometry, skin: null, map: null, layerState: materialLayerState({}),
      mapState: [null, null, null, null, null, 1, 1, 1, 0, 0.05, 0.085, 0.02], normalMatrix: mat3.create(),
    }));
    return batch;
  });
  return renderer;
}

function measure(label, parts, renderer, change) {
  const samples = [];
  for (let round = 0; round < rounds + 5; round++) {
    change(round);
    const started = performance.now();
    renderer.updateParts(parts, { shadows: false });
    samples.push(performance.now() - started);
  }
  const kept = samples.slice(5).sort((a, b) => a - b);
  console.log(`${label}: ${partCount} parts, min ${kept[0].toFixed(2)} ms, median ${kept[kept.length >> 1].toFixed(2)} ms, max ${kept.at(-1).toFixed(2)} ms (${(kept[kept.length >> 1] * 1000 / partCount).toFixed(2)} us per part)`);
}

const parts = createParts(partCount);
const renderer = createRenderer(parts);
measure('matrix only', parts, renderer, round => parts.forEach(part => { part.matrix[12] += 0.01 * (round + 1); }));
measure('matrix and colour', parts, renderer, round => parts.forEach(part => { part.matrix[12] += 0.01; part.material.color[0] = (round % 10) / 10; }));
