import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';

const OCEAN = { op: 'ocean', seed: 3, windSpeed: 4, size: 2, resolution: 4 };

function seaRecipe({ trackTime = true, stack = [{ op: 'subdivide', levels: 3 }, OCEAN] } = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 }, stack }],
    materials: [{ id: 'water', color: [0.1, 0.3, 0.5] }],
    nodes: [{ id: 'surface', geometry: 'sea', material: 'water' }],
    camera: { eye: [30, 20, 30], target: [0, 0, 0] },
    ...(trackTime ? {
      motion: {
        duration: 4,
        tracks: [{ kind: 'geometry', id: 'sea', property: 'oceanTime', keyframes: [{ time: 0, value: 0 }, { time: 4, value: 8 }] }],
      },
    } : {}),
  };
}

function positionsOf(scene) {
  return Array.from(scene.parts[0].geometry.positions);
}

test('an ocean time track moves the waves, and a frame equals the still written at that time', () => {
  const scene = createAgentScene(seaRecipe());
  scene.sampleMotion(0);
  const atStart = positionsOf(scene);
  scene.sampleMotion(2);
  const atTwoSeconds = positionsOf(scene);
  assert.notDeepEqual(atTwoSeconds, atStart, 'the sea moves between frames');
  const still = createAgentScene(seaRecipe({ trackTime: false, stack: [{ op: 'subdivide', levels: 3 }, { ...OCEAN, time: 4 }] }));
  assert.deepEqual(atTwoSeconds, positionsOf(still), 'time 2 s on a 0 to 8 track is the still at ocean time 4');
});

test('seeking back and forth gives the same vertices, and a repeated time keeps the geometry', () => {
  const scene = createAgentScene(seaRecipe());
  scene.sampleMotion(1.25);
  const first = positionsOf(scene);
  scene.sampleMotion(3.5);
  scene.sampleMotion(1.25);
  assert.deepEqual(positionsOf(scene), first);
  const geometry = scene.parts[0].geometry;
  scene.sampleMotion(1.25);
  assert.equal(scene.parts[0].geometry, geometry);
});

test('an ocean time track names a mesh geometry with an ocean node in its stack', () => {
  const missingGeometry = seaRecipe();
  missingGeometry.motion.tracks[0].id = 'nowhere';
  assert.throws(() => createAgentScene(missingGeometry), /ocean node/);
  assert.throws(() => createAgentScene(seaRecipe({ stack: [{ op: 'subdivide', levels: 2 }] })), /ocean node/);
});

test('ocean time keyframes stay within the bounds of the modifier', () => {
  const recipe = seaRecipe();
  recipe.motion.tracks[0].keyframes[1].value = 2e6;
  assert.throws(() => createAgentScene(recipe), /oceanTime/);
  const wrongSize = seaRecipe();
  wrongSize.motion.tracks[0].keyframes[1].value = [1, 2];
  assert.throws(() => createAgentScene(wrongSize));
});

test('per-frame ocean work stays inside the ocean work limit', () => {
  const scene = createAgentScene(seaRecipe({ stack: [{ op: 'subdivide', levels: 3 }, { ...OCEAN, resolution: 16 }] }));
  assert.doesNotThrow(() => scene.sampleMotion(1));
});
