import test from 'node:test';
import assert from 'node:assert/strict';
import { CrucibleRenderer } from '../src/renderer.js';
import { RenderTargetLedger } from '../src/render-target-ledger.js';
import { useCompactColor } from '../src/compact-color.js';
import { CascadedShadows } from '../src/cascaded-shadows.js';

const BYTES_PER_MEGABYTE = 1048576;

test('the ledger sizes a target by pixels, layers, samples and format and lists the largest first', () => {
  const ledger = new RenderTargetLedger();
  ledger.record('frameColor', { width: 960, height: 540, format: 'RGBA16F' });
  ledger.record('multisampleColor', { width: 960, height: 540, format: 'RGBA16F', samples: 4 });
  ledger.record('cascades', { width: 2048, height: 2048, layers: 3, format: 'DEPTH_COMPONENT24' });
  const report = ledger.report();
  assert.deepEqual(report.targets.map(target => target.name), ['cascades', 'multisampleColor', 'frameColor']);
  assert.equal(report.targets[1].bytes, 960 * 540 * 4 * 8);
  assert.equal(report.targets[0].bytes, 2048 * 2048 * 3 * 4);
  assert.equal(report.totalBytes, report.targets.reduce((total, target) => total + target.bytes, 0));
  assert.equal(report.totalMegabytes, Number((report.totalBytes / BYTES_PER_MEGABYTE).toFixed(2)));
});

test('the ledger forgets released targets', () => {
  const ledger = new RenderTargetLedger();
  ledger.record('first', { width: 4, height: 4, format: 'R8' });
  ledger.record('second', { width: 4, height: 4, format: 'RGBA8' });
  ledger.release('first', 'missing');
  assert.deepEqual(ledger.report().targets.map(target => target.name), ['second']);
});

function recordingContext() {
  const sizes = [];
  const context = new Proxy({}, {
    get(_, name) {
      if (name === 'texImage2D') return (_target, _level, _format, width, height) => sizes.push([width, height]);
      if (name === 'checkFramebufferStatus') return () => context.FRAMEBUFFER_COMPLETE;
      if (name === 'FRAMEBUFFER_COMPLETE') return 1;
      if (name === 'createTexture' || name === 'createFramebuffer') return () => ({});
      return typeof name === 'string' && /^[A-Z_0-9]+$/.test(name) ? 1 : () => {};
    },
  });
  return { context, sizes };
}

function shadowRenderer(batches) {
  const { context, sizes } = recordingContext();
  const renderer = Object.create(CrucibleRenderer.prototype);
  Object.assign(renderer, {
    context, batches, renderTargets: new RenderTargetLedger(), world: null, activeLightDirection: [1, 2, 3], shadowBounds: {},
    lightProjection: new Float32Array(16), windState: { time: 0, strength: 0 }, drawShadowCasters() {},
  });
  return { renderer, sizes };
}

test('a scene with nothing to cast keeps a one texel shadow map and a casting scene keeps the full one', () => {
  const empty = shadowRenderer([{ floor: true, castShadow: true }, { castShadow: false }]);
  empty.renderer.createShadowMap();
  assert.deepEqual(empty.sizes[0], [1, 1]);
  assert.equal(empty.renderer.memoryReport().targets[0].bytes, 4);
  const casting = shadowRenderer([{ castShadow: true }]);
  casting.renderer.createShadowMap();
  assert.deepEqual(casting.sizes[0], [2048, 2048]);
  assert.equal(casting.renderer.memoryReport().totalBytes, 2048 * 2048 * 4);
});

test('the local shadow atlas holds one row of tiles per four shadow tiles and regrows when more are needed', () => {
  const { renderer, sizes } = shadowRenderer([]);
  renderer.allocateLocalShadowAtlas(1);
  renderer.allocateLocalShadowAtlas(6);
  assert.deepEqual(sizes, [[2048, 512], [2048, 1024]]);
  assert.equal(renderer.memoryReport().targets[0].height, 1024);
});

function frameTargetRenderer(depth) {
  const { context } = recordingContext();
  const renderer = Object.create(CrucibleRenderer.prototype);
  Object.assign(renderer, {
    context, depth, hdr: true, multisampleSamples: 4, renderTargets: new RenderTargetLedger(), releaseFrameTargets() {},
  });
  return renderer;
}

