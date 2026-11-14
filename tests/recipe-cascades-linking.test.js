import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene, loadAgentSceneModules, agentSceneModulesNeeded } from '../src/agent-scene.js';
import { effectiveShadowCascades } from '../src/cascaded-shadows.js';
import { bakeLightmaps } from '../src/light-bake.js';
import { box } from '../src/geometry.js';
import { describeIgnoredFeatures } from '../src/path-tracer.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { SUN_BIT, POINT_FIRST_BIT } from '../src/light-linking.js';

function sceneRecipe(environment = {}, shadow = undefined) {
  const node = (id, x) => ({ id, geometry: 'box', translation: [x, 0.5, 0] });
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [],
    nodes: [node('left', -2), node('right', 2), node('floor', 0)],
    environment,
    ...(shadow ? { shadow } : {}),
  };
}

async function sceneFrom(recipe) {
  await loadAgentSceneModules(recipe);
  return createAgentScene(recipe);
}

function maskOf(scene, name) {
  return scene.parts.find(part => part.name === name).material.lightMask;
}

test('a recipe that names no links or cascades loads neither module', () => {
  assert.deepEqual(agentSceneModulesNeeded(sceneRecipe({ keyIntensity: 2 })).filter(name => name === 'lightLinking' || name === 'cascades'), []);
  assert.deepEqual(agentSceneModulesNeeded(sceneRecipe({ shadowCascades: 2, keyAffects: ['left'] })).filter(name => name === 'lightLinking' || name === 'cascades').sort(), ['cascades', 'lightLinking']);
});

test('affects and keyAffects limit lights to the named nodes and keep their shape through export', async () => {
  const environment = { pointLights: [{ position: [0, 3, 0], affects: ['left'] }, { position: [0, 3, 1] }], keyAffects: ['right'], shadowCascades: 2 };
  const scene = await sceneFrom(sceneRecipe(environment));
  const pointBit = index => 1 << (POINT_FIRST_BIT + index);
  assert.equal(maskOf(scene, 'left') & pointBit(0), pointBit(0));
  assert.equal(maskOf(scene, 'right') & pointBit(0), 0);
  assert.equal(maskOf(scene, 'left') & pointBit(1), pointBit(1), 'a light without affects lights every node');
  assert.equal(maskOf(scene, 'left') & (1 << SUN_BIT), 0);
  assert.equal(maskOf(scene, 'right') & (1 << SUN_BIT), 1);
  const exported = scene.exportRecipe().environment;
  assert.deepEqual(exported.pointLights[0].affects, ['left']);
  assert.equal(exported.pointLights[1].affects, undefined);
  assert.deepEqual(exported.keyAffects, ['right']);
  assert.equal(exported.shadowCascades, 2);
});

test('a scene without links keeps plain parts and a recipe shape without the new fields', async () => {
  const scene = await sceneFrom(sceneRecipe({ pointLights: [{ position: [0, 3, 0] }] }));
  assert.equal(maskOf(scene, 'left'), undefined);
  const exported = scene.exportRecipe().environment;
  assert.equal('keyAffects' in exported, false);
  assert.equal('shadowCascades' in exported, false);
});

test('an unknown node in affects fails and names the next action', async () => {
  const recipe = sceneRecipe({ pointLights: [{ position: [0, 3, 0], affects: ['lefft'] }] });
  await loadAgentSceneModules(recipe);
  assert.throws(() => createAgentScene(recipe), /pointLights\[0\]\.affects: lefft.*scene_inspect/);
  assert.throws(() => createAgentScene(sceneRecipe({ keyAffects: ['nowhere'] })), /environment\.keyAffects: nowhere/);
});

test('set-environment carries links, and removing a linked node is refused until the list changes', async () => {
  const scene = await sceneFrom(sceneRecipe());
  await loadAgentSceneModules({ keyAffects: [] });
  scene.apply([{ type: 'set-environment', environment: { keyAffects: ['left'], shadowCascades: 3 } }], { expectedRevision: scene.revision });
  assert.equal(maskOf(scene, 'right') & 1, 0);
  assert.equal(scene.environment.shadowCascades, 3);
  assert.throws(() => scene.apply([{ type: 'remove-node', id: 'left' }], { expectedRevision: scene.revision }), /keyAffects: left/);
  scene.apply([{ type: 'set-environment', environment: { keyAffects: ['right'] } }, { type: 'remove-node', id: 'left' }], { expectedRevision: scene.revision });
  assert.equal(maskOf(scene, 'floor') & 1, 0);
});

