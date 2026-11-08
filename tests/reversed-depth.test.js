import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4, vec4 } from 'gl-matrix';
import { exceedsFarToNearLimit, hasFarOverlap, installReversedDepth, reverseProjectionDepth } from '../src/reversed-depth.js';


function depthAt(projection, eyeDistance) {
  const clip = vec4.transformMat4(vec4.create(), [0, 0, -eyeDistance, 1], projection);
  return clip[2] / clip[3];
}

test('a reversed perspective projection maps the near plane to 1 and the far plane to 0', () => {
  const standard = mat4.perspective(mat4.create(), Math.PI / 4, 1.5, 0.1, 600);
  const reversed = reverseProjectionDepth(mat4.create(), standard);
  assert.ok(Math.abs(depthAt(reversed, 0.1) - 1) < 1e-5);
  assert.ok(Math.abs(depthAt(reversed, 600)) < 1e-5);
  assert.ok(depthAt(reversed, 5) > depthAt(reversed, 50));
});

test('the reversed depth is one minus the standard depth mapped to 0..1, so a pass can turn it back', () => {
  const standard = mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.1, 100);
  const reversed = reverseProjectionDepth(mat4.create(), standard);
  for (const distance of [0.5, 3, 40, 99]) {
    const standardDepth = (depthAt(standard, distance) + 1) / 2;
    assert.ok(Math.abs(1 - depthAt(reversed, distance) - standardDepth) < 1e-5);
  }
});

test('an orthographic projection reverses too, and x, y and w are untouched', () => {
  const standard = mat4.ortho(mat4.create(), -2, 2, -1, 1, 0.1, 100);
  const reversed = reverseProjectionDepth(mat4.create(), standard);
  assert.ok(Math.abs(depthAt(reversed, 0.1) - 1) < 1e-5);
  assert.ok(Math.abs(depthAt(reversed, 100)) < 1e-5);
  for (const index of [0, 1, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15]) assert.equal(reversed[index], standard[index]);
});

function fakeRenderer({ extension = {}, benchmark = false } = {}) {
  const drawn = [];
  const renderer = {
    benchmark,
    capabilities: {},
    postStages: [],
    context: { getExtension: name => (name === 'EXT_clip_control' ? extension : null) },
    render: frame => drawn.push(frame),
    applyEnvironmentUniforms() {},
    applyDepthLayer() {},
    resolveFrame() {},
    allocateFrameTargets() {},
  };
  return { renderer, drawn };
}

test('the far to near rule: a lens over 10,000 to 1 asks for reversed depth, the default lens does not', () => {
  assert.equal(exceedsFarToNearLimit({ far: 600 }), false);
  assert.equal(exceedsFarToNearLimit({ far: 1000, near: 0.1 }), false);
  assert.equal(exceedsFarToNearLimit({ far: 2000, near: 0.1 }), true);
  assert.equal(exceedsFarToNearLimit({ far: 100, near: 0.001 }), true);
});

test('auto mode stays off until a frame or a request asks, true forces it and false never switches it on', () => {
  const automatic = fakeRenderer();
  installReversedDepth(automatic.renderer);
  automatic.renderer.render({ far: 600 });
  assert.equal(automatic.renderer.reversedDepth, undefined);
  automatic.renderer.render({ far: 5000, near: 0.1 });
  assert.equal(automatic.renderer.reversedDepth, true);
  assert.equal(automatic.renderer.postStages.length, 1);
  assert.equal(automatic.drawn.length, 2);

  const requested = fakeRenderer();
  installReversedDepth(requested.renderer, 'auto');
  requested.renderer.requestReversedDepth();
  requested.renderer.render({ far: 600 });
  assert.equal(requested.renderer.reversedDepth, true);

  const forced = fakeRenderer();
  installReversedDepth(forced.renderer, true);
  assert.equal(forced.renderer.reversedDepth, true);

  const off = fakeRenderer();
  installReversedDepth(off.renderer, false);
  off.renderer.render({ far: 1e6, near: 0.1 });
  assert.equal(off.renderer.reversedDepth, false);
  assert.equal(off.renderer.requestReversedDepth, undefined);
});

test('without the extension, or in benchmark mode, the standard path stays', () => {
  const missing = fakeRenderer({ extension: null });
  installReversedDepth(missing.renderer, true);
  assert.equal(missing.renderer.reversedDepth, false);
  const benchmark = fakeRenderer({ benchmark: true });
  installReversedDepth(benchmark.renderer, 'auto');
  benchmark.renderer.render({ far: 1e6, near: 0.1 });
  assert.equal(benchmark.renderer.reversedDepth, false);
  assert.equal(benchmark.renderer.postStages.length, 0);
});

test('a flush pair far from the eye asks for reversed depth, a near one does not', () => {
  const view = mat4.create();
  const pairAt = z => [{ smaller: { matrix: new Float32Array(mat4.fromTranslation(mat4.create(), [0, 0, z])) } }];
  assert.equal(hasFarOverlap(pairAt(-5), view), false);
  assert.equal(hasFarOverlap(pairAt(-100), view), true);
  assert.equal(hasFarOverlap([], view), false);
});

test('the main vertex shader is compiled camera-relative only through the addon, and only that program', async () => {
  const { createVertexShader, SHADER_FEATURES } = await import('../src/shaders.js');
  const { shaderTransforms } = await import('../src/shader-registry.js');
  const compile = source => shaderTransforms.reduce((text, transform) => transform(text), source);
  const mainSource = createVertexShader(SHADER_FEATURES.filter(feature => !['crowd', 'skin', 'morph'].includes(feature)));
  assert.equal(compile(mainSource), mainSource);

  const { renderer } = fakeRenderer();
  const compiled = [];
  renderer.shaderFeatures = new Set();
  renderer.startMainProgram = () => compiled.push(compile(mainSource));
  renderer.rebuildMainProgram = function rebuild() {
    this.startMainProgram();
  };
  installReversedDepth(renderer, true);
  const [cameraRelative] = compiled;
  assert.match(cameraRelative, /uniform vec4 cameraOffset;/);
  assert.match(cameraRelative, /gl_Position = viewProjection \* vec4\(world\.xyz - cameraOffset\.xyz, 1\.0 - cameraOffset\.w\) \+ cameraShift;/);
  assert.doesNotMatch(cameraRelative, /gl_Position = viewProjection \* world;/);
  assert.equal(compile(mainSource), mainSource);
});

test('the renderer loads reversed depth itself for a stretched lens, once, and not when the mode is false', async () => {
  const { Renderer67 } = await import('../src/renderer.js');
  const stretched = { far: 9000, near: 0.08 };
  const automatic = Object.create(Renderer67.prototype);
  automatic.reversedDepthMode = 'auto';
  automatic.loadReversedDepthFor({ far: 100, near: 0.1 });
  assert.equal(automatic.reversedDepthReady ?? null, null);
  automatic.loadReversedDepthFor(stretched);
  assert.ok(automatic.reversedDepthReady instanceof Promise);
  const first = automatic.reversedDepthReady;
  automatic.loadReversedDepthFor(stretched);
  assert.equal(automatic.reversedDepthReady, first);
  await first.catch(() => {});

  const disabled = Object.create(Renderer67.prototype);
  disabled.reversedDepthMode = false;
  disabled.loadReversedDepthFor(stretched);
  assert.equal(disabled.reversedDepthReady ?? null, null);
});
