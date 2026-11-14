import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import './support/load-agent-scene-modules.mjs';
import { createAgentScene } from '../src/agent-scene.js';
import { agentSceneModulesNeeded } from '../src/agent-scene-modules.js';
import { materialLayerState, MATERIAL_LAYER_STATE_LENGTH } from '../src/material-layers.js';
import { SUBSURFACE_DEFAULTS, SUBSURFACE_RANGES, subsurfaceUniformValues, validateSubsurface } from '../src/subsurface-limits.js';
import { createFragmentShader, SHADER_FEATURES } from '../src/shaders.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';

function recipeWithMaterial(material) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'finish', ...material }],
    nodes: [{ id: 'block', geometry: 'box', material: 'finish' }],
  };
}

test('the subsurface block is checked against bounded ranges and names the field that is wrong', () => {
  validateSubsurface({ weight: 1, radius: [1, 0.2, 0.1], scale: 0.05, color: [0.8, 0.4, 0.3] });
  validateSubsurface({});
  assert.throws(() => validateSubsurface({ weight: 1.5 }), /subsurface.weight must be between 0 and 1/);
  assert.throws(() => validateSubsurface({ weight: Number.NaN }), /subsurface.weight/);
  assert.throws(() => validateSubsurface({ scale: -1 }), /subsurface.scale must be between 0 and 10/);
  assert.throws(() => validateSubsurface({ radius: [1, 2] }), /subsurface.radius must be three numbers/);
  assert.throws(() => validateSubsurface({ radius: [1, 2, 101] }), /subsurface.radius must be three numbers between 0 and 100/);
  assert.throws(() => validateSubsurface({ color: [0, 0, 2] }), /subsurface.color must be three numbers between 0 and 1/);
  assert.throws(() => validateSubsurface({ anisotropy: 0.5 }), /Unknown subsurface field anisotropy/);
  assert.throws(() => validateSubsurface([1]), /subsurface must be an object/);
  assert.throws(() => validateSubsurface({ weight: 1 }, 'foam'), /subsurface needs a standard PBR material tag/);
});

test('a recipe material takes the subsurface block and rejects values out of range', () => {
  const scene = createAgentScene(recipeWithMaterial({ subsurface: { weight: 1, radius: [1, 0.2, 0.1], scale: 0.05 } }));
  assert.deepEqual(scene.parts[0].material.subsurface, { weight: 1, radius: [1, 0.2, 0.1], scale: 0.05 });
  assert.throws(() => createAgentScene(recipeWithMaterial({ subsurface: { weight: 2 } })), /subsurface.weight/);
  assert.throws(() => createAgentScene(recipeWithMaterial({ subsurface: { radius: [1, 1] } })), /subsurface.radius/);
  assert.match(AGENT_SCENE_CAPABILITIES.materialSubsurface, /Principled BSDF Subsurface/);
  assert.deepEqual(SUBSURFACE_DEFAULTS.radius, [1, 0.2, 0.1]);
  assert.deepEqual(SUBSURFACE_RANGES.weight, [0, 1]);
});

test('a material without subsurface keeps its batching state and its shader exactly', () => {
  const plain = materialLayerState({ tag: 'surface' });
  assert.equal(plain.length, MATERIAL_LAYER_STATE_LENGTH);
  assert.equal(plain[23], '', 'no block, no extra state');
  const skin = materialLayerState({ tag: 'surface', subsurface: { weight: 0.5, radius: [1, 0.2, 0.1], scale: 0.05 } });
  assert.deepEqual(skin.slice(0, 23), plain.slice(0, 23), 'the layers before subsurface do not move');
  assert.deepEqual(JSON.parse(skin[23]), { weight: 0.5, radius: [1, 0.2, 0.1], scale: 0.05 });
  const values = subsurfaceUniformValues(JSON.parse(skin[23]));
  assert.deepEqual(values.slice(0, 1).concat(values.slice(1, 4).map(value => Number(value.toFixed(6)))), [0.5, 0.05, 0.01, 0.005]);
  assert.deepEqual(values.slice(4), [-1, -1, -1], 'a missing color means the base color');

  const features = SHADER_FEATURES.filter(feature => feature !== 'subsurface');
  assert.doesNotMatch(createFragmentShader(features), /ubsurface/, 'a shader built without the feature has no subsurface code');
});

test('the subsurface code loads on demand: the recipe marker finds it, and a renderer without it says which import to add', () => {
  assert.deepEqual(agentSceneModulesNeeded(recipeWithMaterial({ subsurface: { weight: 1 } })), ['subsurfaceShader']);
  assert.deepEqual(agentSceneModulesNeeded(recipeWithMaterial({ roughness: 0.4 })), []);
  const script = `
    const { createFragmentShader } = await import('./src/shaders.js');
    try { createFragmentShader(['subsurface']); console.log('no error'); } catch (error) { console.log(error.message); }
    await import('./src/subsurface-shader.js');
    console.log(createFragmentShader(['subsurface']).includes('subsurfaceLight(normal, color, visibility)'));
    console.log(createFragmentShader([]).includes('subsurfaceLight'));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).trim().split('\n');
  assert.match(output[0], /subsurface feature needs its shader code: add import '@codepawlhq\/crucible\/addons\/subsurface-shader'/);
  assert.equal(output[1], 'true');
  assert.equal(output[2], 'false');
});
