import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNativeInput } from '../packages/render-native/pack-input.mjs';
import { buildNativeInputV2, findNativeAddon, traceNative } from '../packages/render-native/index.mjs';
import { traceFrameNative } from '../scripts/agent-native-trace.mjs';
import { encodeNativeInputV2 } from '../scripts/native-bake-page.js';
import { buildCopyScene } from '../bench/instancing/copies-scene.mjs';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';

const WIDTH = 8;
const HEIGHT = 8;

function instancedInput(variant) {
  const { parts, environment } = buildCopyScene(variant, 6);
  const camera = createCamera({ eye: [0, 0, 14], target: [0, 0, -3], fov: 50 }, WIDTH, HEIGHT);
  const scene = buildTraceScene(parts, environment, { instancing: true });
  return { parts, environment, camera, scene, input: buildNativeInputV2(scene, camera, { width: WIDTH, height: HEIGHT, bounces: 4, seed: 3 }) };
}

function recordingTracer(received) {
  const pixels = WIDTH * HEIGHT;
  return {
    traceNative(input, options) {
      received.push({ input, options });
      return { rgba: new Float32Array(pixels * 4).fill(0.5), albedo: new Float32Array(pixels * 3), normal: new Float32Array(pixels * 3),
        depth: new Float32Array(pixels), variance: new Float32Array(pixels), adapter: 'test adapter', backend: 'test' };
    },
  };
}

test('an instanced scene crosses the page boundary as FORMAT-v2 tables and arrives byte for byte', async () => {
  const { input } = instancedInput('rotscale');
  const exported = JSON.parse(JSON.stringify({ ...encodeNativeInputV2(input), triangleCount: input.triangleCount, triangles: input.triangleCount,
    instances: input.instanceCount, ignored: [] }));
  const received = [];
  const traced = await traceFrameNative({ tracer: recordingTracer(received), exported, width: WIDTH, height: HEIGHT, samples: 4, denoise: 'none', kernel: 'cycles' });
  const arrived = received[0].input;
  assert.equal(arrived.schemaVersion, input.schemaVersion);
  for (const [name, value] of Object.entries(input)) {
    if (ArrayBuffer.isView(value)) {
      assert.ok(arrived[name] instanceof value.constructor, `${name} keeps its array type`);
      assert.deepEqual(Buffer.from(arrived[name].buffer, arrived[name].byteOffset, arrived[name].byteLength), Buffer.from(value.buffer, value.byteOffset, value.byteLength), name);
    } else if (typeof value === 'number') {
      assert.equal(arrived[name], value, name);
    }
  }
  assert.equal(traced.report.instances, 6);
  assert.equal(traced.report.triangles, input.triangleCount, 'the report counts unique triangles');
  assert.ok(input.triangleCount < 6 * 320, 'six copies of a 320 triangle mesh share one set of triangles');
});

test('a table with an unknown array type is refused with its name', async () => {
  const { input } = instancedInput('translate');
  const exported = { ...encodeNativeInputV2(input), triangleCount: 0, triangles: 0, ignored: [] };
  exported.types = { ...exported.types, instances: 'Float64Array' };
  await assert.rejects(
    traceFrameNative({ tracer: recordingTracer([]), exported, width: WIDTH, height: HEIGHT, samples: 4, denoise: 'none', kernel: 'cycles' }),
    /table "instances" has an unknown array type "Float64Array"/,
  );
});

test('the legacy packer refuses an instanced scene and a scene without shared geometry stays flattened', () => {
  const { parts, environment, camera, scene } = instancedInput('translate');
  assert.throws(() => buildNativeInput(scene, camera, { width: WIDTH, height: HEIGHT }, pack), /cannot read instances/);
  const distinct = parts.map(part => ({ ...part, geometry: { ...part.geometry, positions: Float32Array.from(part.geometry.positions) } }));
  const flattened = buildTraceScene(distinct, environment, { instancing: true });
  assert.equal(flattened.instances, undefined);
  assert.ok(flattened.indices.length > 0);
});

const addonSkip = findNativeAddon() ? false : 'the native addon is not built';

test('a job frame of an instanced scene equals the direct trace of the same input', { skip: addonSkip }, async t => {
  const { input } = instancedInput('rotscale');
  const exported = JSON.parse(JSON.stringify({ ...encodeNativeInputV2(input), triangleCount: input.triangleCount, triangles: input.triangleCount,
    instances: input.instanceCount, ignored: [] }));
  const real = await import('../packages/render-native/index.mjs');
  let direct;
  let viaJob;
  const capturingTracer = { ...real, traceNative(tables, options) {
    viaJob = real.traceNative(tables, options);
    return viaJob;
  } };
  try {
    direct = traceNative(input, { width: WIDTH, height: HEIGHT, samples: 8, kernel: 'cycles' });
  } catch (error) {
    if (/adapter|Vulkan|ray quer/i.test(error.message)) return t.skip(error.message);
    throw error;
  }
  const traced = await traceFrameNative({ tracer: capturingTracer, exported, width: WIDTH, height: HEIGHT, samples: 8, denoise: 'none', kernel: 'cycles' });
  assert.equal(traced.report.instances, 6);
  assert.deepEqual(Buffer.from(viaJob.rgba.buffer), Buffer.from(direct.rgba.buffer));
});