test('an edit that leaves the links alone keeps the same part objects', async () => {
  const scene = await sceneFrom(sceneRecipe({ keyAffects: ['left'] }));
  const before = scene.parts;
  scene.apply([{ type: 'set-camera', fov: 50 }], { expectedRevision: scene.revision });
  assert.equal(scene.parts, before);
});

test('cascade counts and affects lists are validated', () => {
  for (const shadowCascades of [5, -1, 1.5, '3']) {
    assert.throws(() => createAgentScene(sceneRecipe({ shadowCascades })), /shadowCascades/);
  }
  assert.throws(() => createAgentScene(sceneRecipe({ keyAffects: 'left' })), /affects must be a list/);
  assert.throws(() => createAgentScene(sceneRecipe({ pointLights: [{ position: [0, 1, 0], affects: [3] }] })), /affects must be a list/);
});

test('cascades turn on by themselves only where one map is coarse, and an explicit count always wins', () => {
  const narrow = { extent: 3.5 };
  const street = { extent: 85 };
  assert.equal(effectiveShadowCascades({}, narrow), 0);
  assert.equal(effectiveShadowCascades({}, { extent: 40 }), 0);
  assert.equal(effectiveShadowCascades({}, street), 3);
  assert.equal(effectiveShadowCascades({ shadowCascades: 0 }, street), 0);
  assert.equal(effectiveShadowCascades({ shadowCascades: 2 }, narrow), 2);
});

test('scene_capabilities says recipes reach linking and cascades', () => {
  assert.ok(AGENT_SCENE_CAPABILITIES.lightLinking.fields.includes('environment.keyAffects'));
  assert.deepEqual([...AGENT_SCENE_CAPABILITIES.shadowCascades.counts], [0, 1, 2, 3, 4]);
});

test('the path tracer traces linking, so its report does not list it', async () => {
  const scene = await sceneFrom(sceneRecipe({ keyAffects: ['left'] }));
  assert.ok(!describeIgnoredFeatures(scene.parts, {}).some(note => /Light linking/.test(note)));
});

function bakeRoom() {
  const cube = box(0, 1);
  const placed = (name, translation, scale) => ({
    name, geometry: cube, matrix: new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, ...translation, 1]),
    material: { tag: 'surface', color: [0.7, 0.7, 0.7], metallic: 0, roughness: 0.8, emission: 0 },
  });
  return [
    placed('floor', [0, -0.05, 0], [6, 0.1, 6]), placed('ceiling', [0, 3.05, 0], [6, 0.1, 6]),
    placed('back', [0, 1.5, -3.05], [6, 3.2, 0.1]), placed('left', [-3.05, 1.5, 0], [0.1, 3.2, 6]),
    placed('right', [3.05, 1.5, 0], [0.1, 3.2, 6]), placed('front', [0, 1.5, 3.05], [6, 3.2, 0.1]),
  ];
}

function bakedPeaks(pointLight) {
  const lighting = { pointLights: [{ position: [0, 2.5, 0], color: [1, 1, 1], intensity: 8, radius: 0.05, ...pointLight }], keyColor: [0, 0, 0] };
  const { report } = bakeLightmaps(bakeRoom(), lighting, { samples: 8, bounces: 2, texelsPerUnit: 2, maxResolution: 32 });
  return Object.fromEntries(report.parts.map(part => [part.name, part.peak]));
}

test('the bake adds no light from a lamp onto parts it skips, even as a bounce', () => {
  const everywhere = bakedPeaks({});
  const nowhere = bakedPeaks({ affects: [] });
  const floorOnly = bakedPeaks({ affects: ['floor'] });
  assert.ok(everywhere.ceiling > 0);
  assert.ok(Object.values(nowhere).every(peak => peak === 0), 'a light that reaches no part bakes nothing');
  assert.ok(floorOnly.ceiling > 0, 'the floor it lights still bounces light');
  assert.ok(floorOnly.ceiling < everywhere.ceiling, 'but the walls it skips no longer bounce the lamp');
});
