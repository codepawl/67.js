import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer67 } from '../src/renderer.js';
import { RenderTargetLedger } from '../src/render-target-ledger.js';
import { createDepthFragmentShader, createDepthVertexShader, createFragmentShader, depthFragmentShader, depthVertexShader } from '../src/shaders.js';

function recordingContext() {
  const calls = [];
  const sizes = [];
  const context = new Proxy({}, {
    get(_, name) {
      if (name === 'texImage2D') return (_target, _level, _format, width, height) => sizes.push([width, height]);
      if (name === 'checkFramebufferStatus') return () => context.FRAMEBUFFER_COMPLETE;
      if (name === 'FRAMEBUFFER_COMPLETE') return 1;
      if (name === 'createTexture' || name === 'createFramebuffer') return () => ({});
      if (typeof name === 'string' && /^[A-Z_0-9]+$/.test(name)) return 1;
      return (...args) => calls.push([name, ...args]);
    },
  });
  return { context, calls, sizes };
}

function tintRenderer(batches, { active = true } = {}) {
  const { context, calls, sizes } = recordingContext();
  const renderer = Object.create(Renderer67.prototype);
  Object.assign(renderer, {
    context, batches, renderTargets: new RenderTargetLedger(), world: null, activeLightDirection: [1, 2, 3], shadowBounds: {},
    lightProjection: new Float32Array(16), windState: { time: 0, strength: 0 }, tintedShadowsActive: active, depthAlphaUniforms: {},
    shadowBiasPerSlope: 0.001, drawShadowCasters() {}, applyAlphaState() {}, drawBatch() {}, selectShadowInstances: () => null,
  });
  return { renderer, calls, sizes };
}

const opaqueBatch = { castShadow: true, tintedShadow: false };
const glassBatch = { castShadow: true, tintedShadow: true, layerState: new Array(10).fill(0) };

test('a scene without blended or transmissive casters draws no tint pass and allocates no tint texture', () => {
  const { renderer, calls, sizes } = tintRenderer([opaqueBatch, { floor: true, castShadow: true }]);
  renderer.createShadowMap();
  assert.deepEqual(sizes, [[2048, 2048]]);
  assert.equal(renderer.tintFramebuffer, undefined);
  assert.deepEqual(renderer.memoryReport().targets.map(target => target.name), ['shadowMap']);
  assert.equal(calls.some(([name]) => name === 'blendFuncSeparate'), false);
});

test('a blended or transmissive caster adds one 1024 half float tint map, and leaves the sun map alone', () => {
  const { renderer, calls, sizes } = tintRenderer([glassBatch]);
  renderer.createShadowMap();
  assert.deepEqual(sizes, [[1, 1], [1024, 1024]]);
  assert.deepEqual(renderer.memoryReport().targets.map(target => target.name).sort(), ['shadowMap', 'tintShadow']);
  assert.equal(renderer.memoryReport().totalBytes, 4 + 1024 * 1024 * 8);
  assert.equal(calls.filter(([name]) => name === 'blendFuncSeparate').length, 1);
  renderer.createShadowMap();
  assert.equal(sizes.length, 2, 'a second shadow pass reuses the tint maps');
});

test('an opaque caster beside glass keeps the full sun map', () => {
  const { renderer, sizes } = tintRenderer([opaqueBatch, glassBatch]);
  renderer.createShadowMap();
  assert.deepEqual(sizes[0], [2048, 2048]);
});

test('with tinting off (cascades, few texture units) glass draws no tint pass', () => {
  const { renderer, sizes } = tintRenderer([glassBatch], { active: false });
  renderer.createShadowMap();
  assert.deepEqual(sizes, [[2048, 2048]]);
  assert.equal(renderer.tintFramebuffer, undefined);
});

test('the tint code is compiled in only for renderers that have a tinting caster', () => {
  assert.equal(createDepthFragmentShader([]), depthFragmentShader);
  assert.equal(createDepthVertexShader([]), depthVertexShader);
  assert.match(createDepthFragmentShader(['tintedShadows']), /tintPass/);
  assert.match(createDepthVertexShader(['tintedShadows']), /tintOpacity/);
  assert.doesNotMatch(depthVertexShader, /tint/);
  assert.match(createFragmentShader(['tintedShadows']), /#define USES_TINTED_SHADOWS \(true\)/);
  assert.match(createFragmentShader([]), /#define USES_TINTED_SHADOWS false/);
});
