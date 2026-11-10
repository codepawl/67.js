import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePathTracerOptions, renderPathTracedImage } from '../src/path-tracer.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import { buildMegakernelSource, MEGAKERNEL_SOURCE, PATH_STATE_VECTORS, WAVEFRONT_SOURCE } from '../src/path-tracer-webgpu-kernel.js';
import { DEFAULT_WEBGPU_KERNEL, isWebGpuTracerAvailable, traceOnWebGpu, WEBGPU_KERNELS } from '../src/path-tracer-webgpu.js';

function quad(offset) {
  return {
    positions: new Float32Array([-1, offset, 1, 1, offset, 1, 1, offset, -1, -1, offset, -1]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

const camera = { eye: [0, 1, 4], target: [0, 1, 0], fov: 50 };
const parts = [{ name: 'floor', geometry: quad(0), material: { color: [0.5, 0.5, 0.5] } }];

test('the webgpu backend is a valid path tracer option, the default stays cpu', () => {
  assert.equal(normalizePathTracerOptions({ backend: 'webgpu' }).backend, 'webgpu');
  assert.equal(normalizePathTracerOptions({}).backend, 'cpu');
  assert.throws(() => normalizePathTracerOptions({ backend: 'vulkan' }), /"cpu", "gpu" or "webgpu"/);
});

test('without navigator.gpu the webgpu backend throws a clear error naming the fallbacks', async () => {
  assert.equal(isWebGpuTracerAvailable(), false);
  const scene = buildTraceScene(parts, {});
  const options = normalizePathTracerOptions({ width: 16, height: 16, samples: 1, bounces: 1 });
  await assert.rejects(traceOnWebGpu(scene, { eye: [0, 1, 4], forward: [0, 0, -1], right: [1, 0, 0], above: [0, 1, 0], halfWidth: 1, halfHeight: 1 }, options, () => {}), /navigator\.gpu.*"gpu".*"cpu"/);
  await assert.rejects(renderPathTracedImage({ parts, environment: {}, camera }, { width: 16, height: 16, samples: 1, bounces: 1, backend: 'webgpu', denoise: false }), /navigator\.gpu/);
});

test('an unknown kernel name is rejected before any GPU work', async () => {
  const globalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const calls = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: { requestAdapter: async () => { calls.push('adapter'); return null; } } } });
  try {
    const scene = buildTraceScene(parts, {});
    await assert.rejects(traceOnWebGpu(scene, {}, { kernel: 'nonsense' }, () => {}), /kernel must be one of megakernel, wavefront/);
    await assert.rejects(traceOnWebGpu(scene, {}, { width: 2, height: 2, samples: 1, bounces: 1 }, () => {}), /no WebGPU adapter/);
  } finally {
    if (globalNavigator) Object.defineProperty(globalThis, 'navigator', globalNavigator);
    else delete globalThis.navigator;
  }
  assert.deepEqual(calls, ['adapter']);
});

test('fog and the subsurface walk are compiled in only for the megakernel of a scene that uses them', () => {
  assert.doesNotMatch(MEGAKERNEL_SOURCE, /scatterInFog|volumeInterval|randomWalk|bakeTexels/);
  const fogSource = buildMegakernelSource({ hasVolume: true });
  assert.match(fogSource, /fn scatterInFog\(/);
  assert.match(fogSource, /fn fogTransmittance\(/);
  assert.doesNotMatch(fogSource, /randomWalk/);
  const subsurfaceSource = buildMegakernelSource({ hasSubsurface: true });
  assert.match(subsurfaceSource, /fn randomWalk\(/);
  assert.match(subsurfaceSource, /fn enterSubsurface\(/);
  assert.doesNotMatch(subsurfaceSource, /scatterInFog/);
  assert.doesNotMatch(WAVEFRONT_SOURCE, /scatterInFog|randomWalk/);
});

test('the texel kernel replaces the camera entry point and reads the texels from the two spare bindings', () => {
  const texelSource = buildMegakernelSource({ texelBake: true });
  assert.match(texelSource, /fn bakeTexels\(/);
  assert.match(texelSource, /@binding\(9\)[^\n]*texelPoints/);
  assert.match(texelSource, /@binding\(10\)[^\n]*texelNormals/);
  assert.doesNotMatch(texelSource, /fn main\(/);
});

test('the wavefront kernel refuses a scene with fog or subsurface scattering before it asks for an adapter', async () => {
  const fogScene = buildTraceScene(parts, { volumeFog: { minimum: [-30, 1, -30], maximum: [30, 2, 30], density: 0.5 } });
  const subsurfaceParts = [{ ...parts[0], material: { color: [0.7, 0.4, 0.3], subsurface: { weight: 1, radius: [1, 0.2, 0.1], scale: 0.05 } } }];
  const subsurfaceScene = buildTraceScene(subsurfaceParts, {});
  await assert.rejects(traceOnWebGpu(fogScene, {}, { kernel: 'wavefront' }, () => {}), /wavefront kernel does not trace volume fog or subsurface/);
  await assert.rejects(traceOnWebGpu(subsurfaceScene, {}, { kernel: 'wavefront' }, () => {}), /wavefront kernel does not trace volume fog or subsurface/);
});

test('both kernels share the scene bindings and the wavefront adds its path state', () => {
  assert.deepEqual(WEBGPU_KERNELS, ['megakernel', 'wavefront']);
  assert.equal(DEFAULT_WEBGPU_KERNEL, 'megakernel');
  for (let binding = 0; binding <= 8; binding++) {
    assert.match(MEGAKERNEL_SOURCE, new RegExp(`@binding\\(${binding}\\)`));
    assert.match(WAVEFRONT_SOURCE, new RegExp(`@binding\\(${binding}\\)`));
  }
  assert.doesNotMatch(MEGAKERNEL_SOURCE, /@binding\(9\)/);
  assert.match(WAVEFRONT_SOURCE, /@binding\(9\)[^\n]*pathState/);
  assert.match(WAVEFRONT_SOURCE, /@binding\(10\)[^\n]*binQueue/);
  assert.match(MEGAKERNEL_SOURCE, /fn main\(/);
  for (const entryPoint of ['generatePaths', 'resetBins', 'extendPaths', 'scanBins', 'scatterPaths', 'shadePaths', 'shadowPaths', 'resolvePaths']) {
    assert.match(WAVEFRONT_SOURCE, new RegExp(`fn ${entryPoint}\\(`));
  }
  assert.match(WAVEFRONT_SOURCE, new RegExp(`PATH_STATE_VECTORS: u32 = ${PATH_STATE_VECTORS}u`));
});
