// The distortion and flash post steps (issue 1049): a placed shock ring and heat haze, and a timed flash.
import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { resolveEffects } from '../src/effects.js';
import { installCameraEffects } from '../src/camera-effects.js';
import { installPostSteps, resolvePostSteps } from '../src/post-steps.js';
import { resolveDistortion, resolveFlash, ringState, flashLevel, packDistortion, packFlash, distortionFragment, flashFragment, MAXIMUM_AIR_SOURCES } from '../src/post-air.js';
import { agentSceneModulesNeeded } from '../src/agent-scene-modules.js';
import { createAgentScene } from '../src/agent-scene.js';

function recordingContext(calls) {
  return new Proxy({}, {
    get(target, name) {
      if (typeof name === 'symbol') return undefined;
      if (/^[A-Z0-9_]+$/.test(name)) return 1;
      if (name === 'checkFramebufferStatus') return () => 1;
      return (...args) => {
        calls.push([name, ...args.map(argument => (ArrayBuffer.isView(argument) ? Array.from(argument) : argument))]);
        return true;
      };
    },
  });
}

function fakeRenderer(context) {
  return { postStages: [], context, canvas: { width: 16, height: 9 }, hdr: false, depthTexture: 'depth', inverseViewProjection: mat4.create(), viewForward: [0, 0, -1] };
}

test('a distortion source resolves with defaults and refuses bad input by naming the field', () => {
  const [ring] = resolveDistortion({ shape: 'ring', centre: [0, 2, -10] });
  assert.deepEqual(ring, { shape: 'ring', centre: [0, 2, -10], time: 0, startTime: 0, speed: 40, thickness: 1.5, strength: 0.5, falloff: 0.4, maxRadius: 200, edge: 0 });
  const [haze] = resolveDistortion({ shape: 'haze', node: 'fire', region: 'sphere' });
  assert.equal(haze.node, 'fire');
  assert.deepEqual(haze.size, [2, 2, 2]);
  assert.equal(resolveDistortion([]).length, 0);
  assert.throws(() => resolveDistortion({}), /distortion\[0\]\.shape must be "ring" or "haze"/);
  assert.throws(() => resolveDistortion({ shape: 'ring', strength: 2 }), /distortion\[0\]\.strength must be between 0 and 1/);
  assert.throws(() => resolveDistortion({ shape: 'ring', speed: -1 }), /distortion\[0\]\.speed must be between/);
  assert.throws(() => resolveDistortion({ shape: 'ring', noiseScale: 1 }), /distortion\[0\]\.noiseScale does not apply to shape "ring"/);
  assert.throws(() => resolveDistortion({ shape: 'haze', speed: 1 }), /distortion\[0\]\.speed does not apply to shape "haze"/);
  assert.throws(() => resolveDistortion({ shape: 'haze', region: 'cone' }), /region must be one of box, sphere/);
  assert.throws(() => resolveDistortion({ shape: 'haze', size: [1, 1] }), /size must be three numbers/);
  assert.throws(() => resolveDistortion({ shape: 'ring', node: '' }), /node must be the ID of a node/);
  assert.throws(() => resolveDistortion({ shape: 'ring', colour: 1 }), /Unknown distortion\[0\] field "colour"/);
  const tooMany = Array.from({ length: MAXIMUM_AIR_SOURCES + 1 }, () => ({ shape: 'ring' }));
  assert.throws(() => resolveDistortion(tooMany), /at most 4 sources, got 5/);
});

test('a flash source resolves with defaults and refuses bad input by naming the field', () => {
  const [flash] = resolveFlash({ centre: [1, 2, 3], intensity: 6 });
  assert.deepEqual(flash, { centre: [1, 2, 3], time: 0, startTime: 0, attack: 0.05, decay: 0.4, intensity: 6, color: [1, 0.85, 0.6], radius: 50, ambient: 0 });
  assert.throws(() => resolveFlash({ decay: 0 }), /flash\[0\]\.decay must be between 0.01 and 60/);
  assert.throws(() => resolveFlash({ color: [2, 0, 0] }), /flash\[0\]\.color\[0\] must be between 0 and 1/);
  assert.throws(() => resolveFlash({ radius: 0 }), /flash\[0\]\.radius must be between/);
  assert.throws(() => resolveFlash([1]), /flash\[0\] must be an object/);
  assert.throws(() => resolveFlash(Array.from({ length: 5 }, () => ({}))), /at most 4 sources/);
});

