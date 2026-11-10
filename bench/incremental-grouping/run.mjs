// Measures the grouping step of replaceParts for a world that arrives in growing prefixes (issue 779):
// groupParts over every prefix against groupPartsIncrementally with the state kept between slices.
// Usage: node bench/incremental-grouping/run.mjs [--runs 5]
// Times depend on machine load, so the report gives the range over the runs.
import { groupParts, groupPartsIncrementally } from '../../src/renderer.js';

const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 5;
const partCount = 100000;
const geometryCount = 2000;
const sliceCount = 20;

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const geometries = Array.from({ length: geometryCount }, () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
}));
const materials = Array.from({ length: 8 }, (_, index) => ({ color: [index / 8, 0.5, 0.5], metallic: 0, roughness: 0.5, emission: 0 }));
const partsPerGeometry = partCount / geometryCount;
const parts = Array.from({ length: partCount }, (_, index) => ({
  name: `part ${index}`,
  geometry: geometries[Math.floor(index / partsPerGeometry)],
  matrix: identity(),
  material: materials[index % materials.length],
}));
const sliceSize = partCount / sliceCount;

function timeSlices(groupPrefix) {
  const durations = [];
  for (let end = sliceSize; end <= partCount; end += sliceSize) {
    const prefix = parts.slice(0, end);
    const start = performance.now();
    groupPrefix(prefix);
    durations.push(performance.now() - start);
  }
  return { totalMs: durations.reduce((sum, value) => sum + value, 0), worstSliceMs: Math.max(...durations) };
}

function range(samples, key) {
  const values = samples.map(sample => Math.round(sample[key]));
  return `${Math.min(...values)} to ${Math.max(...values)}`;
}

const full = [];
const incremental = [];
for (let run = 0; run < runs; run++) {
  full.push(timeSlices(prefix => groupParts(prefix)));
  let state = null;
  incremental.push(timeSlices((prefix) => {
    const grouped = groupPartsIncrementally(state, prefix);
    state = grouped.state;
  }));
}
console.log(JSON.stringify({
  parts: partCount,
  geometries: geometryCount,
  slices: sliceCount,
  runs,
  fullTotalMs: range(full, 'totalMs'),
  fullWorstSliceMs: range(full, 'worstSliceMs'),
  incrementalTotalMs: range(incremental, 'totalMs'),
  incrementalWorstSliceMs: range(incremental, 'worstSliceMs'),
}, null, 2));
