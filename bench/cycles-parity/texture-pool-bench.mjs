// Cost of a scene with many textures on the native Cycles host: pack time, setup, compile and upload seconds, and the
// peak resident memory of this process (one scene per process, so the peak is the scene's).
//   node bench/cycles-parity/texture-pool-bench.mjs [--textures 256] [--size 512]
// Prints one JSON line. A scene whose textures do not fit one pool prints the error text instead of a trace.
import { buildNativeInputV2, findNativeAddon, traceNative } from '../../packages/render-native/index.mjs';
import { createCamera } from '../../src/path-tracer.js';

const IMAGE_WIDTH = 64;
const IMAGE_HEIGHT = 36;

function readNumberFlag(flagName, fallbackValue) {
  const flagIndex = process.argv.indexOf(flagName);
  if (flagIndex === -1) {
    return fallbackValue;
  }
  const parsed = Number(process.argv[flagIndex + 1]);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new RangeError(`Flag ${flagName} must be a positive integer, got ${process.argv[flagIndex + 1]}.`);
  }
  return parsed;
}

function quadGeometry() {
  return {
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function noiseImage(size, seed) {
  const data = new Uint8Array(size * size * 4);
  let state = (seed * 2654435761) >>> 0;
  for (let index = 0; index < data.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[index] = state >>> 24;
  }
  return { width: size, height: size, data };
}

function buildScene(textureCount, size) {
  const columns = Math.ceil(Math.sqrt(textureCount));
  const geometry = quadGeometry();
  const materials = [];
  const instances = [];
  for (let index = 0; index < textureCount; index++) {
    materials.push({ color: [1, 1, 1], roughness: 0.7, map: { image: noiseImage(size, index + 1), colorSpace: 'srgb' } });
    const column = index % columns;
    const row = Math.floor(index / columns);
    const matrix = [0.45, 0, 0, 0, 0, 0.45, 0, 0, 0, 0, 1, 0, (column - columns / 2) * 1.0, (row - columns / 2) * 1.0, 0, 1];
    instances.push({ geometry, matrix, materialIndex: index });
  }
  return { materials, instances, lights: { points: [{ position: [0, 0, 10], color: [1, 1, 1], intensity: 400, radius: 0.1 }] } };
}

function run() {
  const textureCount = readNumberFlag('--textures', 256);
  const size = readNumberFlag('--size', 512);
  const report = { textures: textureCount, size, poolMebibytes: (textureCount * size * size * 4) / (1 << 20) };
  if (!findNativeAddon()) {
    console.log(JSON.stringify({ ...report, skipped: 'no native addon' }));
    return;
  }
  const camera = createCamera({ eye: [0, 0, 24], target: [0, 0, 0], fov: 50 }, IMAGE_WIDTH, IMAGE_HEIGHT);
  const packStarted = performance.now();
  const input = buildScene(textureCount, size);
  let nativeInput;
  try {
    nativeInput = buildNativeInputV2(input, camera, { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, samples: 1 });
  } catch (error) {
    console.log(JSON.stringify({ ...report, stage: 'pack', error: error.message }));
    return;
  }
  report.packSeconds = (performance.now() - packStarted) / 1000;
  const traceStarted = performance.now();
  try {
    const result = traceNative(nativeInput, { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, samples: 1, kernel: 'cycles' });
    report.traceWallSeconds = (performance.now() - traceStarted) / 1000;
    report.setupSeconds = result.setupSeconds;
    report.compileSeconds = result.compileSeconds;
    report.uploadSeconds = result.uploadSeconds;
    report.adapter = result.adapter;
  } catch (error) {
    report.stage = 'trace';
    report.error = error.message;
  }
  report.peakRssMebibytes = process.resourceUsage().maxRSS / 1024;
  console.log(JSON.stringify(report));
}

run();
