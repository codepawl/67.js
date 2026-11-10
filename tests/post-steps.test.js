import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mat4 } from 'gl-matrix';
import { resolveEffects } from '../src/effects.js';
import { normalizeAgentLook } from '../src/agent-look.js';
import { agentSceneModulesNeeded, loadAgentSceneModules } from '../src/agent-scene-modules.js';
import { installCameraEffects } from '../src/camera-effects.js';
import { installPostSteps, resolvePostSteps, glareFragment, lensDistortionFragment, colorBalanceFragment, stylizeFragment, compositeFragment, usesObjectMask } from '../src/post-steps.js';
import { createAgentScene } from '../src/agent-scene.js';

function recordingContext(calls) {
  return new Proxy({}, {
    get(target, name) {
      if (typeof name === 'symbol') return undefined;
      if (/^[A-Z0-9_]+$/.test(name)) return 1;
      if (name === 'checkFramebufferStatus') return () => 1;
      return (...args) => {
        calls.push([name, ...args]);
        return true;
      };
    },
  });
}

function fakeRenderer(context) {
  return {
    postStages: [], context, canvas: { width: 16, height: 9 }, hdr: false, depthTexture: 'depth',
    inverseViewProjection: mat4.create(), viewForward: [0, 0, -1],
  };
}

const STAGE_NAMES = ['Glare', 'Lens distortion', 'Color balance', 'Stylize', 'Composite'];

test('a look that names no step resolves exactly as before', async () => {
  await loadAgentSceneModules({});
  const effects = normalizeAgentLook({}).effects;
  for (const field of ['colorBalance', 'glare', 'lensDistortion', 'stylize']) assert.equal(Object.hasOwn(effects, field), false);
  assert.deepEqual(resolveEffects({}), resolveEffects({ saturation: 1 }));
});

test('each named step resolves with defaults and refuses bad input', () => {
  assert.deepEqual(resolvePostSteps({ colorBalance: {} }).colorBalance, { lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1] });
  assert.deepEqual(resolvePostSteps({ glare: { streaks: 0.5 } }).glare, { streaks: 0.5, count: 4, angle: 0, fogGlow: 0, threshold: 1, size: 0.15 });
  assert.deepEqual(resolvePostSteps({ glare: { streaks: 1, count: 2, angle: 30 } }).glare, { streaks: 1, count: 2, angle: 30, fogGlow: 0, threshold: 1, size: 0.15 });
  assert.throws(() => resolvePostSteps({ glare: { count: 2.5 } }), /whole number/);
  assert.throws(() => resolvePostSteps({ glare: { count: 9 } }), /glare.count must be between/);
  assert.throws(() => resolvePostSteps({ glare: { angle: 400 } }), /glare.angle must be between/);
  assert.deepEqual(resolvePostSteps({ lensDistortion: { dispersion: 1 } }).lensDistortion, { distortion: 0, dispersion: 1 });
  assert.deepEqual(resolvePostSteps({ saturation: 1 }), {});
  assert.throws(() => resolvePostSteps({ colorBalance: { lift: [0, 0] } }), /three numbers/);
  assert.throws(() => resolvePostSteps({ colorBalance: { gamma: [0, 1, 1] } }), /colorBalance.gamma\[0\] must be between/);
  assert.throws(() => resolvePostSteps({ colorBalance: { shadows: 1 } }), /Unknown colorBalance field/);
  assert.throws(() => resolvePostSteps({ glare: { streaks: 2 } }), /glare.streaks must be between/);
  assert.throws(() => resolvePostSteps({ glare: [] }), /glare must be an object/);
  assert.throws(() => resolvePostSteps({ lensDistortion: { distortion: -2 } }), /lensDistortion.distortion must be between/);
});

test('a recipe that names a step loads the module, validates it and keeps the group in the look', async () => {
  const look = { effects: { glare: { fogGlow: 0.4 }, lensDistortion: { distortion: 0.2 } } };
  assert.ok(agentSceneModulesNeeded(look).includes('postSteps'));
  assert.equal(agentSceneModulesNeeded({ effects: { bloom: { strength: 0.3 } } }).includes('postSteps'), false);
  await loadAgentSceneModules(look);
  const effects = normalizeAgentLook(look).effects;
  assert.equal(effects.glare.fogGlow, 0.4);
  assert.equal(effects.lensDistortion.distortion, 0.2);
  assert.equal(Object.hasOwn(effects, 'colorBalance'), false);
  assert.throws(() => normalizeAgentLook({ effects: { glare: { streaks: 3 } } }), /glare.streaks/);
  assert.throws(() => normalizeAgentLook({ effects: { sparkle: 1 } }), /sparkle/);
  // The resolved group resolves to itself, so a frame can carry the look's effects as they are.
  assert.deepEqual(resolvePostSteps(effects).glare, effects.glare);
});

