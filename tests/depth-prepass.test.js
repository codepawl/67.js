import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREPASS_MAXIMUM_TRIANGLES_PER_PIXEL,
  PREPASS_MINIMUM_TRIANGLES,
  batchTakesDepthPrepass,
  depthPrepassFragmentShader,
  shouldUseDepthPrepass,
  validateDepthPrepassMode,
} from '../src/depth-prepass.js';
import { createVertexShader } from '../src/shaders.js';

const HD_PIXELS = 1280 * 720;
const UHD_PIXELS = 3840 * 2160;

function opaqueBatch(overrides = {}) {
  return { alphaMode: 'opaque', opacity: 1, parts: [{ material: { tag: 'rock' } }], ...overrides };
}

test('the mode must be true, false or auto, and the error says what to pass', () => {
  for (const mode of [true, false, 'auto']) assert.equal(validateDepthPrepassMode(mode), mode);
  assert.throws(() => validateDepthPrepassMode('yes'), /depthPrepass must be true, false or 'auto'.*Pass 'auto'/);
  assert.throws(() => validateDepthPrepassMode(undefined), TypeError);
});

test('true forces the prepass whenever there is something to draw, false never draws it', () => {
  assert.equal(shouldUseDepthPrepass(true, 10, HD_PIXELS), true);
  assert.equal(shouldUseDepthPrepass(true, 0, HD_PIXELS), false);
  assert.equal(shouldUseDepthPrepass(false, 5e6, HD_PIXELS), false);
});

test('auto draws the prepass only for many large triangles', () => {
  const dense = HD_PIXELS * 2;
  assert.equal(shouldUseDepthPrepass('auto', dense, HD_PIXELS), false, 'sub-pixel triangles: a depth pass cannot remove them');
  assert.equal(shouldUseDepthPrepass('auto', 50000, HD_PIXELS * 4), false, 'too few triangles to repay the extra draw calls');
  const large = Math.floor(UHD_PIXELS * PREPASS_MAXIMUM_TRIANGLES_PER_PIXEL);
  assert.ok(large >= PREPASS_MINIMUM_TRIANGLES);
  assert.equal(shouldUseDepthPrepass('auto', large, UHD_PIXELS), true);
  assert.equal(shouldUseDepthPrepass('auto', large + 1, UHD_PIXELS), false);
  assert.equal(shouldUseDepthPrepass('auto', 0, HD_PIXELS), false);
  assert.equal(shouldUseDepthPrepass('auto', large, 0), false);
});

test('only opaque, plain batches take part: cutouts, snippets, splats, impostors and fades stay out', () => {
  assert.equal(batchTakesDepthPrepass(opaqueBatch()), true);
  assert.equal(batchTakesDepthPrepass(opaqueBatch({ alphaMode: 'mask' })), false);
  assert.equal(batchTakesDepthPrepass(opaqueBatch({ alphaMode: 'blend' })), false);
  assert.equal(batchTakesDepthPrepass(opaqueBatch({ splat: {} })), false);
  assert.equal(batchTakesDepthPrepass(opaqueBatch({ parts: [{ material: { snippet: { feature: 'x' } } }] })), false);
  assert.equal(batchTakesDepthPrepass(opaqueBatch({ parts: [{ material: { tag: 'impostor' } }] })), false);
  assert.equal(batchTakesDepthPrepass(opaqueBatch({ opacity: 1.5 })), false);
  assert.equal(batchTakesDepthPrepass(opaqueBatch({ pass: 'translucent' })), false);
});

test('the colour vertex shader fixes gl_Position so the prepass program writes the same depth', () => {
  assert.match(createVertexShader([]), /invariant gl_Position;/);
  assert.match(depthPrepassFragmentShader, /outputColor = vec4\(0\.0\)/);
  assert.ok(!depthPrepassFragmentShader.includes('texture('), 'the prepass fragment shader reads nothing');
});
