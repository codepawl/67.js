import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';
import { WATER_PRESETS, findWaterBody, resolveWaterMaterial, worldMaterialSlots } from '../src/world-material-shader.js';
import { box } from '../src/geometry.js';
import { createFragmentShader } from '../src/shaders.js';

const unitBox = box(0, 1);

function waterPart(size, centre, material = { tag: 'water' }) {
  const matrix = new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, centre[0], centre[1], centre[2], 1]);
  return { name: `water-${size.join('x')}`, geometry: unitBox, matrix, material };
}

test('the capabilities list the same water presets as the shader addon', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(AGENT_SCENE_CAPABILITIES.water.presets)), JSON.parse(JSON.stringify(WATER_PRESETS)));
  assert.ok(AGENT_SCENE_CAPABILITIES.materialTags.includes('water'));
});

test('water fields resolve as explicit value, then preset, then the default lake', () => {
  assert.deepEqual(resolveWaterMaterial({}).absorption, WATER_PRESETS.lake.absorption);
  assert.equal(resolveWaterMaterial({ waterPreset: 'river' }).turbidity, WATER_PRESETS.river.turbidity);
  const mixed = resolveWaterMaterial({ waterPreset: 'sea', turbidity: 0.5 });
  assert.deepEqual(mixed.absorption, WATER_PRESETS.sea.absorption);
  assert.equal(mixed.turbidity, 0.5);
  assert.throws(() => resolveWaterMaterial({ waterPreset: 'puddle' }), /waterPreset/);
  assert.throws(() => resolveWaterMaterial({ absorption: [1, 1] }), /absorption/);
  assert.throws(() => resolveWaterMaterial({ turbidity: 1.5 }), /turbidity/);
});

test('the largest flat water part sets the level and optics; a ribbon that is not flat sets none', () => {
  const pool = waterPart([40, 0.1, 40], [0, -0.05, 0], { tag: 'water', waterPreset: 'river' });
  const puddle = waterPart([2, 0.1, 2], [0, 3, 0], { tag: 'water' });
  const body = findWaterBody([puddle, pool]);
  assert.equal(body.level, 0);
  assert.equal(body.turbidity, WATER_PRESETS.river.turbidity);
  assert.equal(findWaterBody([waterPart([4, 3, 40], [0, 0, 0])]), null);
  assert.equal(findWaterBody([]), null);
});

test('a recipe water material carries resolved optics and other tags refuse them', () => {
  const recipe = (material) => ({ format: 'crucible.scene', schemaVersion: 1, geometries: [{ id: 'sheet', type: 'box', bevel: 0 }], materials: [{ id: 'water', ...material }], nodes: [{ id: 'sheet', geometry: 'sheet', material: 'water', scale: [10, 0.1, 10] }] });
  const scene = createAgentScene(recipe({ tag: 'water', waterPreset: 'sea', turbidity: 0.3 }));
  const material = scene.parts[0].material;
  assert.equal(material.tag, 'water');
  assert.equal(material.turbidity, 0.3);
  assert.deepEqual([...material.absorption], [...WATER_PRESETS.sea.absorption]);
  assert.throws(() => createAgentScene(recipe({ tag: 'surface', turbidity: 0.3 })), /need the water tag/);
});

test('the shader keeps the sun shadow off the reflection and applies the column only below the level', () => {
  const source = createFragmentShader(['water']);
  assert.ok(source.includes('uniform vec4 waterBody;'));
  assert.ok(source.includes('visibility = mix(visibility, 1.0, 0.7 + 0.2 * waterBody.y);'));
  const water = worldMaterialSlots.worldAfterEmission.split('if (TAG_WATER)')[1];
  assert.ok(!/visibility/.test(water.split('radiance = mix(')[0]), 'the reflection term is computed without the shadow');
  assert.ok(source.includes('exp(-waterAbsorption * waterDepth)'));
  assert.ok(!createFragmentShader([]).includes('waterBody'));
});

test('the refraction blur averages only the taps that saw the bed, so the bed edge does not fade into a haze', () => {
  const source = createFragmentShader(['water']);
  assert.ok(source.includes('return seen > 0.5 ? seenColor / seen : fallback;'));
  assert.ok(!source.includes('seen / 16.0'), 'a share of missed taps must not mix the water colour into the blur');
});

test('the sun leg is absorbed over the refracted path and the murky scatter only adds light to the lit side', () => {
  const source = createFragmentShader(['water']);
  assert.ok(source.includes('/ 1.33;'), 'Snell with n = 1.33 sets the refracted sun angle');
  assert.ok(source.includes('/ sqrt(1.0 - sunSine * sunSine)'), 'the sun path is depth / cos(theta_t)');
  assert.ok(source.includes('waterScatterShare * 3.4'), 'the in-scatter is a positive term scaled by the shadow visibility');
  assert.ok(!source.includes('mix(filtered, 1.0'), 'the shadow is not lifted toward the lit side, which inverted it in a murky river');
});
