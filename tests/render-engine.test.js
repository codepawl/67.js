import assert from 'node:assert/strict';
import test from 'node:test';
import { clampLimitsByEngine, requireRenderEngine } from '../scripts/render-engine.mjs';

function completeEngine(overrides = {}) {
  return {
    describeEngine: () => ({
      name: 'fake',
      version: '1.0.0',
      packFormat: { version: 2, revision: 3, readsRevisions: [1, 3] },
      denoisers: ['none', 'atrous', 'oidn'],
      sessions: { kernels: ['cycles'] },
      limits: { triangles: null, instances: 500, pixels: 1000 },
    }),
    findNativeAddon: () => '/build/fake.node',
    traceNative() {},
    traceNativeTexels() {},
    createNativeSession() {},
    planNativeSessionUpdate() {},
    prepareCyclesInput() {},
    denoiseAtrous() {},
    createNativeOidnDenoiser() {},
    ...overrides,
  };
}

function engineWithDescription(changes) {
  const engine = completeEngine();
  const base = engine.describeEngine();
  engine.describeEngine = () => ({ ...base, ...changes });
  return engine;
}

test('a complete engine is accepted with its description', () => {
  const engineModule = completeEngine();
  const result = requireRenderEngine(engineModule);
  assert.equal(result.reason, undefined);
  assert.equal(result.engine, engineModule);
  assert.equal(result.description.name, 'fake');
});

test('an engine missing a required call gives one reason that names it', () => {
  const { traceNativeTexels, ...withoutTexels } = completeEngine();
  const result = requireRenderEngine(withoutTexels);
  assert.equal(result.engine, undefined);
  assert.match(result.reason, /no traceNativeTexels/);
  assert.match(requireRenderEngine({}).reason, /describeEngine or findNativeAddon or traceNative or traceNativeTexels/);
});

test('a module that is not an object, or whose description throws, gives a reason and never throws', () => {
  assert.match(requireRenderEngine(null).reason, /did not load/);
  const broken = completeEngine({ describeEngine() { throw new Error('boom'); } });
  assert.match(requireRenderEngine(broken).reason, /describeEngine\(\) threw an error \(boom\)/);
  const notObject = completeEngine({ describeEngine: () => 'text' });
  assert.match(requireRenderEngine(notObject).reason, /did not return an object/);
});

test('a pack revision outside what the engine reads is refused with both revisions named', () => {
  const tooNew = engineWithDescription({ packFormat: { version: 2, revision: 5, readsRevisions: [1, 3] } });
  const reason = requireRenderEngine(tooNew).reason;
  assert.match(reason, /fake/);
  assert.match(reason, /revision 5/);
  assert.match(reason, /1 to 3/);
  const withoutRange = engineWithDescription({ packFormat: { version: 2, revision: 3 } });
  assert.match(requireRenderEngine(withoutRange).reason, /readsRevisions/);
});

test('sessions and denoisers are required only when the description offers them', () => {
  const { createNativeSession, denoiseAtrous, ...partial } = completeEngine();
  const result = requireRenderEngine(partial);
  assert.match(result.reason, /offers sessions but it has no createNativeSession/);
  assert.match(result.reason, /"atrous" denoiser but it has no denoiseAtrous/);
  const plain = {
    ...partial,
    describeEngine: () => ({ ...completeEngine().describeEngine(), sessions: null, denoisers: ['none'] }),
  };
  assert.ok(requireRenderEngine(plain).engine);
});

test('Crucible limits are lowered by the limits an engine declares, and null declares none', () => {
  const defaults = { triangles: 1500000, instances: 1000000, pixels: 50 };
  const declared = { triangles: null, instances: 500, pixels: 1000, samples: 8 };
  assert.deepEqual(clampLimitsByEngine(defaults, declared), { triangles: 1500000, instances: 500, pixels: 50 });
  assert.deepEqual(clampLimitsByEngine(defaults, undefined), defaults);
});