test('the shock ring radius at three times is speed times the time since it started', () => {
  const [source] = resolveDistortion({ shape: 'ring', speed: 30, startTime: 0.5, maxRadius: 100, strength: 0.8, falloff: 0.5 });
  assert.equal(ringState({ ...source, time: 0.25 }), null, 'nothing before the start');
  for (const time of [0.5, 1, 2, 3.5]) {
    const state = ringState({ ...source, time });
    assert.ok(Math.abs(state.radius - 30 * (time - 0.5)) < 1e-9, `radius at ${time}s`);
    assert.ok(Math.abs(state.amplitude - 0.8 * Math.exp(-0.5 * (time - 0.5))) < 1e-9, `strength at ${time}s`);
  }
  assert.equal(ringState({ ...source, time: 4 }), null, 'gone past maxRadius');
  assert.deepEqual(ringState({ ...source, time: 2 }), ringState({ ...source, time: 2 }), 'the same time gives the same ring');
});

test('a flash rises over its attack, falls to zero over its decay and is zero outside', () => {
  const [source] = resolveFlash({ startTime: 1, attack: 0.1, decay: 0.5, intensity: 8 });
  assert.equal(flashLevel({ ...source, time: 0.9 }), 0);
  assert.equal(flashLevel({ ...source, time: 1 }), 0);
  assert.ok(Math.abs(flashLevel({ ...source, time: 1.05 }) - 4) < 1e-9);
  assert.ok(Math.abs(flashLevel({ ...source, time: 1.1 }) - 8) < 1e-9);
  assert.ok(Math.abs(flashLevel({ ...source, time: 1.35 }) - 2) < 1e-9);
  assert.equal(flashLevel({ ...source, time: 1.6 }), 0);
});

test('only live sources are packed for the shader, and a step with none draws nothing', () => {
  const sources = resolveDistortion([
    { shape: 'ring', startTime: 2, centre: [1, 2, 3] },
    { shape: 'haze', strength: 0, centre: [0, 0, 0] },
    { shape: 'haze', region: 'box', size: [1, 2, 3], strength: 0.5, scroll: 2, time: 1.5 },
  ]);
  const packed = packDistortion(sources);
  assert.equal(packed.count, 1);
  assert.equal(packed.placement[3], 1, 'a box haze has kind 1');
  assert.deepEqual(Array.from(packed.shape.slice(0, 3)), [1.5, 3, 0.5]);
  assert.deepEqual(Array.from(packed.extent.slice(0, 3)), [1, 2, 3]);
  assert.equal(packDistortion(sources.map(source => ({ ...source, time: 3 }))).count, 2, 'the ring is live from its start time');
  assert.equal(packFlash(resolveFlash({ startTime: 5 })).count, 0);
  const lit = packFlash(resolveFlash({ attack: 0, decay: 1, intensity: 2, color: [1, 0.5, 0], time: 0 }));
  assert.equal(lit.count, 1, 'a zero attack is full brightness from the first instant');
  assert.deepEqual(Array.from(packFlash(resolveFlash({ attack: 0.1, decay: 1, intensity: 2, color: [1, 0.5, 0], time: 0.1 })).lift.slice(0, 3)), [2, 1, 0]);
});

test('a recipe that names either step loads the post steps module and keeps the resolved list in the look', () => {
  assert.ok(agentSceneModulesNeeded({ effects: { distortion: { shape: 'ring' } } }).includes('postSteps'));
  assert.ok(agentSceneModulesNeeded({ effects: { flash: [{ intensity: 3 }] } }).includes('postSteps'));
  assert.equal(agentSceneModulesNeeded({ effects: { bloom: { strength: 0.3 }, lensDistortion: undefined } }).includes('postSteps'), false);
  const resolved = resolvePostSteps({ distortion: { shape: 'ring' }, flash: {} });
  assert.deepEqual(resolvePostSteps(resolved), resolved, 'resolved steps resolve to themselves, so a frame can carry them');
  assert.throws(() => resolvePostSteps({ distortion: { shape: 'ring' }, colorBalance: { mask: { depth: {} } } }), /colorBalance\.mask cannot be combined with distortion/);
  assert.doesNotThrow(() => resolvePostSteps({ flash: {}, colorBalance: { mask: { depth: {} } } }));
});