test('the multisampled depth is never 16 bits, with or without a depth texture', () => {
  const plain = frameTargetRenderer(false);
  plain.allocateFrameTargets(960, 540);
  const plainDepth = plain.memoryReport().targets.find(target => target.name === 'multisampleDepth');
  assert.equal(plainDepth.format, 'DEPTH_COMPONENT24');
  assert.equal(plainDepth.bytes, 960 * 540 * 4 * 4);
  const withTexture = frameTargetRenderer(true);
  withTexture.allocateFrameTargets(960, 540);
  const textureDepth = withTexture.memoryReport().targets.find(target => target.name === 'multisampleDepth');
  assert.equal(textureDepth.format, 'DEPTH_COMPONENT24');
  assert.equal(textureDepth.bytes, 960 * 540 * 4 * 4);
});

test('the single shadow map follows the casters: it grows when casters arrive and shrinks when they leave', () => {
  const batches = [{ floor: true, castShadow: true }];
  const { renderer, sizes } = shadowRenderer(batches);
  renderer.createShadowMap();
  batches.push({ castShadow: true });
  renderer.createShadowMap();
  batches.pop();
  renderer.createShadowMap();
  assert.deepEqual(sizes.map(size => size[0]), [1, 2048, 1]);
  assert.equal(renderer.memoryReport().totalBytes, 4);
});

test('with cascades the single shadow map stays one texel unless volume fog or subsurface reads it', () => {
  const cascaded = shadowRenderer([{ castShadow: true }]);
  cascaded.renderer.shadowCascades = { replacesSingleMap: CascadedShadows.prototype.replacesSingleMap };
  cascaded.renderer.shaderFeatures = new Set();
  cascaded.renderer.createShadowMap();
  assert.equal(cascaded.sizes[0][0], 1);
  cascaded.renderer.volumeShadowWanted = true;
  cascaded.renderer.createShadowMap();
  assert.equal(cascaded.sizes[1][0], 2048);
  const subsurface = shadowRenderer([{ castShadow: true }]);
  subsurface.renderer.shadowCascades = { replacesSingleMap: CascadedShadows.prototype.replacesSingleMap };
  subsurface.renderer.shaderFeatures = new Set(['subsurface']);
  subsurface.renderer.createShadowMap();
  assert.equal(subsurface.sizes[0][0], 2048);
});

function supportingSamples(renderer, samples) {
  const base = renderer.context;
  renderer.context = new Proxy(base, { get: (target, name) => (name === 'getInternalformatParameter' ? () => samples : target[name]) });
}

test('without the compact colour addon the frame and multisample colour stay RGBA16F', () => {
  const renderer = frameTargetRenderer(false);
  renderer.allocateFrameTargets(1920, 1080);
  const byName = Object.fromEntries(renderer.memoryReport().targets.map(target => [target.name, target]));
  assert.equal(byName.multisampleColor.format, 'RGBA16F');
  assert.equal(byName.frameColor.format, 'RGBA16F');
});

test('compact colour halves the frame and multisample colour and keeps the other targets', () => {
  const renderer = frameTargetRenderer(false);
  renderer.canvas = { width: 1920, height: 1080 };
  supportingSamples(renderer, [4, 8]);
  renderer.allocateFrameTargets(1920, 1080);
  const before = Object.fromEntries(renderer.memoryReport().targets.map(target => [target.name, target]));
  useCompactColor(renderer);
  const after = Object.fromEntries(renderer.memoryReport().targets.map(target => [target.name, target]));
  assert.equal(after.multisampleColor.format, 'R11F_G11F_B10F');
  assert.equal(after.frameColor.format, 'R11F_G11F_B10F');
  assert.equal(after.multisampleColor.bytes * 2, before.multisampleColor.bytes);
  assert.equal(after.frameColor.bytes * 2, before.frameColor.bytes);
  assert.equal(after.multisampleDepth.bytes, before.multisampleDepth.bytes);
});

test('compact colour needs HDR, an opaque canvas and a sample count the format supports', () => {
  assert.throws(() => useCompactColor({ hdr: false }), /needs hdr: true/);
  assert.throws(() => useCompactColor({ hdr: true, transparent: true }), /needs hdr: true/);
  const unsupported = frameTargetRenderer(false);
  supportingSamples(unsupported, [2]);
  assert.throws(() => useCompactColor(unsupported), /does not support 4 samples/);
});
