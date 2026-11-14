import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  chooseNativeKernel, chooseTraceBackend, createNativeTracerLocator, isNativeTimeLimitError, traceFrameNative,
} from '../scripts/agent-native-trace.mjs';

// These tests use fake engines, so they run with and without Cook installed; a COOK_DISABLE from the suite's absent-mode run
// must not hide the fakes from the locator. The test that checks COOK_DISABLE sets it itself.
delete process.env.COOK_DISABLE;

// A fake engine module: this file stays outside the Cook test helper.
function fakeEngine({ addonPath = '/build/render-native.node', packFormat, limits = { triangles: null, instances: 500 } } = {}) {
  return {
    describeEngine: () => ({
      name: 'fake',
      packFormat: packFormat ?? { version: 2, revision: 1, readsRevisions: [1, 1] },
      denoisers: ['none'],
      sessions: null,
      limits,
    }),
    findNativeAddon: () => addonPath,
    traceNative() {},
    traceNativeTexels() {},
  };
}

const builtTracer = fakeEngine();

function locatorFor(importPackage) {
  return createNativeTracerLocator({ importPackage });
}

function moduleNotFound(specifier) {
  return Object.assign(new Error(`Cannot find package '${specifier}' imported from somewhere`), { code: 'ERR_MODULE_NOT_FOUND' });
}

test('a native request runs native when the package and its binary are present', async () => {
  const locator = locatorFor(async () => builtTracer);
  const choice = await chooseTraceBackend({ requested: 'native', runtimeBackend: 'gpu', locator });
  assert.equal(choice.backend, 'native');
  assert.equal(choice.tracer, builtTracer);
  assert.equal(choice.note, undefined);
});

test('the engine limits lower the Crucible job limits and null declares none', async () => {
  const found = await locatorFor(async () => builtTracer).find();
  assert.deepEqual(found.limits, { triangles: 1_500_000, instances: 500 });
  assert.equal(found.description.name, 'fake');
});

test('without the package a native job falls back to gpu, or to cpu on a cpu runtime, and says why', async () => {
  const locator = locatorFor(async specifier => { throw moduleNotFound(specifier); });
  const onGpu = await chooseTraceBackend({ requested: 'native', runtimeBackend: 'gpu', locator });
  assert.equal(onGpu.backend, 'gpu');
  assert.match(onGpu.note, /needs @codepawlhq\/cook/);
  assert.match(onGpu.note, /npm install github:codepawl\/cook, then npm run build/);
  assert.match(onGpu.note, /gpu backend ran instead/);
  const onCpu = await chooseTraceBackend({ requested: 'native', runtimeBackend: 'cpu', locator });
  assert.equal(onCpu.backend, 'cpu');
  assert.match(onCpu.note, /cpu backend ran instead/);
});

test('an install that exists but fails to load is reported with the error text, not as missing', async () => {
  const locator = locatorFor(async () => { throw new SyntaxError('Unexpected token'); });
  const choice = await chooseTraceBackend({ requested: 'native', runtimeBackend: 'gpu', locator });
  assert.equal(choice.backend, 'gpu');
  assert.match(choice.note, /failed to load \(Unexpected token\)/);
});

test('a package without its built binary falls back and names the build step', async () => {
  const locator = locatorFor(async () => fakeEngine({ addonPath: null }));
  const choice = await chooseTraceBackend({ requested: 'native', runtimeBackend: 'gpu', locator });
  assert.equal(choice.backend, 'gpu');
  assert.match(choice.note, /built binary/);
});

test('a module that is not a render engine, or reads other pack revisions, falls back with one reason', async () => {
  const notEngine = await chooseTraceBackend({ requested: 'native', runtimeBackend: 'gpu', locator: locatorFor(async () => ({})) });
  assert.equal(notEngine.backend, 'gpu');
  assert.match(notEngine.note, /cannot use @codepawlhq\/cook: .*no describeEngine/);
  const outdated = fakeEngine({ packFormat: { version: 2, revision: 4, readsRevisions: [1, 3] } });
  const mismatch = await chooseTraceBackend({ requested: 'native', runtimeBackend: 'gpu', locator: locatorFor(async () => outdated) });
  assert.match(mismatch.note, /revision 4/);
});

test('COOK_DISABLE=1 acts like an absent package and never imports', async () => {
  const saved = process.env.COOK_DISABLE;
  process.env.COOK_DISABLE = '1';
  try {
    const locator = locatorFor(async () => { throw new Error('must not be imported'); });
    const choice = await chooseTraceBackend({ requested: 'native', runtimeBackend: 'gpu', locator });
    assert.equal(choice.backend, 'gpu');
    assert.match(choice.note, /needs @codepawlhq\/cook/);
  } finally {
    if (saved === undefined) delete process.env.COOK_DISABLE;
    else process.env.COOK_DISABLE = saved;
  }
});

