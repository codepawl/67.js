import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseTraceBackend, createNativeTracerLocator } from '../scripts/agent-native-trace.mjs';

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
