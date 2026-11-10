import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { findSunBounceLights, withSunBounce } from '../src/sun-bounce.js';
import { MAX_POINT_LIGHTS } from '../src/light-limits.js';

// A closed room with a roof opening: the sun reaches a patch of the floor and nothing else.
function roomWithOpening(environment = {}) {
  const block = (id, translation, scale) => ({ id, geometry: 'box', material: 'stone', translation, scale });
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'stone', color: [0.6, 0.5, 0.4], roughness: 0.8 }],
    nodes: [
      block('floor', [0, -0.05, 0], [10, 0.1, 10]),
      block('wall-left', [-5, 2, 0], [0.2, 4, 10]),
      block('wall-right', [5, 2, 0], [0.2, 4, 10]),
      block('wall-front', [0, 2, 5], [10, 4, 0.2]),
      block('wall-back', [0, 2, -5], [10, 4, 0.2]),
      block('roof-left', [-2.9, 4.1, 0], [4.6, 0.2, 10.4]),
      block('roof-right', [2.9, 4.1, 0], [4.6, 0.2, 10.4]),
    ],
    camera: { eye: [0, 1.5, 4], target: [0, 1.5, 0], fov: 60, near: 0.05, far: 40 },
    environment: { keyColor: [3, 3, 3], lightDirection: [0, 1, 0.2], floorSkyTrace: false, ...environment },
  };
}

test('a sun-lit closed room gets point lights at its sunlit patches, above the floor', () => {
  const { parts, environment } = createAgentScene(roomWithOpening());
  const lights = findSunBounceLights(parts, environment);
  assert.ok(lights.length > 0 && lights.length <= 6);
  for (const light of lights) {
    assert.ok(light.position.every((value, axis) => value > [-5, 0, -5][axis] && value < [5, 4, 5][axis]), 'inside the room');
    assert.ok(light.intensity > 0);
  }
});

// A closed room lit through a window opening in its left wall, with a lawn and a hedge outside that move the middle of the bounds out of it.
function roomWithWindowAndGarden() {
  const recipe = roomWithOpening({ lightDirection: [-0.85, 0.4, 0.32] });
  const block = (id, translation, scale) => ({ id, geometry: 'box', material: 'stone', translation, scale });
  recipe.nodes = [
    block('floor', [0, -0.05, 0], [10, 0.1, 10]),
    block('wall-right', [5, 2, 0], [0.2, 4, 10]),
    block('wall-front', [0, 2, 5], [10, 4, 0.2]),
    block('wall-back', [0, 2, -5], [10, 4, 0.2]),
    block('roof', [0, 4.1, 0], [10.4, 0.2, 10.4]),
    block('wall-left-below', [-5, 0.5, 0], [0.2, 1, 10]),
    block('wall-left-above', [-5, 3.5, 0], [0.2, 1, 10]),
    block('wall-left-back', [-5, 2, -3.5], [0.2, 2, 3]),
    block('wall-left-front', [-5, 2, 3.5], [0.2, 2, 3]),
    block('lawn', [-20, -0.2, 0], [30, 0.1, 40]),
    block('hedge', [-22, 1, 0], [1.4, 2, 40]),
  ];
  return recipe;
}

test('a room lit through a window gets lights that grow with sunBounce, though a garden lies outside it', () => {
  const { parts, environment } = createAgentScene(roomWithWindowAndGarden());
  const lights = findSunBounceLights(parts, environment);
  assert.ok(lights.length > 0);
  const strength = (value) => withSunBounce(parts, { ...environment, sunBounce: value }).pointLights.reduce((total, light) => total + light.intensity, 0);
  assert.ok(strength(2) > strength(1) && strength(1) > 0);
});

test('environment.sunBounce scales the lights, and 0 returns the environment unchanged', () => {
  const { parts, environment } = createAgentScene(roomWithOpening());
  const strength = (value) => withSunBounce(parts, { ...environment, sunBounce: value }).pointLights.reduce((total, light) => total + light.intensity, 0);
  assert.ok(strength(2) > 1.99 * strength(1) && strength(2) < 2.01 * strength(1));
  const off = { ...environment, sunBounce: 0 };
  assert.equal(withSunBounce(parts, off), off);
});

test('the lights fit in the point light limit beside the scene lamps', () => {
  const { parts, environment } = createAgentScene(roomWithOpening());
  const lamps = Array.from({ length: MAX_POINT_LIGHTS - 2 }, () => ({ position: [0, 1, 0], color: [1, 1, 1], intensity: 1 }));
  assert.equal(withSunBounce(parts, { ...environment, pointLights: lamps }).pointLights.length, MAX_POINT_LIGHTS);
});

test('open ground and a room with no sun get no lights', () => {
  const { parts, environment } = createAgentScene(roomWithOpening());
  assert.equal(findSunBounceLights(parts.filter(part => part.name === 'floor'), environment).length, 0);
  const dark = { ...environment, keyIntensity: 0 };
  assert.equal(withSunBounce(parts, dark), dark);
});

test('environment.sunBounce that is not a number of 0 or more is refused', () => {
  for (const value of ['strong', true, -1, null]) {
    assert.throws(() => createAgentScene(roomWithOpening({ sunBounce: value })), /environment\.sunBounce: got .*; expected a number of 0 or more/);
  }
  assert.equal(createAgentScene(roomWithOpening({ sunBounce: 2 })).environment.sunBounce, 2);
});
