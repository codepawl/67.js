import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { closedRoom, roomLitBy, lightmapBytesOf } from './support/agent-bake-rooms.mjs';

test('a brick wall keeps its pattern and receives bounced light through a light map', () => {
  const recipe = closedRoom();
  recipe.materials.push({ id: 'bricks', color: [1, 1, 1], roughness: 0.9, pattern: { type: 'bricks', size: 1 } });
  recipe.nodes.find(node => node.id === 'back').material = 'bricks';
  const scene = createAgentScene(recipe);
  assert.deepEqual(scene.inspect().bake.skipped, []);
  const wall = scene.parts.find(part => part.name === 'back');
  assert.ok(wall.material.lightMap);
  assert.ok(wall.material.map);
  assert.ok(wall.material.boxMapScale > 0);
  assert.equal(wall.geometry.lightUvs.length, wall.geometry.positions.length / 3 * 2);
  const again = createAgentScene(recipe).parts.find(part => part.name === 'back');
  assert.deepEqual(Array.from(again.material.lightMap.image.data), Array.from(wall.material.lightMap.image.data));
});

test('a node that hosts a hair system bakes without an error and is reported as skipped', () => {
  const recipe = closedRoom({
    geometries: [{ id: 'box', type: 'box' }, { id: 'head', type: 'sphere', segments: 12, rings: 8 }],
    particles: { systems: [{ type: 'hair', node: 'fur', surface: 'head', seed: 5, count: 40, length: [0.1, 0.2], segments: 3 }] },
  });
  recipe.nodes.push({ id: 'head', geometry: 'head', material: 'white', translation: [0.5, 0.5, 0.5], scale: [0.3, 0.3, 0.3] });
  recipe.nodes.push({ id: 'fur', geometry: 'box', material: 'white' });
  const scene = createAgentScene(recipe);
  const skipped = scene.inspect().bake.skipped.find(entry => entry.name === 'fur');
  assert.ok(skipped);
  assert.match(skipped.reason, /hair|particle/);
  assert.ok(scene.parts.find(part => part.name === 'head').material.emissiveMap);
  assert.equal(scene.parts.find(part => part.name === 'fur').material.emissiveMap, undefined);
});

test('a spot light that points at the floor bakes the light that bounces off it', () => {
  const recipe = roomLitBy({ spotLights: [{ position: [0, 2.8, 0.5], direction: [0, -1, 0], angle: 0.6, intensity: 30 }] });
  const scene = createAgentScene(recipe);
  assert.ok(scene.parts.find(part => part.name === 'back').material.emissiveMap);
  assert.deepEqual(lightmapBytesOf(createAgentScene(recipe), 'back'), lightmapBytesOf(scene, 'back'));
  const withoutSpot = createAgentScene(roomLitBy({}));
  assert.notDeepEqual(lightmapBytesOf(withoutSpot, 'back'), lightmapBytesOf(scene, 'back'));
});

test('an area light bakes bounced light on its front side only, and a changed spot or area light bakes again', () => {
  const facingDown = roomLitBy({ areaLights: [{ position: [0, 2.9, 0], direction: [0, -1, 0], width: 1, height: 1, intensity: 20 }] });
  const facingUp = roomLitBy({ areaLights: [{ position: [0, 2.9, 0], direction: [0, 1, 0], width: 1, height: 1, intensity: 20 }] });
  const scene = createAgentScene(facingDown);
  assert.ok(scene.parts.find(part => part.name === 'floor').material.emissiveMap);
  assert.deepEqual(lightmapBytesOf(createAgentScene(facingDown), 'floor'), lightmapBytesOf(scene, 'floor'));
  assert.notDeepEqual(lightmapBytesOf(createAgentScene(facingUp), 'floor'), lightmapBytesOf(scene, 'floor'));
  scene.apply([{ type: 'set-environment', environment: { areaLights: [{ position: [0, 2.9, 0], direction: [0, -1, 0], width: 1, height: 1, intensity: 25 }] } }], { expectedRevision: 0 });
  assert.equal(scene.inspect().bake.reused, false);
});