test('COOK_PACKAGE_PATH imports that checkout by file URL and a wrong path says so', async () => {
  const saved = process.env.COOK_PACKAGE_PATH;
  try {
    process.env.COOK_PACKAGE_PATH = 'no-such-cook-checkout';
    const missing = await locatorFor(async () => { throw new Error('must not be imported'); }).find();
    assert.match(missing.reason, /found no index\.mjs in COOK_PACKAGE_PATH/);
    process.env.COOK_PACKAGE_PATH = fileURLToPath(new URL('../scripts', import.meta.url));
    const specifiers = [];
    const locator = locatorFor(async specifier => { specifiers.push(specifier); throw moduleNotFound(specifier); });
    await locator.find();
    assert.equal(specifiers.length, 0, 'a folder without index.mjs is refused before any import');
  } finally {
    if (saved === undefined) delete process.env.COOK_PACKAGE_PATH;
    else process.env.COOK_PACKAGE_PATH = saved;
  }
});

test('a time limit is recognised by the Cook error code, and by the old message', () => {
  assert.equal(isNativeTimeLimitError(Object.assign(new Error('x'), { code: 'COOK_TIME_LIMIT' })), true);
  assert.equal(isNativeTimeLimitError(new Error('the trace passed its time limit')), true);
  assert.equal(isNativeTimeLimitError(new Error('no adapter')), false);
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

// A sequence that returns flat frames of the given brightness, each through a session with the same camera block.
function sequenceOfFlatFrames(levels, { withoutSessionAt = -1, changedSceneAt = -1 } = {}) {
  const pixels = 4 * 4;
  const kernelParams = new Uint8Array(320);
  const view = new DataView(kernelParams.buffer);
  [[0, 0, 0], [0, 0, -1], [1, 0, 0], [0, 1, 0]].forEach((vector, row) => vector.forEach((value, axis) => view.setFloat32(112 + row * 16 + axis * 4, value, true)));
  let frame = 0;
  return {
    trace() {
      const level = levels[frame];
      const index = frame++;
      const normal = new Float32Array(pixels * 3);
      for (let pixel = 0; pixel < pixels; pixel++) normal[pixel * 3 + 2] = 1;
      const traced = { rgba: new Float32Array(pixels * 4).fill(level), albedo: new Float32Array(pixels * 3).fill(0.5), normal,
        depth: new Float32Array(pixels).fill(3), variance: new Float32Array(pixels), adapter: 'test adapter', backend: 'test' };
      if (index === withoutSessionAt) return { traced, route: { path: 'one-shot', reason: 'test' } };
      return { traced, route: { path: index === 0 ? 'new-session' : index === changedSceneAt ? 'updated' : 'reused' }, kernelParams };
    },
  };
}

test('a temporal accumulator blends the filtered session frames and leaves rawLinear as traced', async () => {
  const { createTemporalAccumulator } = await import('../scripts/agent-native-temporal.mjs');
  const temporal = createTemporalAccumulator({ width: 4, height: 4 });
  const sequence = sequenceOfFlatFrames([1, 0, 0]);
  const frameOptions = { tracer: {}, sequence, temporal, exported: emptyExport, width: 4, height: 4, samples: 8, denoise: 'none', kernel: 'cycles' };
  const first = await traceFrameNative(frameOptions);
  assert.equal(first.report.temporal.restarted, 'the first frame of the job');
  assert.equal(first.linear[0], 1);
  const second = await traceFrameNative(frameOptions);
  assert.equal(second.report.temporal.historyShare, 1);
  assert.equal(second.report.temporal.restarted, undefined);
  assert.ok(Math.abs(second.linear[0] - 0.5) < 1e-6, 'the filter input is the blend');
  assert.equal(second.rawLinear[0], 0, 'rawLinear is this frame alone');
  const third = await traceFrameNative(frameOptions);
  assert.ok(Math.abs(third.linear[0] - 1 / 3) < 1e-6);
});

test('a frame whose scene changed, or that left the session, starts the history again', async () => {
  const { createTemporalAccumulator } = await import('../scripts/agent-native-temporal.mjs');
  const temporal = createTemporalAccumulator({ width: 4, height: 4 });
  const sequence = sequenceOfFlatFrames([1, 0, 1, 0, 1], { changedSceneAt: 1, withoutSessionAt: 3 });
  const frameOptions = { tracer: {}, sequence, temporal, exported: emptyExport, width: 4, height: 4, samples: 8, denoise: 'none', kernel: 'cycles' };
  await traceFrameNative(frameOptions);
  const changed = await traceFrameNative(frameOptions);
  assert.equal(changed.report.temporal.restarted, 'the scene changed since the frame before');
  assert.equal(changed.linear[0], 0);
  const blended = await traceFrameNative(frameOptions);
  assert.ok(Math.abs(blended.linear[0] - 0.5) < 1e-6);
  const oneShot = await traceFrameNative(frameOptions);
  assert.equal(oneShot.report.temporal.restarted, 'this frame did not render through a session');
  assert.equal(oneShot.linear[0], 0);
  const after = await traceFrameNative(frameOptions);
  assert.equal(after.report.temporal.restarted, 'the frame before did not render through a session');
  assert.equal(after.linear[0], 1);
});