test('an edit adds a step to a scene that has none', async () => {
  await loadAgentSceneModules({ effects: { colorBalance: {} } });
  const scene = createAgentScene({ format: '67js.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [] });
  scene.apply([{ type: 'set-effects', effects: { colorBalance: { gain: [1.2, 1, 0.8] } } }], { expectedRevision: scene.revision });
  assert.deepEqual(scene.effects.colorBalance.gain, [1.2, 1, 0.8]);
});

test('each stage draws only for a frame that sets its step, and frees its target', () => {
  const calls = [];
  const context = recordingContext(calls);
  const renderer = installPostSteps(installCameraEffects(fakeRenderer(context)));
  assert.deepEqual(renderer.postStages.slice(2).map(stage => stage.name), STAGE_NAMES);
  assert.equal(installPostSteps(renderer).postStages.length, 7);
  const unset = { eye: [0, 1, 5], effects: {} };
  const neutral = { eye: [0, 1, 5], effects: { colorBalance: {}, glare: {}, lensDistortion: {}, stylize: {}, composite: {} } };
  const named = [
    ['Glare', { glare: { streaks: 0.6 } }],
    ['Lens distortion', { lensDistortion: { distortion: 0.5, dispersion: 0.5 } }],
    ['Color balance', { colorBalance: { gain: [1.1, 1, 0.9] } }],
    ['Stylize', { stylize: { posterize: 4 } }],
    ['Composite', { composite: { background: { color: [0.1, 0.2, 0.6] }, key: { luma: { low: 0.1, high: 0.4 } } } }],
  ];
  const effects = resolveEffects({});
  for (const [name, input] of named) {
    const stage = renderer.postStages.find(candidate => candidate.name === name);
    assert.equal(stage.apply(renderer, unset, effects, 'source'), null, `${name} is off when unset`);
    assert.equal(stage.apply(renderer, neutral, effects, 'source'), null, `${name} is off at its neutral values`);
    assert.ok(stage.apply(renderer, { eye: [0, 1, 5], effects: input }, effects, 'source'), `${name} draws`);
    stage.releaseTargets(context);
    stage.dispose(context);
  }
  assert.ok(calls.filter(call => call[0] === 'drawArrays').length === 5);
  assert.ok(calls.filter(call => call[0] === 'deleteTexture').length === 5);
});

test('a stylize step resolves its filters and a mask, and refuses bad input', () => {
  assert.deepEqual(resolvePostSteps({ stylize: {} }).stylize, {});
  assert.deepEqual(resolvePostSteps({ stylize: { sharpen: 1, kuwahara: 3, posterize: 5, pixelate: 8 } }).stylize, { sharpen: 1, kuwahara: 3, posterize: 5, pixelate: 8 });
  assert.throws(() => resolvePostSteps({ stylize: { kuwahara: 9 } }), /stylize.kuwahara must be between/);
  assert.throws(() => resolvePostSteps({ stylize: { pixelate: 2.5 } }), /whole number/);
  assert.throws(() => resolvePostSteps({ stylize: { sharpen: -1 } }), /stylize.sharpen must be between/);
  assert.throws(() => resolvePostSteps({ stylize: { blur: 1 } }), /Unknown stylize field/);
});

test('a mask names parts or a depth range, and says what to pass when it is wrong', () => {
  const mask = resolvePostSteps({ colorBalance: { mask: { objects: ['hero'], depth: { near: 2, far: 8 }, invert: true } } }).colorBalance.mask;
  assert.deepEqual(mask, { invert: true, objects: ['hero'], depth: { near: 2, far: 8, feather: 0 } });
  assert.deepEqual(resolvePostSteps({ stylize: { mask: { depth: { far: 5 } } } }).stylize.mask, { invert: false, depth: { near: 0, far: 5, feather: 0 } });
  assert.equal(resolvePostSteps({ colorBalance: {} }).colorBalance.mask, undefined);
  assert.throws(() => resolvePostSteps({ colorBalance: { mask: {} } }), /colorBalance.mask needs a source/);
  assert.throws(() => resolvePostSteps({ colorBalance: { mask: { objects: [] } } }), /1 to 16 part names/);
  assert.throws(() => resolvePostSteps({ colorBalance: { mask: { objects: Array(17).fill('a') } } }), /1 to 16 part names/);
  assert.throws(() => resolvePostSteps({ colorBalance: { mask: { objects: [3] } } }), /mask.objects\[0\] must be a part name/);
  assert.throws(() => resolvePostSteps({ colorBalance: { mask: { depth: { near: 5, far: 5 } } } }), /far must be greater than near/);
  assert.throws(() => resolvePostSteps({ colorBalance: { mask: { depth: { feather: -1 } } } }), /feather must be between/);
  assert.throws(() => resolvePostSteps({ colorBalance: { mask: { objects: ['a'], color: 1 } } }), /Unknown colorBalance.mask field/);
  assert.throws(() => resolvePostSteps({ colorBalance: { mask: { objects: ['a'], invert: 1 } } }), /invert must be true or false/);
  assert.equal(usesObjectMask(resolvePostSteps({ colorBalance: { mask: { objects: ['hero'] } } })), true);
  assert.equal(usesObjectMask(resolvePostSteps({ colorBalance: { mask: { depth: { far: 5 } } }, stylize: { pixelate: 4 } })), false);
});

test('a stage binds the part numbers of a masked step and refuses an unknown part', () => {
  const calls = [];
  const context = recordingContext(calls);
  const renderer = installPostSteps(installCameraEffects(fakeRenderer(context)));
  renderer.passSupport = { texture: 'ids', objectNames: () => ['floor', 'hero', 'post', 'hero'] };
  const stage = renderer.postStages.find(candidate => candidate.name === 'Color balance');
  const effects = resolveEffects({});
  const frame = mask => ({ eye: [0, 1, 5], effects: { colorBalance: { gain: [1.2, 1, 1], mask } } });
  assert.ok(stage.apply(renderer, frame({ objects: ['hero'] }), effects, 'source'));
  const bound = calls.find(call => call[0] === 'uniform1iv');
  assert.deepEqual([...bound[2]].slice(0, 3), [2, 4, 0]);
  assert.throws(() => stage.apply(renderer, frame({ objects: ['ghost'] }), effects, 'source'), /"ghost" is not a part in the frame\. Fix: use a part name such as "floor"/);
  const afterDraw = calls.slice(calls.findLastIndex(call => call[0] === 'drawArrays') + 1);
  const unbind = afterDraw.findIndex(call => call[0] === 'bindTexture' && call[2] === null);
  assert.ok(unbind > 0 && afterDraw[unbind - 1][0] === 'activeTexture', 'the object ID texture is unbound from its unit after the draw');
  renderer.passSupport = null;
  assert.throws(() => stage.apply(renderer, frame({ objects: ['hero'] }), effects, 'source'), /installRenderPasses/);
  stage.releaseTargets(context);
  stage.dispose(context);
});

test('a mask cannot be combined with an active lens distortion, which warps the image the mask is not warped with', () => {
  const masked = { colorBalance: { gain: [1.2, 1, 1], mask: { depth: { far: 5 } } } };
  assert.throws(() => resolvePostSteps({ ...masked, lensDistortion: { distortion: 0.2 } }), /colorBalance.mask cannot be combined with lensDistortion/);
  assert.throws(() => resolvePostSteps({ stylize: { pixelate: 4, mask: { depth: { far: 5 } } }, lensDistortion: { dispersion: 0.3 } }), /stylize.mask cannot be combined/);
  assert.ok(resolvePostSteps({ ...masked, lensDistortion: {} }).colorBalance.mask);
  assert.ok(resolvePostSteps({ lensDistortion: { distortion: 0.2 }, colorBalance: { gain: [1.2, 1, 1] } }).lensDistortion);
});

test('a composite step resolves a background and a key, and says what to pass when it is wrong', () => {
  const resolved = resolvePostSteps({ composite: { background: { top: [1, 0, 0], bottom: [0, 0, 1] }, key: { chroma: { color: [0, 1, 0] } } } }).composite;
  assert.deepEqual(resolved, { background: { top: [1, 0, 0], bottom: [0, 0, 1] }, key: { chroma: { color: [0, 1, 0], tolerance: 0.3, softness: 0.1 } } });
  assert.deepEqual(resolvePostSteps({ composite: { background: { color: [0, 0, 0] }, key: { luma: { low: 0.1, high: 0.5, invert: true } } } }).composite.key, { luma: { low: 0.1, high: 0.5, invert: true } });
  assert.deepEqual(resolvePostSteps({ composite: {} }).composite, {});
  assert.throws(() => resolvePostSteps({ composite: { key: { luma: {} } } }), /composite.key needs composite.background/);
  assert.throws(() => resolvePostSteps({ composite: { background: { color: [0, 0, 0], top: [0, 0, 0] } } }), /not both/);
  assert.throws(() => resolvePostSteps({ composite: { background: { top: [0, 0, 0] } } }), /both top and bottom/);
  assert.throws(() => resolvePostSteps({ composite: { background: { color: [0, 0, 0] }, key: {} } }), /exactly one of chroma/);
  assert.throws(() => resolvePostSteps({ composite: { background: { color: [0, 0, 0] }, key: { chroma: {} } } }), /key.chroma.color must be three numbers/);
  assert.throws(() => resolvePostSteps({ composite: { background: { color: [0, 0, 0] }, key: { chroma: { color: [0, 1, 0], tolerance: 2 } } } }), /tolerance must be between/);
  assert.throws(() => resolvePostSteps({ composite: { background: { color: [0, 0, 0] }, key: { luma: { low: 0.5, high: 0.5 } } } }), /high must be greater than low/);
  assert.throws(() => resolvePostSteps({ composite: { background: { color: [0, 0, 0] }, mask: { depth: { far: 5 } } } }), /mask limits the key/);
  assert.throws(() => resolvePostSteps({ composite: { image: 'plate.png' } }), /Unknown composite field/);
  const masked = { composite: { background: { color: [0, 0, 0] }, key: { luma: {} }, mask: { objects: ['hero'] } } };
  assert.equal(usesObjectMask(resolvePostSteps(masked)), true);
  assert.throws(() => resolvePostSteps({ ...masked, lensDistortion: { distortion: 0.2 } }), /composite.mask cannot be combined with lensDistortion/);
});

test('the shaders keep their fixed sample patterns and read no history', () => {
  for (const fragment of [glareFragment, lensDistortionFragment, colorBalanceFragment, stylizeFragment, compositeFragment]) {
    assert.match(fragment, /^#version 300 es/);
    assert.doesNotMatch(fragment, /previousViewProjection|time/);
  }
});

// Draws the default frame and each step in Chrome, so it runs only when asked:
//   RENDER_TESTS=1 node --test tests/post-steps.test.js (on a shared GPU, start it through the machine GPU lock)
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const rendersEnabled = process.env.RENDER_TESTS === '1' && existsSync(chromePath);
const STEP_CASES = ['defocus', 'color-balance', 'glare-streaks', 'glare-streaks-6', 'glare-anamorphic', 'glare-fog', 'lens-distortion', 'lens-dispersion',
  'grade-hero', 'grade-depth', 'sharpen', 'kuwahara', 'posterize', 'pixelate', 'pixelate-hero', 'key-chroma', 'key-luma'];

test('each named step changes the picture and the default still keeps its hash', { skip: !rendersEnabled, timeout: 300000 }, () => {
  const output = execFileSync('node', ['bench/post/post-steps.mjs', '--rounds=1', `--out=${join(tmpdir(), 'post-steps-test')}`], { encoding: 'utf8' });
  const { summary } = JSON.parse(output);
  for (const name of STEP_CASES) {
    assert.notEqual(summary[name].hash, summary.default.hash, `${name} differs from the default`);
    assert.ok(summary[name].medianMilliseconds > 0, `${name} has a frame time`);
  }
  // A grade masked to the hero part changes the hero and leaves the floor as the default drew it; the unmasked grade changes both.
  // A green-screen hero keyed out shows the background there; the floor is untouched. A key limited by a depth mask that leaves the hero out changes nothing.
  assert.notDeepEqual(summary['key-chroma'].regions.hero, summary['green-default'].regions.hero);
  assert.deepEqual(summary['key-chroma'].regions.floor, summary['green-default'].regions.floor);
  assert.deepEqual(summary['key-chroma-masked'].regions.hero, summary['green-default'].regions.hero);
  assert.notDeepEqual(summary['grade-hero'].regions.hero, summary.default.regions.hero);
  assert.deepEqual(summary['grade-hero'].regions.floor, summary.default.regions.floor);
  assert.notDeepEqual(summary['color-balance'].regions.floor, summary.default.regions.floor);
  assert.deepEqual(summary['pixelate-hero'].regions.floor, summary.default.regions.floor);
  // Hash of the default still as origin/main drew it before the named steps (bench/post/post-steps.mjs --root=<origin/main checkout>).
  assert.equal(summary.default.hash, '8741ffc3aaace9a8');
});
