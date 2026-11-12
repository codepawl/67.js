import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseNativeKernel, chooseTraceBackend, createNativeTracerLocator, traceFrameNative } from '../scripts/agent-native-trace.mjs';

const builtTracer = { findNativeAddon: () => '/build/render-native.node' };

function locatorFor(importPackage) {
  return createNativeTracerLocator({ importPackage });
}

test('a native request runs native when the package and its binary are present', async () => {
  const locator = locatorFor(async () => builtTracer);
  const choice = await chooseTraceBackend({ requested: 'native', runtimeBackend: 'gpu', locator });
  assert.equal(choice.backend, 'native');
  assert.equal(choice.tracer, builtTracer);
  assert.equal(choice.note, undefined);
});

test('without the package a native job falls back to gpu, or to cpu on a cpu runtime, and says why', async () => {
  const locator = locatorFor(async () => { throw new Error('Cannot find package'); });
  const onGpu = await chooseTraceBackend({ requested: 'native', runtimeBackend: 'gpu', locator });
  assert.equal(onGpu.backend, 'gpu');
  assert.match(onGpu.note, /needs @codepawlhq\/67js-render-native/);
  assert.match(onGpu.note, /gpu backend ran instead/);
  const onCpu = await chooseTraceBackend({ requested: 'native', runtimeBackend: 'cpu', locator });
  assert.equal(onCpu.backend, 'cpu');
  assert.match(onCpu.note, /cpu backend ran instead/);
});

test('a package without its built binary falls back and names the build step', async () => {
  const locator = locatorFor(async () => ({ findNativeAddon: () => null }));
  const choice = await chooseTraceBackend({ requested: 'native', runtimeBackend: 'gpu', locator });
  assert.equal(choice.backend, 'gpu');
  assert.match(choice.note, /built binary/);
});

test('a trace that failed once makes later native requests fall back with that reason, without importing again', async () => {
  let imports = 0;
  const locator = locatorFor(async () => { imports += 1; return builtTracer; });
  assert.equal((await chooseTraceBackend({ requested: 'native', runtimeBackend: 'gpu', locator })).backend, 'native');
  locator.markUnusable('no adapter supports ray queries');
  const choice = await chooseTraceBackend({ requested: 'native', runtimeBackend: 'gpu', locator });
  assert.equal(choice.backend, 'gpu');
  assert.match(choice.note, /no adapter supports ray queries/);
  assert.equal(imports, 1, 'the package is looked up once per process');
});

test('cpu and gpu requests never touch the native package', async () => {
  const locator = locatorFor(async () => { throw new Error('must not be imported'); });
  assert.deepEqual(await chooseTraceBackend({ requested: 'gpu', runtimeBackend: 'gpu', locator }), { backend: 'gpu' });
  assert.deepEqual(await chooseTraceBackend({ requested: 'cpu', runtimeBackend: 'cpu', locator }), { backend: 'cpu' });
});

function tracerRecording(calls) {
  const pixels = 4 * 4;
  return {
    traceNative(tables, options) {
      calls.push(options);
      return { rgba: new Float32Array(pixels * 4).fill(0.5), albedo: new Float32Array(pixels * 3).fill(0.5),
        normal: new Float32Array(pixels * 3).fill(0.5), depth: new Float32Array(pixels), variance: new Float32Array(pixels),
        averageSamples: 11.5, adapter: 'test adapter', backend: 'test' };
    },
  };
}

const emptyExport = {
  triangleCount: 0, triangles: 0, ignored: [],
  tables: Object.fromEntries(['triangles', 'materials', 'lights', 'atlas', 'environmentColors', 'environmentTables', 'parameters'].map(name => [name, ''])),
};

test('a native frame traces with the cycles kernel unless JS67_NATIVE_KERNEL names another', async () => {
  assert.equal(chooseNativeKernel({}), 'cycles');
  assert.equal(chooseNativeKernel({ JS67_NATIVE_KERNEL: '' }), 'cycles');
  assert.equal(chooseNativeKernel({ JS67_NATIVE_KERNEL: 'legacy' }), 'legacy');
  const calls = [];
  const saved = process.env.JS67_NATIVE_KERNEL;
  delete process.env.JS67_NATIVE_KERNEL;
  try {
    const defaulted = await traceFrameNative({ tracer: tracerRecording(calls), exported: emptyExport, width: 4, height: 4, samples: 8, denoise: 'none' });
    assert.equal(calls[0].kernel, 'cycles');
    assert.equal(defaulted.report.kernel, 'cycles');
    await traceFrameNative({ tracer: tracerRecording(calls), exported: emptyExport, width: 4, height: 4, samples: 8, denoise: 'none', kernel: 'legacy' });
    assert.equal(calls[1].kernel, 'legacy');
  } finally {
    if (saved !== undefined) process.env.JS67_NATIVE_KERNEL = saved;
  }
});

test('noiseThreshold reaches the native trace and the report keeps averageSamples', async () => {
  const calls = [];
  const traced = await traceFrameNative({ tracer: tracerRecording(calls), exported: emptyExport, width: 4, height: 4, samples: 64, denoise: 'none', noiseThreshold: 0.02 });
  assert.equal(calls[0].noiseThreshold, 0.02);
  assert.equal(traced.report.noiseThreshold, 0.02);
  assert.equal(traced.report.averageSamples, 11.5);
});

