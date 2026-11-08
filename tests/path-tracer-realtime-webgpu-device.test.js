import assert from 'node:assert/strict';
import test from 'node:test';

import { createRealtimeTracer } from '../src/path-tracer-realtime.js';

// A device that records what the real-time tracer asks of it, so the frame logic runs in Node without a GPU.
const usageFlags = { MAP_READ: 1, COPY_SRC: 2, COPY_DST: 4, UNIFORM: 8, STORAGE: 16, RENDER_ATTACHMENT: 32, COMPUTE: 64 };
globalThis.GPUBufferUsage = usageFlags;
globalThis.GPUTextureUsage = usageFlags;
globalThis.GPUShaderStage = usageFlags;
globalThis.GPUMapMode = { READ: 1 };

const recorded = { submits: 0, dispatches: 0, passes: 0, destroyedBuffers: 0, clears: 0, copies: 0, unconfigured: 0 };

function createFakeBuffer(descriptor) {
  return {
    ...descriptor,
    destroy() { recorded.destroyedBuffers++; },
    async mapAsync() {},
    getMappedRange() { return new ArrayBuffer(descriptor.size); },
  };
}

const fakePass = {
  setPipeline() {},
  setBindGroup() {},
  dispatchWorkgroups() { recorded.dispatches++; },
  end() { recorded.passes++; },
};

const fakeDevice = {
  limits: { maxStorageBufferBindingSize: 1 << 30 },
  addEventListener() {},
  createBuffer: createFakeBuffer,
  createShaderModule: () => ({ async getCompilationInfo() { return { messages: [] }; } }),
  createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
  createBindGroupLayout: () => ({}),
  createPipelineLayout: () => ({}),
  createBindGroup: () => ({}),
  createCommandEncoder: () => ({
    beginComputePass: () => fakePass,
    clearBuffer() { recorded.clears++; },
    copyBufferToTexture() { recorded.copies++; },
    copyBufferToBuffer() {},
    finish: () => ({}),
  }),
  queue: {
    writeBuffer() {},
    submit() { recorded.submits++; },
    onSubmittedWorkDone: async () => {},
  },
};

const fakeAdapter = {
  limits: { maxStorageBuffersPerShaderStage: 10, maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30 },
  info: { vendor: 'fake', architecture: 'device' },
  requestDevice: async () => fakeDevice,
};

function installGpu(requestAdapter) {
  Object.defineProperty(globalThis.navigator, 'gpu', { configurable: true, value: { requestAdapter, getPreferredCanvasFormat: () => 'bgra8unorm' } });
}

const fakeCanvas = {
  getContext: () => ({ configure() {}, getCurrentTexture: () => ({}), unconfigure() { recorded.unconfigured++; } }),
};

const floor = {
  positions: new Float32Array([-1, 0, 1, 1, 0, 1, 1, 0, -1, -1, 0, -1]),
  normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};
const camera = { eye: [0, 1, 4], target: [0, 0, 0], fov: 50 };
const scene = { parts: [{ name: 'floor', geometry: floor, material: { color: [0.5, 0.5, 0.5] } }], environment: {}, camera };

test('a page without a WebGPU adapter does not get the WebGPU tracer', async () => {
  installGpu(async () => null);
  await assert.rejects(() => createRealtimeTracer(scene, { backend: 'webgpu', width: 32, height: 16 }));
});

test('an unknown real-time backend is rejected before any GPU work', async () => {
  await assert.rejects(() => createRealtimeTracer(scene, { backend: 'vulkan' }), /backend must be one of/);
});