test('the shaders read the depth buffer, take no history and stay inside their loop bound', () => {
  for (const fragment of [distortionFragment, flashFragment]) {
    assert.match(fragment, /^#version 300 es/);
    assert.match(fragment, /sceneDepth/);
    assert.doesNotMatch(fragment, /previousViewProjection/);
    assert.match(fragment, new RegExp(`index < ${MAXIMUM_AIR_SOURCES}`));
  }
});

test('the new stages leave every existing post chain drawing exactly as before', () => {
  const chains = [
    {},
    { glare: { streaks: 0.6, fogGlow: 0.3 } },
    { lensDistortion: { distortion: 0.4, dispersion: 0.3 }, colorBalance: { gain: [1.2, 1, 0.9] } },
    { stylize: { posterize: 4, pixelate: 8 }, composite: { background: { color: [0.1, 0.2, 0.6] }, key: { luma: { low: 0.1, high: 0.4 } } } },
  ];
  const resolved = resolveEffects({});
  const drawsOf = (stageNames, input) => {
    const calls = [];
    const context = recordingContext(calls);
    const renderer = installPostSteps(installCameraEffects(fakeRenderer(context)));
    const frame = { eye: [0, 1, 5], effects: input };
    for (const stage of renderer.postStages.filter(candidate => stageNames.includes(candidate.name))) stage.apply(renderer, frame, resolved, 'source');
    return calls;
  };
  const oldStages = ['Glare', 'Lens distortion', 'Color balance', 'Stylize', 'Composite'];
  const allStages = ['Distortion', 'Flash', ...oldStages];
  for (const input of chains) {
    assert.deepEqual(drawsOf(allStages, input), drawsOf(oldStages, input), `${JSON.stringify(input)} draws the same GL calls`);
  }
  assert.equal(drawsOf(['Distortion', 'Flash'], { glare: { streaks: 1 } }).length, 0, 'the new stages issue no call for a chain that does not name them');
  assert.ok(drawsOf(['Distortion'], { distortion: { shape: 'ring' } }).some(call => call[0] === 'drawArrays'));
  assert.ok(drawsOf(['Flash'], { flash: { attack: 0.1, time: 0.1 } }).some(call => call[0] === 'drawArrays'));
});

function sceneWith(effects, tracks) {
  return createAgentScene({
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'finish', color: [0.6, 0.6, 0.6], emission: 0 }],
    nodes: [{ id: 'bomb', geometry: 'box', material: 'finish' }],
    camera: { eye: [4, 3, 5], target: [0, 0, 0] },
    effects,
    motion: { duration: 4, tracks },
  });
}

test('the scene clock drives the steps, a followed node moves the source, and a gain track fades it', () => {
  const effects = { distortion: { shape: 'ring', node: 'bomb', speed: 10 }, flash: { centre: [0, 1, 0], intensity: 4 } };
  const scene = sceneWith(effects, [
    { kind: 'node', id: 'bomb', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 4, value: [8, 0, 0] }] },
    { kind: 'effects', property: 'distortionStrength', keyframes: [{ time: 0, value: 1 }, { time: 4, value: 0 }] },
  ]);
  scene.sampleMotion(2);
  const sampled = scene.effects;
  assert.equal(sampled.distortion[0].time, 2);
  assert.equal(sampled.flash[0].time, 2);
  assert.ok(Math.abs(sampled.distortion[0].centre[0] - 4) < 1e-4, 'the ring follows the node');
  assert.ok(Math.abs(sampled.distortion[0].strength - 0.25) < 1e-9, 'half way through the gain track');
  assert.ok(Math.abs(ringState(sampled.distortion[0]).radius - 20) < 1e-9, 'radius is speed times time');
  scene.sampleMotion(null);
  assert.equal(scene.effects.distortion[0].time, 0);
  assert.equal(scene.effects.distortion[0].strength, 0.5);
});

test('the scene refuses an unknown node and a gain track for a step the recipe does not have', () => {
  assert.throws(() => sceneWith({ distortion: { shape: 'ring', node: 'ghost' } }, []), /effects\.distortion\.node.*one of the nodes of this recipe: bomb/);
  assert.throws(() => sceneWith({ flash: { node: 'ghost' } }, []), /effects\.flash\.node/);
  assert.throws(() => sceneWith({}, [{ kind: 'effects', property: 'flashIntensity', keyframes: [{ time: 0, value: 1 }, { time: 1, value: 0 }] }]), /effects\.flashIntensity.*effects\.flash names a source/);
  assert.throws(() => sceneWith({ flash: {} }, [{ kind: 'effects', property: 'flashIntensity', keyframes: [{ time: 0, value: 2 }, { time: 1, value: 0 }] }]), /values from 0 to 1/);
});
