import assert from 'node:assert/strict';
import test from 'node:test';
import { canBakeOnGpu, gpuBakeKernels } from '../src/agent-bake-gpu.js';
import { buildWithKernels, kernelStats, resetKernelStats, runKernel } from '../src/kernel-offload.js';

function workerAnswering(value, workerCalls = []) {
  const worker = {
    postMessage(message) {
      workerCalls.push(message.name);
      setTimeout(() => worker.onmessage({ data: { value } }), 0);
    },
    terminate() {},
  };
  return worker;
}

test('a light with affects keeps the bake on the CPU, because the GPU kernel has no light linking', () => {
  assert.equal(canBakeOnGpu({ pointLights: [{ position: [0, 1, 0] }], spotLights: [], areaLights: [] }), true);
  assert.equal(canBakeOnGpu({ pointLights: [{ affects: null }] }), true);
  assert.equal(canBakeOnGpu({ pointLights: [{ affects: ['floor'] }] }), false);
  assert.equal(canBakeOnGpu({ areaLights: [{ affects: ['floor'] }] }), false);
});

test('a page without WebGL2 offers no GPU bake kernels, so the worker bakes on the CPU', () => {
  assert.equal(gpuBakeKernels(), undefined);
});

test('a page kernel answers a deferred kernel when it accepts the call, and the worker answers the rest', async () => {
  resetKernelStats();
  const workerCalls = [];
  const worker = workerAnswering('from the worker', workerCalls);
  const pageKernels = { lightBake: { accepts: ([flag]) => flag === 'gpu', compute: async () => 'from the page' } };
  const build = flag => () => runKernel('lightBake', [flag], () => 'inline');
  assert.equal(await buildWithKernels(build('gpu'), { createWorker: () => worker, available: true, pageKernels }), 'from the page');
  assert.deepEqual(workerCalls, []);
  assert.equal(await buildWithKernels(build('cpu'), { createWorker: () => worker, available: true, pageKernels }), 'from the worker');
  assert.deepEqual(workerCalls, ['lightBake']);
  assert.equal(kernelStats().page, 1);
});

test('a page kernel that fails leaves the kernel to the worker', async () => {
  resetKernelStats();
  const worker = workerAnswering('from the worker');
  const pageKernels = { lightBake: { accepts: () => true, compute: async () => { throw new Error('context lost'); } } };
  const result = await buildWithKernels(() => runKernel('lightBake', ['x'], () => 'inline'), { createWorker: () => worker, available: true, pageKernels });
  assert.equal(result, 'from the worker');
  assert.match(kernelStats().fallbacks[0].reason, /page kernel failed: context lost/);
});
