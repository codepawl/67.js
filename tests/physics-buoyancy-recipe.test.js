import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, loadPhysicsEngine } from '../src/agent-scene.js';

await loadPhysicsEngine({ buoyancy: true });

function seaRecipe(physics, oceanNode = { op: 'ocean', windSpeed: 0.5, size: 50, seed: 4 }) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'cube', type: 'box' },
      { id: 'sea', type: 'mesh', base: { type: 'grid', segments: 8 }, stack: [oceanNode] },
    ],
    materials: [{ id: 'paint', color: [0.6, 0.5, 0.4] }],
    nodes: [{ id: 'crate', geometry: 'cube', material: 'paint', translation: [0, 0.4, 0] }],
    physics,
  };
}

test('a recipe floats a crate on the sea of a mesh geometry and settles at half depth', () => {
  const scene = createAgentScene(seaRecipe({ duration: 10, ocean: { geometry: 'sea' }, bodies: [{ node: 'crate', density: 500, float: {} }] }));
  scene.sampleMotion(10);
  const settledHeight = scene.parts[0].matrix[13];
  assert.ok(Math.abs(settledHeight) < 0.03, `box centre ${settledHeight} sits at the waterline`);
});

test('the sea level and water density of the recipe move the waterline', () => {
  const physics = { duration: 10, ocean: { geometry: 'sea', level: 2 }, bodies: [{ node: 'crate', density: 500, float: {} }] };
  const scene = createAgentScene(seaRecipe(physics));
  scene.sampleMotion(10);
  assert.ok(Math.abs(scene.parts[0].matrix[13] - 2) < 0.03);
});

test('recipe physics rejects float without an ocean and an ocean without waves', () => {
  const body = { node: 'crate', float: {} };
  assert.throws(() => createAgentScene(seaRecipe({ duration: 2, bodies: [body] })), /physics\.ocean/);
  assert.throws(() => createAgentScene(seaRecipe({ duration: 2, ocean: { geometry: 'cube' }, bodies: [body] })), /physics\.ocean\.geometry.*ocean node/);
  assert.throws(() => createAgentScene(seaRecipe({ duration: 2, ocean: { geometry: 'sea', level: 'high' }, bodies: [body] })), /physics\.ocean\.level/);
  assert.throws(() => createAgentScene(seaRecipe({ duration: 2, ocean: { geometry: 'sea' }, bodies: [{ node: 'crate', type: 'fixed', float: {} }] })), /physics\.bodies\[0\]\.float/);
  assert.throws(() => createAgentScene(seaRecipe({ duration: 2, ocean: { geometry: 'sea' }, bodies: [{ node: 'crate', float: { drag: 'a lot' } }] })), /physics\.bodies\[0\]\.float\.drag must be a number/);
});
