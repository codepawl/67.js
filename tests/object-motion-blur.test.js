import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { resolveEffects } from '../src/effects.js';
import { normalizeAgentLook } from '../src/agent-look.js';
import { agentSceneModulesNeeded } from '../src/agent-scene-modules.js';
import { installCameraEffects } from '../src/camera-effects.js';
import { installObjectMotionBlur, packObjectMotion, sampleWorldMatrices } from '../src/object-motion-blur.js';

test('object blur is absent from resolved effects until it is set above zero', () => {
  assert.deepEqual(resolveEffects({ motionBlur: { shutter: 0.1 } }).motionBlur, { shutter: 0.1 });
  assert.deepEqual(resolveEffects({ motionBlur: { shutter: 0.1, objects: 0 } }).motionBlur, { shutter: 0.1 });
  assert.deepEqual(resolveEffects({ motionBlur: { shutter: 0.1, objects: 0.5 } }).motionBlur, { shutter: 0.1, objects: 0.5 });
  assert.throws(() => resolveEffects({ motionBlur: { shutter: 0.1, objects: 2 } }), /Motion blur objects/);
  assert.equal(normalizeAgentLook({ effects: { motionBlur: { shutter: 0.1, objects: 1 } } }).effects.motionBlur.objects, 1);
  assert.throws(() => normalizeAgentLook({ effects: { motionBlur: { objects: 'all' } } }), /objects/);
});

test('only a non-zero objects value loads the object blur module', () => {
  const needs = effects => agentSceneModulesNeeded({ effects }).includes('objectMotionBlur');
  assert.equal(needs({ motionBlur: { shutter: 0 } }), false);
  assert.equal(needs({ motionBlur: { shutter: 0.1, objects: 0 } }), false);
  assert.equal(needs({ motionBlur: { shutter: 0.1, objects: 1 } }), true);
  assert.equal(needs({ motionBlur: { objects: 0.25, shutter: 0.1 } }), true);
});

function fakeRenderer(names) {
  return { batches: [{ parts: names.map(name => ({ name })) }], drawsInOpaqueLoop: () => true, postStages: [], passSupport: {} };
}

test('each part gets the transform back to where it was, and a part that did not move gets the identity', () => {
  const parts = [{ name: 'prop', matrix: mat4.fromTranslation(mat4.create(), [1, 0, 0]) }, { name: 'wall', matrix: mat4.create() }];
  const current = sampleWorldMatrices(parts);
  parts[0].matrix[12] = 5;
  assert.equal(current.get('prop')[12], 1, 'Sampled matrices are copies.');
  const previous = new Map([['prop', mat4.fromTranslation(mat4.create(), [-1, 0, 0])], ['wall', mat4.create()]]);
  const packed = packObjectMotion(fakeRenderer(['prop', 'wall']), current, previous);
  assert.equal(packed.count, 2);
  assert.equal(packed.rows, 1);
  assert.deepEqual([...packed.matrices.slice(0, 16)], [...mat4.fromTranslation(mat4.create(), [-2, 0, 0])]);
  assert.deepEqual([...packed.matrices.slice(16, 32)], [...mat4.create()]);
});

test('the object stage replaces camera blur on a frame that carries object motion', () => {
  const renderer = installObjectMotionBlur(installCameraEffects(fakeRenderer([])));
  const [, cameraStage, objectStage] = renderer.postStages;
  assert.equal(objectStage.name, 'Object motion blur');
  const effects = resolveEffects({ motionBlur: { shutter: 0.1, objects: 1 } });
  const probe = stage => stage.apply({ depthTexture: null }, { previousCamera: {}, objectMotion: {} }, effects, null);
  assert.equal(probe(cameraStage), null, 'Camera blur stays out of the way.');
  assert.throws(() => probe(objectStage), /requires depth/);
  assert.equal(objectStage.apply({ depthTexture: null }, { previousCamera: {} }, effects, null), null, 'Without object motion the stage passes through.');
  assert.equal(installObjectMotionBlur(renderer).postStages.length, 3, 'Installing twice adds nothing.');
});