test('the wavelet filter and OIDN both run on the native features', async () => {
  const calls = [];
  const guides = [];
  const denoiser = { OIDN_VERSION: 'test', async denoiseWithOidn(features) { guides.push(Object.keys(features).sort()); return features.color; } };
  const withOidn = await traceFrameNative({ tracer: tracerRecording(calls), exported: emptyExport, width: 4, height: 4, samples: 8, denoise: 'oidn', denoiser });
  assert.equal(withOidn.report.denoiser, 'oidn');
  assert.deepEqual(guides[0], ['albedo', 'color', 'height', 'normal', 'width']);
  const withWavelet = await traceFrameNative({ tracer: tracerRecording(calls), exported: emptyExport, width: 4, height: 4, samples: 8, denoise: 'wavelet' });
  assert.equal(withWavelet.report.denoiser, 'wavelet');
});

function tracerWithAtrous(calls, { failFilter = false } = {}) {
  const pixels = 4 * 4;
  const tracer = tracerRecording(calls);
  const traceNative = tracer.traceNative;
  tracer.traceNative = (tables, options) => {
    const traced = traceNative(tables, options);
    return options.denoise === 'atrous' ? { ...traced, denoisedRgba: new Float32Array(pixels * 4).fill(0.25) } : traced;
  };
  tracer.denoiseAtrous = input => {
    calls.push({ afterwards: Object.keys(input).sort() });
    if (failFilter) throw new Error('no adapter');
    return { rgba: new Float32Array(pixels * 4).fill(0.25) };
  };
  return tracer;
}

const failingDenoiser = { OIDN_VERSION: 'test', async denoiseWithOidn() { throw new Error('binary crashed'); } };

test('denoise "atrous" asks the cycles kernel for the filtered image and reports it', async () => {
  const calls = [];
  const traced = await traceFrameNative({ tracer: tracerWithAtrous(calls), exported: emptyExport, width: 4, height: 4, samples: 8, denoise: 'atrous', kernel: 'cycles' });
  assert.equal(calls[0].denoise, 'atrous');
  assert.equal(calls.length, 1);
  assert.equal(traced.report.denoiser, 'atrous');
  assert.equal(traced.report.denoised, true);
  assert.equal(typeof traced.report.denoiseSeconds, 'number');
});

test('denoise "atrous" on the legacy kernel filters the traced image afterwards', async () => {
  const calls = [];
  const traced = await traceFrameNative({ tracer: tracerWithAtrous(calls), exported: emptyExport, width: 4, height: 4, samples: 8, denoise: 'atrous', kernel: 'legacy' });
  assert.equal(calls[0].denoise, undefined);
  assert.deepEqual(calls[1].afterwards, ['albedo', 'depth', 'height', 'normal', 'rgba', 'variance', 'width']);
  assert.equal(traced.report.denoiser, 'atrous');
});

test('OIDN failing on native falls back to the GPU a-trous filter and says so', async () => {
  const calls = [];
  const traced = await traceFrameNative({ tracer: tracerWithAtrous(calls), exported: emptyExport, width: 4, height: 4, samples: 8, denoise: 'oidn', denoiser: failingDenoiser, kernel: 'cycles' });
  assert.equal(traced.report.denoiser, 'atrous');
  assert.match(traced.report.denoiserNote, /OIDN failed \(binary crashed\): the GPU a-trous filter ran instead/);
});

test('the wavelet filter is the last resort when the a-trous filter cannot run', async () => {
  const traced = await traceFrameNative({ tracer: tracerWithAtrous([], { failFilter: true }), exported: emptyExport, width: 4, height: 4, samples: 8, denoise: 'oidn', denoiser: failingDenoiser, kernel: 'legacy' });
  assert.equal(traced.report.denoiser, 'wavelet');
  assert.match(traced.report.denoiserNote, /OIDN failed.*a-trous filter failed \(no adapter\): the wavelet filter ran instead/);
  const withoutFilter = await traceFrameNative({ tracer: tracerRecording([]), exported: emptyExport, width: 4, height: 4, samples: 8, denoise: 'atrous', kernel: 'legacy' });
  assert.equal(withoutFilter.report.denoiser, 'wavelet');
  assert.match(withoutFilter.report.denoiserNote, /no a-trous filter/);
});

test('explicit wavelet and no filter never reach the a-trous filter', async () => {
  const calls = [];
  const wavelet = await traceFrameNative({ tracer: tracerWithAtrous(calls), exported: emptyExport, width: 4, height: 4, samples: 8, denoise: 'wavelet', kernel: 'cycles' });
  const none = await traceFrameNative({ tracer: tracerWithAtrous(calls), exported: emptyExport, width: 4, height: 4, samples: 8, denoise: 'none', kernel: 'cycles' });
  assert.equal(wavelet.report.denoiser, 'wavelet');
  assert.equal(none.report.denoiser, 'none');
  assert.ok(calls.every(call => call.denoise === undefined && !call.afterwards));
});
