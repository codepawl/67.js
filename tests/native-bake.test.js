import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { bakeLightmapsAsync } from '../src/light-bake-gpu.js';
import { gpuBakeKernels } from '../src/agent-bake-gpu.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildNativeTexelInput } from '../packages/render-native/pack-input.mjs';
import { isNativeTimeLimitError, traceTexelsNative } from '../scripts/agent-native-trace.mjs';

const cube = box(0, 1);

function placed(name, translation, scale) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
  return { name, geometry: cube, matrix, material: { tag: 'surface', color: [0.7, 0.7, 0.7], metallic: 0, roughness: 0.8, emission: 0 } };
}

const room = [placed('floor', [0, -0.05, 0], [6, 0.1, 6]), placed('back', [0, 1.5, -3.05], [6, 3.2, 0.1])];
const lamp = { pointLights: [{ position: [-1.5, 2.5, 0], color: [1, 1, 1], intensity: 8, radius: 0.05 }], keyColor: [0, 0, 0] };
const fastOptions = { samples: 8, bounces: 2, texelsPerUnit: 2, maxResolution: 16, backend: 'native' };

test('the light bake accepts the native backend and hands its texels to the texel tracer', async () => {
  const calls = [];
  const texelTracer = async (scene, texels, options) => {
    calls.push({ texels: texels.count, samples: options.samples, bounces: options.bounces });
    return { radiance: new Float32Array(texels.count * 3).fill(1), escaped: new Float32Array(texels.count), gpu: 'fake adapter', compileSeconds: 0 };
  };
  const baked = await bakeLightmapsAsync(room, lamp, { ...fastOptions, texelTracer });
  assert.equal(baked.report.backend, 'native');
  assert.equal(baked.report.gpu, 'fake adapter');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].samples, 8);
  assert.ok(calls[0].texels > 0);
});

test('a native bake without a texel tracer says what it needs instead of running the WebGL kernel', async () => {
  await assert.rejects(bakeLightmapsAsync(room, lamp, fastOptions), /texelTracer/);
});

test('the texel parameter block carries the texel count, the sample count and the bounces after the first leg', () => {
  const scene = buildTraceScene(room, { keyColor: [0, 0, 0], lightDirection: [0, 1, 0], pointLights: lamp.pointLights });
  const input = buildNativeTexelInput(scene, { texelCount: 1234, samples: 77, bounces: 3, seed: 5, fireflyClamp: 1e6 }, pack);
  const integers = new Int32Array(input.parameters.buffer, input.parameters.byteOffset, input.parameters.byteLength / 4);
  const words = new Uint32Array(input.parameters.buffer, input.parameters.byteOffset, input.parameters.byteLength / 4);
  assert.equal(integers[36], 1234);
  assert.equal(integers[38], 2);
  assert.equal(words[44], 5);
  assert.equal(words[46], 77);
});

function decodeFloats(base64) {
  const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
  return [...new Float32Array(bytes.buffer)];
}

test('the host decodes the page request, runs the native texel trace and encodes the answer', () => {
  const scene = buildTraceScene(room, { keyColor: [0, 0, 0], lightDirection: [0, 1, 0], pointLights: lamp.pointLights });
  const input = buildNativeTexelInput(scene, { texelCount: 2, samples: 4, bounces: 2, seed: 1, fireflyClamp: 1e6 }, pack);
  const tables = {};
  for (const [name, values] of Object.entries(input)) {
    if (ArrayBuffer.isView(values)) tables[name] = Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('base64');
  }
  const floats = values => Buffer.from(new Float32Array(values).buffer).toString('base64');
  let seen;
  const tracer = {
    traceNativeTexels(decoded, texels, options) {
      seen = { triangleCount: decoded.triangleCount, count: texels.count, points: [...texels.points], options };
      return { radiance: new Float32Array([1, 2, 3, 4, 5, 6]), escaped: new Float32Array([0.25, 0.5]), adapter: 'fake', compileSeconds: 0.5, tracedSeconds: 1 };
    },
  };
  const request = { tables, triangleCount: input.triangleCount, samples: 4, texelCount: 2, points: floats([0, 0, 0, 1, 1, 1]), normals: floats([0, 1, 0, 0, 1, 0]) };
  const answer = traceTexelsNative({ tracer, request, maxSeconds: 90 });
  assert.deepEqual(seen, { triangleCount: input.triangleCount, count: 2, points: [0, 0, 0, 1, 1, 1], options: { samples: 4, maxSeconds: 90 } });
  assert.deepEqual(decodeFloats(answer.radiance), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(decodeFloats(answer.escaped), [0.25, 0.5]);
  assert.equal(answer.adapter, 'fake');
});

test('only the native time limit error is a clean failure', () => {
  assert.equal(isNativeTimeLimitError(new Error('The native trace passed its time limit of 5 s after 8 of 64 samples.')), true);
  assert.equal(isNativeTimeLimitError(new Error('The Vulkan adapter does not support ray queries.')), false);
});

test('a host that offers the native tracer gives the page bake kernels even without WebGL2', () => {
  assert.equal(gpuBakeKernels(), undefined);
  assert.equal(typeof gpuBakeKernels({ texelTracer: async () => ({}) }).lightBake.compute, 'function');
});
