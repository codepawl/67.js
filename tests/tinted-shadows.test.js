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

test('the shadow program never samples the sun map it is rendering into (that feedback loop dropped every opaque caster)', () => {
  const { renderer, calls } = tintRenderer([opaqueBatch, glassBatch]);
  renderer.depthAlphaUniforms = { opaqueShadow: 'opaqueShadow' };
  renderer.depthWindUniforms = {};
  renderer.drawShadowCasters = Renderer67.prototype.drawShadowCasters;
  renderer.drawShadowCasters(renderer.lightProjection, 2048, true);
  const unitSet = calls.find(([name, location]) => name === 'uniform1i' && location === 'opaqueShadow');
  assert.ok(unitSet, 'the sampler is pointed away from its default unit 0');
  assert.notEqual(unitSet[2], 0);
  renderer.drawTintedShadows();
  const bound = calls.filter(([name]) => name === 'bindTexture').map(call => call[2]);
  assert.ok(bound.length > 0);
  const unitBeforeBind = calls.findIndex(([name, unit]) => name === 'activeTexture' && unit - 1 === unitSet[2]);
  assert.ok(unitBeforeBind >= 0, 'the tint draw binds the sun map on the sampler unit');
});

test('while a depth map renders, the comparison sampler of the shadow program reads a depth placeholder, not a 2D map or the target (WebGL error 1282 on SwiftShader)', () => {
  const { renderer, calls } = tintRenderer([opaqueBatch, glassBatch]);
  renderer.shadowTexture = { name: 'sunMap' };
  renderer.depthAlphaUniforms = { opaqueShadow: 'opaqueShadow' };
  renderer.depthWindUniforms = {};
  renderer.drawShadowCasters = Renderer67.prototype.drawShadowCasters;
  renderer.bindPlaceholderOpaqueShadow = Renderer67.prototype.bindPlaceholderOpaqueShadow;
  renderer.drawShadowCasters(renderer.lightProjection, 2048, true);
  const unitSet = calls.find(([name, location]) => name === 'uniform1i' && location === 'opaqueShadow')[2];
  const placeholderBind = calls.filter(([name]) => name === 'bindTexture').pop();
  assert.ok(placeholderBind[2] && placeholderBind[2] !== renderer.shadowTexture, 'a placeholder texture, not the sun map');
  const unitBeforeBind = calls.slice(0, calls.indexOf(placeholderBind)).filter(([name]) => name === 'activeTexture').pop();
  assert.equal(unitBeforeBind[1] - 1, unitSet, 'bound on the unit the sampler reads');
  assert.ok(calls.some(([name, , parameter]) => name === 'texParameteri' && parameter === 1), 'the placeholder compares on fetch');
});
