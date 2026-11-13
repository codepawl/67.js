// Times one Cook render under three dispatch settings on a terrain of a few hundred thousand triangles: the default
// whole-image dispatches and `dispatchBudgetMs` 8 and 4 (issue 1124). Prints one JSON object and writes it to the file given
// as the first argument. Needs the native addon and a GPU: run it on a machine where nothing else uses the card.
//
//   node scripts/benchmark-native-dispatch-budget.mjs artifacts/dispatch-budget-bench.json [width height samples grid]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildNativeInputV2, createNativeSession } from '@codepawlhq/cook';
import { createCamera } from '../src/path-tracer.js';

const [outputPath = 'artifacts/dispatch-budget-bench.json', widthText = '1920', heightText = '1080', samplesText = '64', gridText = '320'] =
  process.argv.slice(2);
const WIDTH = Number(widthText);
const HEIGHT = Number(heightText);
const SAMPLES = Number(samplesText);
const GRID_CELLS = Number(gridText);
const BOUNCES = 8;

// A rolling terrain: GRID_CELLS x GRID_CELLS quads, two triangles each.
function buildTerrain(gridCells) {
  const vertexSide = gridCells + 1;
  const positions = new Float32Array(vertexSide * vertexSide * 3);
  const normals = new Float32Array(vertexSide * vertexSide * 3);
  const uvs = new Float32Array(vertexSide * vertexSide * 2);
  const heightAt = (x, z) => 0.35 * Math.sin(x * 1.7) * Math.cos(z * 1.3) + 0.15 * Math.sin(x * 5.1 + z * 4.3);
  for (let row = 0; row < vertexSide; row += 1) {
    for (let column = 0; column < vertexSide; column += 1) {
      const x = (column / gridCells - 0.5) * 12;
      const z = (row / gridCells - 0.5) * 12;
      const slot = row * vertexSide + column;
      positions.set([x, heightAt(x, z), z], slot * 3);
      const step = 0.01;
      const slopeX = (heightAt(x + step, z) - heightAt(x - step, z)) / (2 * step);
      const slopeZ = (heightAt(x, z + step) - heightAt(x, z - step)) / (2 * step);
      const length = Math.hypot(slopeX, 1, slopeZ);
      normals.set([-slopeX / length, 1 / length, -slopeZ / length], slot * 3);
      uvs.set([column / gridCells, row / gridCells], slot * 2);
    }
  }
  const indices = new Uint32Array(gridCells * gridCells * 6);
  let cursor = 0;
  for (let row = 0; row < gridCells; row += 1) {
    for (let column = 0; column < gridCells; column += 1) {
      const topLeft = row * vertexSide + column;
      const bottomLeft = topLeft + vertexSide;
      indices.set([topLeft, bottomLeft, topLeft + 1, topLeft + 1, bottomLeft, bottomLeft + 1], cursor);
      cursor += 6;
    }
  }
  return { positions, normals, uvs, colors: new Float32Array(vertexSide * vertexSide * 3).fill(1), indices };
}

const LIGHT_QUAD = {
  positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  colors: new Float32Array(12).fill(1),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

const terrain = buildTerrain(GRID_CELLS);
const scene = {
  materials: [{ color: [0.55, 0.5, 0.42], roughness: 0.7 }, { color: [1, 0.95, 0.9], emission: 12, roughness: 1 }],
  instances: [
    { geometry: terrain, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], materialIndex: 0 },
    { geometry: LIGHT_QUAD, matrix: [2, 0, 0, 0, 0, 0, -2, 0, 0, 2, 0, 0, 1, 4, -1, 1], materialOverride: 1 },
  ],
};
const camera = createCamera({ eye: [0, 1.8, 6.5], target: [0, 0.2, 0], fov: 50 }, WIDTH, HEIGHT);
const imageOptions = { width: WIDTH, height: HEIGHT, samples: SAMPLES, bounces: BOUNCES, seed: 7 };
const input = buildNativeInputV2(scene, camera, imageOptions);
const session = createNativeSession(input, imageOptions);

function timeRender(label, extraOptions) {
  const started = performance.now();
  const result = session.render({ samples: SAMPLES, ...extraOptions });
  const wallSeconds = (performance.now() - started) / 1000;
  return {
    label,
    wallSeconds,
    tracedSeconds: result.tracedSeconds,
    longestDispatchSeconds: result.longestDispatchSeconds ?? null,
    dispatchCount: result.dispatchCount ?? null,
    samplesPerDispatch: result.samplesPerDispatch ?? null,
    smallestTilePixels: result.smallestTilePixels ?? null,
    largestTilePixels: result.largestTilePixels ?? null,
    rgba: result.rgba,
  };
}

// A one-sample frame first: it compiles the kernel and warms the card, so no timed run pays for either.
session.render({ samples: 1 });
const runs = [
  timeRender('auto', {}),
  timeRender('dispatchBudgetMs 8', { dispatchBudgetMs: 8 }),
  timeRender('dispatchBudgetMs 4', { dispatchBudgetMs: 4 }),
  timeRender('auto again', {}),
  timeRender('dispatchBudgetMs 8 again', { dispatchBudgetMs: 8 }),
];
const reference = runs[0].rgba;
const report = {
  scene: { triangles: terrain.indices.length / 3 + 2, width: WIDTH, height: HEIGHT, samples: SAMPLES, bounces: BOUNCES },
  runs: runs.map(({ rgba, ...measurements }) => ({
    ...measurements,
    sameBytesAsAuto: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength).equals(
      Buffer.from(reference.buffer, reference.byteOffset, reference.byteLength)
    ),
  })),
};
session.close();
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
