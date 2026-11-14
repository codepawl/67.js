// Two checks of the instancing export, run from the root of one source tree:
//   node bench/instancing/instancing-checks.mjs identity <output json>
//     SHA-256 of every packed table and of the traced pixels for scenes without shared geometry (and of an instanced scene
//     packed as before), so the same file from two trees can be compared. Pass `--pack-only` to skip the traces.
//   node bench/instancing/instancing-checks.mjs equivalence <output json> [copies] [samples]
//     Instanced against flattened renders: mean ratio, relative MSE (epsilon 0.01) and the 8x8 tiles within 5 percent.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { buildNativeInputV2, findNativeAddon, traceNative } from '@codepawlhq/cook';
import { buildNativeInput, buildNativeTexelInput } from '@codepawlhq/cook/pack-input';
import { buildCopyScene } from './copies-scene.mjs';
import { meanRatioRgb, relativeMeanSquaredError, tileMeanRatios } from './image-compare.mjs';
import { createCamera } from '../../src/path-tracer.js';
import * as pack from '../../src/path-tracer-gpu-pack.js';
import { buildTraceScene } from '../../src/path-tracer-scene.js';

const [mode, outputPath, ...rest] = process.argv.slice(2);
const packOnly = rest.includes('--pack-only');
const numbers = rest.filter(argument => !argument.startsWith('--')).map(Number);

function hashBytes(values) {
  return createHash('sha256').update(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)).digest('hex');
}

function hashTables(input) {
  const hashes = {};
  for (const [name, value] of Object.entries(input)) {
    if (ArrayBuffer.isView(value)) hashes[name] = hashBytes(value);
    else if (typeof value === 'number') hashes[name] = value;
  }
  return hashes;
}

// The same copies, each on a geometry object of its own, so no geometry is shared.
function withDistinctGeometry(parts) {
  return parts.map(part => ({
    ...part,
    geometry: { ...part.geometry, positions: Float32Array.from(part.geometry.positions) },
  }));
}

function traceHash(input, kernel, width, height) {
  try {
    const traced = traceNative(input, { width, height, samples: 16, kernel });
    return { hash: hashBytes(traced.rgba), adapter: traced.adapter };
  } catch (error) {
    return { skipped: error.message.split('\n')[0] };
  }
}

function identityScenes() {
  const width = 48;
  const height = 32;
  const camera = createCamera({ eye: [0, 0, 14], target: [0, 0, -3], fov: 50 }, width, height);
  const options = { width, height, samples: 16, seed: 1 };
  const report = {};
  for (const variant of ['translate', 'rotscale', 'emissive']) {
    const { parts, environment } = buildCopyScene(variant, 12);
    const flattened = buildTraceScene(parts, environment);
    const unshared = buildTraceScene(withDistinctGeometry(parts), environment, { instancing: true });
    const instanced = buildTraceScene(parts, environment, { instancing: true });
    const inputs = {
      flattenedV1: buildNativeInput(flattened, camera, options, pack),
      flattenedV2: buildNativeInputV2(flattened, camera, options),
      unsharedV2: buildNativeInputV2(unshared, camera, options),
      instancedV2: buildNativeInputV2(instanced, camera, options),
    };
    const entry = { sceneWithoutSharing: unshared.instances === undefined };
    for (const [name, input] of Object.entries(inputs)) entry[name] = hashTables(input);
    // The light bake shares the v1 material tables.
    entry.texelV1 = hashTables(buildNativeTexelInput(flattened, { texelCount: 64, samples: 4, bounces: 3, seed: 1, fireflyClamp: 20 }, pack));
    if (!packOnly && findNativeAddon()) {
      entry.trace = {
        legacyFlattenedV1: traceHash(inputs.flattenedV1, 'legacy', width, height),
        cyclesFlattenedV1: traceHash(inputs.flattenedV1, 'cycles', width, height),
        cyclesFlattenedV2: traceHash(inputs.flattenedV2, 'cycles', width, height),
        cyclesInstancedV2: traceHash(inputs.instancedV2, 'cycles', width, height),
      };
    }
    report[variant] = entry;
  }
  return report;
}

function render(variant, instancing, copies, samples, width, height) {
  const { parts, environment } = buildCopyScene(variant, copies);
  const camera = createCamera({ eye: [0, 0, 14], target: [0, 0, -3], fov: 50 }, width, height);
  const scene = buildTraceScene(parts, environment, { instancing });
  const input = buildNativeInputV2(scene, camera, { width, height, samples, seed: 1 });
  const traced = traceNative(input, { width, height, samples, kernel: 'cycles' });
  return { rgba: traced.rgba, adapter: traced.adapter, triangleCount: input.triangleCount, instanceCount: input.instanceCount };
}

function equivalenceReport(copies, samples) {
  const width = 128;
  const height = 96;
  const report = {};
  for (const variant of ['translate', 'rotscale', 'emissive', 'emissive-rotscale', 'emissive-degenerate']) {
    const flattened = render(variant, false, copies, samples, width, height);
    const instanced = render(variant, true, copies, samples, width, height);
    const ratios = tileMeanRatios(instanced.rgba, flattened.rgba, width, height, 8);
    report[variant] = {
      adapter: instanced.adapter,
      copies,
      samples,
      flattenedTriangles: flattened.triangleCount,
      instancedTriangles: instanced.triangleCount,
      meanRatioRgb: meanRatioRgb(instanced.rgba, flattened.rgba, width * height).map(value => Number(value.toFixed(4))),
      relativeMse: Number(relativeMeanSquaredError(instanced.rgba, flattened.rgba, width * height, 0.01).toPrecision(3)),
      tilesWithin5Percent: ratios.filter(ratio => Math.abs(ratio - 1) <= 0.05).length,
      eligibleTiles: ratios.length,
    };
  }
  return report;
}

if (mode !== 'identity' && mode !== 'equivalence') throw new RangeError('Pass "identity" or "equivalence" as the first argument, then an output path.');
if (!outputPath) throw new RangeError('Pass the output JSON path as the second argument.');
const result = mode === 'identity' ? identityScenes() : equivalenceReport(numbers[0] ?? 200, numbers[1] ?? 1024);
writeFileSync(outputPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
