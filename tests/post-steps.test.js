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
import { installPostSteps, resolvePostSteps, glareFragment, lensDistortionFragment, colorBalanceFragment } from '../src/post-steps.js';
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

const STAGE_NAMES = ['Glare', 'Lens distortion', 'Color balance'];

test('a look that names no step resolves exactly as before', async () => {
  await loadAgentSceneModules({});
  const effects = normalizeAgentLook({}).effects;
  for (const field of ['colorBalance', 'glare', 'lensDistortion']) assert.equal(Object.hasOwn(effects, field), false);
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
  assert.equal(installPostSteps(renderer).postStages.length, 5);
  const unset = { eye: [0, 1, 5], effects: {} };
  const neutral = { eye: [0, 1, 5], effects: { colorBalance: {}, glare: {}, lensDistortion: {} } };
  const named = [
    ['Glare', { glare: { streaks: 0.6 } }],
    ['Lens distortion', { lensDistortion: { distortion: 0.5, dispersion: 0.5 } }],
    ['Color balance', { colorBalance: { gain: [1.1, 1, 0.9] } }],
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
  assert.ok(calls.filter(call => call[0] === 'drawArrays').length === 3);
  assert.ok(calls.filter(call => call[0] === 'deleteTexture').length === 3);
});

test('the shaders keep their fixed sample patterns and read no history', () => {
  for (const fragment of [glareFragment, lensDistortionFragment, colorBalanceFragment]) {
    assert.match(fragment, /^#version 300 es/);
    assert.doesNotMatch(fragment, /previousViewProjection|time/);
  }
});

// Draws the default frame and each step in Chrome, so it runs only when asked:
//   RENDER_TESTS=1 node --test tests/post-steps.test.js (on a shared GPU, start it through the machine GPU lock)
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const rendersEnabled = process.env.RENDER_TESTS === '1' && existsSync(chromePath);
const STEP_CASES = ['defocus', 'color-balance', 'glare-streaks', 'glare-streaks-6', 'glare-anamorphic', 'glare-fog', 'lens-distortion', 'lens-dispersion'];

test('each named step changes the picture and the default still keeps its hash', { skip: !rendersEnabled, timeout: 300000 }, () => {
  const output = execFileSync('node', ['bench/post/post-steps.mjs', '--rounds=1', `--out=${join(tmpdir(), 'post-steps-test')}`], { encoding: 'utf8' });
  const { summary } = JSON.parse(output);
  for (const name of STEP_CASES) {
    assert.notEqual(summary[name].hash, summary.default.hash, `${name} differs from the default`);
    assert.ok(summary[name].medianMilliseconds > 0, `${name} has a frame time`);
  }
  // Hash of the default still as origin/main drew it before the named steps (bench/post/post-steps.mjs --root=<origin/main checkout>).
  assert.equal(summary.default.hash, '8741ffc3aaace9a8');
});
