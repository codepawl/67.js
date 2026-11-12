// SHA-256 of the pictures of scenes whose parts carry equal materials, traced on both native kernels (#1100). Run it on a build before
// the change that gives equal material records one record and on the build after it, and compare the hashes: the pictures must be
// equal. The number of material records is printed beside each hash and is expected to differ.
//   node bench/cycles-parity/native-shared-record-identity.mjs
import { createHash } from 'node:crypto';
import * as pack from '../../src/path-tracer-gpu-pack.js';
import { buildNativeInput } from '../../packages/render-native/pack-input.mjs';
import { buildFlattenedJobNativeInput, buildJobNativeInput } from '../../packages/render-native/job-input.mjs';
import { buildTraceScene, refuseLocalVolumes, resolveTexture } from '../../src/path-tracer-scene.js';
import { buildNativeInputV2, traceNative } from '../../packages/render-native/index.mjs';
import { exportNativeSceneTables } from '../../scripts/native-bake-page.js';
import { createCamera } from '../../src/path-tracer.js';

const WIDTH = 96;
const HEIGHT = 72;
const SAMPLES = 8;
const PACK_OPTIONS = { width: WIDTH, height: HEIGHT, samples: SAMPLES, bounces: 4, seed: 1, fireflyClamp: 20, noiseThreshold: 0 };
const ENVIRONMENT = { keyColor: [3, 3, 3], lightDirection: [0.4, 0.8, 0.5] };
const camera = createCamera({ eye: [0, 3, 9], target: [0, 0.5, 0], fov: 50 }, WIDTH, HEIGHT);
const modules = { buildTraceScene, refuseLocalVolumes, resolveTexture, buildNativeInput, buildJobNativeInput, buildFlattenedJobNativeInput, pack };

const QUAD = {
  positions: Float32Array.from([-0.6, 0, -0.6, 0.6, 0, -0.6, 0.6, 0, 0.6, -0.6, 0, 0.6]),
  normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
  uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
  indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
};
const GROUND = {
  name: 'ground',
  geometry: {
    positions: Float32Array.from([-9, -0.05, -9, 9, -0.05, -9, 9, -0.05, 9, -9, -0.05, 9]),
    normals: QUAD.normals,
    uvs: QUAD.uvs,
    indices: QUAD.indices,
  },
  material: { color: [0.5, 0.5, 0.5], roughness: 0.9 },
};

function checkerTexture(size) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let texel = 0; texel < size * size; texel++) {
    const lit = ((texel % size) + Math.floor(texel / size)) % 2 === 0;
    data.set(lit ? [230, 200, 60, 255] : [40, 60, 200, 255], texel * 4);
  }
  return { image: { width: size, height: size, data }, colorSpace: 'srgb' };
}

function placed(name, index, material) {
  const x = (index - 3.5) * 1.4;
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0.1 * index, 0, 1];
  return { name, geometry: QUAD, matrix, material };
}

const TEXTURE = checkerTexture(8);
const OTHER_TEXTURE = checkerTexture(4);
const GREY = { color: [0.6, 0.6, 0.6], roughness: 0.7 };
const RED = { color: [0.8, 0.1, 0.1], roughness: 0.7 };

// Every part gets a material object of its own, equal to its neighbours' values.
const sceneBuilders = {
  'textures': () => [GROUND, ...Array.from({ length: 8 }, (_, index) => placed(`card-${index}`, index, { map: index % 2 === 0 ? TEXTURE : OTHER_TEXTURE, color: [1, 1, 1], roughness: 0.6 }))],
  'emitters': () => [GROUND, ...Array.from({ length: 8 }, (_, index) => placed(`card-${index}`, index, index % 3 === 0 ? { color: [1, 0.8, 0.6], emission: 4 } : { color: [0.6, 0.6, 0.6], roughness: 0.7 }))],
  'overrides': () => [GROUND, ...Array.from({ length: 8 }, (_, index) => placed(`card-${index}`, index, index < 4 ? { ...GREY } : { ...RED }))],
  'metal-and-glass': () => [GROUND, ...Array.from({ length: 8 }, (_, index) => placed(`card-${index}`, index, index % 2 === 0 ? { color: [0.9, 0.7, 0.4], metallic: 1, roughness: 0.3 } : { color: [1, 1, 1], transmission: 0.9, ior: 1.45, roughness: 0.05 }))],
};

const routes = [
  { name: 'cycles-instanced', kernel: 'cycles', instancing: true },
  { name: 'cycles-flattened', kernel: 'cycles', instancing: false },
  { name: 'legacy', kernel: 'legacy', instancing: false },
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Instance k places its mesh with the material of the part (k + 3) % count: explicit `materialOverride` records, some equal to the default's.
function explicitOverrideHash(parts) {
  const scene = buildTraceScene(parts, ENVIRONMENT, { instancing: true });
  const instances = scene.instances.map((instance, index, all) => ({ ...instance, materialOverride: (index + 3) % all.length }));
  const input = buildNativeInputV2(scene, camera, { ...PACK_OPTIONS, instances });
  const picture = traceNative(input, { width: WIDTH, height: HEIGHT, samples: SAMPLES, kernel: 'cycles' });
  return { hash: sha256(Buffer.from(picture.rgba.buffer, picture.rgba.byteOffset, picture.rgba.byteLength)), materialRecords: input.materialCount };
}

const tracer = await import('../../packages/render-native/index.mjs');
const { traceFrameNative } = await import('../../scripts/agent-native-trace.mjs');
const results = {};
for (const [sceneName, buildParts] of Object.entries(sceneBuilders)) {
  const parts = buildParts();
  for (const route of routes) {
    try {
      const exported = exportNativeSceneTables({ parts, environment: ENVIRONMENT, camera, options: PACK_OPTIONS, kernel: route.kernel, instancing: route.instancing, modules });
      const frame = await traceFrameNative({ tracer, exported: { ...exported, ignored: [] }, width: WIDTH, height: HEIGHT, samples: SAMPLES, bounces: PACK_OPTIONS.bounces, seed: 1, denoise: 'none', kernel: route.kernel });
      results[`${sceneName} ${route.name}`] = { hash: sha256(Buffer.from(frame.data, 'base64')), instances: exported.instances ?? 0, materialRecords: exported.counts?.materialCount ?? null };
    } catch (error) {
      results[`${sceneName} ${route.name}`] = { hash: `refused: ${error.message}` };
    }
  }
  try {
    results[`${sceneName} explicit-override`] = explicitOverrideHash(parts);
  } catch (error) {
    results[`${sceneName} explicit-override`] = { hash: `refused: ${error.message}` };
  }
}
console.log(`SHARED_RECORD_IDENTITY ${JSON.stringify(results, null, 1)}`);
