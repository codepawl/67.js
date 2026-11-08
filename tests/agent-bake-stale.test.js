// A bake traced at the authored pose reports bake-stale when motion has moved a light off it (issue 603).
import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { closedRoom, lightmapBytesOf } from './support/agent-bake-rooms.mjs';

const LIGHT_MOVES = { kind: 'light', id: 'point:0', property: 'position', keyframes: [{ time: 0, value: [0, 2, 0] }, { time: 2, value: [1, 2, 0] }] };

function bakedRoom(bakeOverrides = {}) {
  const recipe = closedRoom({ bake: { preset: 'draft', ...bakeOverrides }, motion: { duration: 2, tracks: [LIGHT_MOVES] } });
  recipe.environment.pointLights = [{ position: [0, 2, 0], intensity: 10 }];
  return recipe;
}

const staleDiagnostics = scene => (scene.inspect().diagnostics ?? []).filter(entry => entry.kind === 'bake-stale');

test('moving a light with a motion track after a bake gives a bake-stale warning', () => {
  const scene = createAgentScene(bakedRoom());
  assert.deepEqual(staleDiagnostics(scene), []);
  scene.sampleMotion(0);
  assert.deepEqual(staleDiagnostics(scene), []);
  scene.sampleMotion(2);
  const [warning] = staleDiagnostics(scene);
  assert.equal(warning.severity, 'warning');
  assert.match(warning.fix, /bake\.rebake/);
  scene.sampleMotion(0);
  assert.deepEqual(staleDiagnostics(scene), []);
});

test('an unchanged scene, or one with a bake and no motion, gives no warning', () => {
  const scene = createAgentScene(bakedRoom());
  assert.equal(scene.inspect().bake.reused, false);
  assert.deepEqual(staleDiagnostics(scene), []);
  const { motion, ...withoutMotion } = bakedRoom();
  const unmoved = createAgentScene(withoutMotion);
  assert.deepEqual(staleDiagnostics(unmoved), []);
});

const lightMapData = (scene, name) => Array.from(lightmapBytesOf(scene, name));

test('bake.rebake bakes the pose motion samples: the light map at time t equals a fresh bake of the scene posed at t', () => {
  const scene = createAgentScene(bakedRoom({ rebake: true }));
  const authoredFloor = lightMapData(scene, 'floor');
  scene.sampleMotion(2);
  assert.deepEqual(staleDiagnostics(scene), []);
  assert.equal(scene.inspect().bake.reused, false);
  const posed = bakedRoom();
  delete posed.motion;
  posed.environment.pointLights[0].position = [1, 2, 0];
  const fresh = createAgentScene(posed);
  for (const name of ['floor', 'back', 'block']) {
    assert.deepEqual(lightMapData(scene, name), lightMapData(fresh, name), name);
  }
  assert.notDeepEqual(lightMapData(scene, 'floor'), authoredFloor);
  scene.sampleMotion(0);
  assert.deepEqual(lightMapData(scene, 'floor'), authoredFloor);
  assert.equal(scene.inspect().bake.reused, true);
});

test('bake.rebake keeps the bakes of the last 4 poses and traces nothing for a pose it holds', () => {
  const scene = createAgentScene(bakedRoom({ rebake: true }));
  const times = [0.5, 1, 1.5, 2];
  for (const time of times) {
    scene.sampleMotion(time);
    assert.equal(scene.inspect().bake.reused, false, `time ${time}`);
  }
  scene.sampleMotion(2);
  scene.sampleMotion(1.5);
  assert.equal(scene.inspect().bake.reused, true);
  assert.throws(() => createAgentScene(bakedRoom({ rebake: 'yes' })), /rebake must be a boolean/);
});