test('the WebGPU real-time tracer encodes a frame per call and ping-pongs its history', async () => {
  installGpu(async () => fakeAdapter);
  const tracer = await createRealtimeTracer(scene, { backend: 'webgpu', width: 64, height: 32, canvas: fakeCanvas });
  assert.equal(tracer.backend, 'webgpu');
  assert.equal(tracer.fallbackReason, null);
  assert.equal(tracer.gpu, 'fake device');
  assert.equal(tracer.traceWidth, 32);
  assert.equal(tracer.traceHeight, 16);
  assert.equal(tracer.canvas, fakeCanvas);
  assert.equal(typeof tracer.compileSeconds, 'number');

  const first = tracer.frame(camera);
  assert.equal(first.frame, 1);
  assert.equal(first.done, undefined);
  assert.equal(recorded.clears, 1, 'a new scene empties the cache once');
  const dispatchesPerFrame = recorded.dispatches;
  assert.ok(dispatchesPerFrame >= 5);

  const second = tracer.frame({ ...camera, eye: [0.2, 1, 4] }, { wait: true });
  await second.done;
  assert.equal(second.frame, 2);
  assert.equal(recorded.dispatches, dispatchesPerFrame * 2);
  assert.equal(recorded.clears, 1);
  assert.equal(recorded.submits, 2);
  assert.equal(recorded.copies, 2);
  assert.equal(tracer.frameCount, 2);

  tracer.resetHistory();
  tracer.frame(camera);
  assert.equal(tracer.frameCount, 3);

  const picture = await tracer.readFrame();
  assert.equal(picture.width, 64);
  assert.equal(picture.height, 32);
  assert.equal(picture.rgba.length, 64 * 32 * 4);
  assert.equal(picture.rgba[3], 255);

  await tracer.update({});
  assert.equal(recorded.clears, 1, 'no parts, no new scene');
  await tracer.update({ parts: [{ ...scene.parts[0], geometry: { ...floor } }] });
  tracer.frame(camera);
  assert.equal(recorded.clears, 2, 'a new scene empties the cache again');

  const destroyedBefore = recorded.destroyedBuffers;
  tracer.dispose();
  assert.ok(recorded.destroyedBuffers > destroyedBefore);
  assert.equal(recorded.unconfigured, 1);
  assert.throws(() => tracer.frame(camera), /disposed/);
});

test('an update that only moves a part keeps the history and sends the part motion with the next frame', async () => {
  installGpu(async () => fakeAdapter);
  const tracer = await createRealtimeTracer(scene, { backend: 'webgpu', width: 64, height: 32, canvas: fakeCanvas });
  tracer.frame(camera);
  const motionWrites = [];
  const originalWriteBuffer = fakeDevice.queue.writeBuffer;
  fakeDevice.queue.writeBuffer = (buffer, offset, data) => {
    if (buffer.label === 'part motion') motionWrites.push(Array.from(data.slice(0, 16)));
  };
  const clearsBefore = recorded.clears;
  const slideMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 0, 0, 1];
  await tracer.update({ parts: [{ ...scene.parts[0], matrix: slideMatrix }] });
  tracer.frame(camera);
  tracer.frame(camera);
  tracer.frame(camera);
  fakeDevice.queue.writeBuffer = originalWriteBuffer;

  assert.equal(recorded.clears, clearsBefore, 'the cache and the history stay');
  assert.equal(motionWrites.length, 2, 'the moved table once, then the still table once');
  const [moved, still] = motionWrites;
  assert.equal(moved[12], 1, 'the part is rigid');
  assert.equal(moved[3], -0.5, 'a point of this frame was half a unit back along x');
  assert.equal(still[12], 0, 'then the part is still');
  tracer.dispose();
});

test('the denoiser with its history at the output size runs the same frame', async () => {
  installGpu(async () => fakeAdapter);
  const tracer = await createRealtimeTracer(scene, { backend: 'webgpu', width: 64, height: 32, canvas: fakeCanvas, accumulateAtOutputSize: true });
  const dispatchesBefore = recorded.dispatches;
  tracer.frame(camera);
  tracer.frame({ ...camera, eye: [0.1, 1, 4] });
  assert.ok(recorded.dispatches - dispatchesBefore >= 12, 'trace, cache, resolve, a-trous and present passes for two frames');
  const picture = await tracer.readFrame();
  assert.equal(picture.rgba.length, 64 * 32 * 4);
  tracer.dispose();
});
