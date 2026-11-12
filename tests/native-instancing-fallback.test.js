import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNativeInput } from '../packages/render-native/pack-input.mjs';
import { buildFlattenedJobNativeInput, buildJobNativeInput } from '../packages/render-native/job-input.mjs';
import { findNativeAddon, traceNative, upgradeNativeInputV1ToV2 } from '../packages/render-native/index.mjs';
import { traceFrameNative } from '../scripts/agent-native-trace.mjs';
import { exportNativeSceneTables } from '../scripts/native-bake-page.js';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene, refuseLocalVolumes, resolveTexture } from '../src/path-tracer-scene.js';

const WIDTH = 16;
const HEIGHT = 16;
const camera = createCamera({ eye: [0, 0, 8], target: [0, 0, 0], fov: 50 }, WIDTH, HEIGHT);
const options = { width: WIDTH, height: HEIGHT, bounces: 3, seed: 1, fireflyClamp: 20, noiseThreshold: 0 };
const environment = { keyColor: [3, 3, 3], lightDirection: [0.4, 0.8, 0.5] };
const modules = { buildTraceScene, refuseLocalVolumes, resolveTexture, buildNativeInput, buildJobNativeInput, buildFlattenedJobNativeInput, pack };

// A large triangle and a small one, so a copy shrunk far enough keeps one and loses the other.
const mixedSizeMesh = {
  positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 2.05, 0, 0, 2, 0.04, 0, 0, 0, 1, 0, 0.5, 1]),
  normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0]),
  uvs: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
  indices: Uint32Array.from([0, 1, 2, 3, 4, 5, 0, 6, 7]),
};
const glow = { color: [1, 0.7, 0.4], emission: 4, roughness: 0.7 };

function scaleAndMove(x, y, z, width) {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, width, 0, 0, 1];
}

const scenes = {
  'a copy scaled flat': { reason: /singular/, matrices: [scaleAndMove(1, 1, 1, -2), scaleAndMove(1, 0, 1, 1)] },
  'a copy scaled very small': { reason: /scales some emissive triangles/, matrices: [scaleAndMove(1, 1, 1, -2), scaleAndMove(1e-5, 1e-5, 1e-5, 1)] },
};

function parts(matrices) {
  return matrices.map((matrix, index) => ({ name: `lamp-${index}`, geometry: mixedSizeMesh, matrix, material: glow }));
}

function jobExport(matrices) {
  const exported = exportNativeSceneTables({ parts: parts(matrices), environment, camera, options, kernel: 'cycles', instancing: true, modules });
  return JSON.parse(JSON.stringify({ ...exported, ignored: [] }));
}

// What the kernel builds from the v1 tables of the flattened scene.
function mainsExport(matrices) {
  return upgradeNativeInputV1ToV2(buildNativeInput(buildTraceScene(parts(matrices), environment), camera, options, pack));
}

for (const [name, scene] of Object.entries(scenes)) {
  const { matrices, reason } = scene;
  test(`${name} makes the emissive copies export flattened with the reason, and the tables equal the flattened job`, () => {
    const exported = jobExport(matrices);
    assert.equal(exported.instancing, 'flattened');
    assert.match(exported.instancingReason, reason);
    assert.equal(exported.schemaVersion, 2, 'FORMAT-v2 tables without shared meshes');
    assert.equal(exported.instances, undefined);
    assert.equal(exported.wholeMaterials, true);
    const main = mainsExport(matrices);
    for (const [tableName, table] of Object.entries(main)) {
      if (!ArrayBuffer.isView(table) || tableName === 'kernelParams') continue;
      assert.equal(exported.tables[tableName], Buffer.from(table.buffer, table.byteOffset, table.byteLength).toString('base64'), tableName);
    }
  });
}

test('copies that all keep their triangles still export instanced', () => {
  const exported = jobExport([scaleAndMove(1, 1, 1, -2), scaleAndMove(0.5, 0.5, 0.5, 1)]);
  assert.equal(exported.instancing, undefined);
  assert.equal(exported.instances, 2);
});

const addonSkip = findNativeAddon() ? false : 'the native addon is not built';

for (const [name, scene] of Object.entries(scenes)) {
  const { matrices, reason } = scene;
  test(`${name} renders natively in a job frame, equal to the flattened trace`, { skip: addonSkip }, async t => {
    const real = await import('../packages/render-native/index.mjs');
    let viaJob;
    const capturingTracer = { ...real, traceNative(tables, traceOptions) {
      viaJob = real.traceNative(tables, traceOptions);
      return viaJob;
    } };
    let direct;
    try {
      direct = traceNative(mainsExport(matrices), { width: WIDTH, height: HEIGHT, samples: 8, kernel: 'cycles' });
    } catch (error) {
      if (/adapter|Vulkan|ray quer/i.test(error.message)) return t.skip(error.message);
      throw error;
    }
    const traced = await traceFrameNative({ tracer: capturingTracer, exported: jobExport(matrices), width: WIDTH, height: HEIGHT, samples: 8, denoise: 'none', kernel: 'cycles' });
    assert.equal(traced.report.backend, 'native');
    assert.equal(traced.report.instancing, 'flattened');
    assert.match(traced.report.instancingReason, reason);
    assert.deepEqual(Buffer.from(viaJob.rgba.buffer), Buffer.from(direct.rgba.buffer));
  });
}
