import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGltf } from '../src/gltf.js';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { assetCopyKey } from '../src/agent-scene-assets.js';
import { skinnedStripAsset } from './fixtures/skinned-strip.js';

const ASSET_ID = 'ab'.repeat(32);

await loadAllAgentSceneModules();

async function loadedAssets() {
  const document = skinnedStripAsset(gltf => {
    gltf.materials[0].name = 'Skin';
  });
  return new Map([[assetCopyKey(ASSET_ID, 0), await parseGltf(document)]]);
}

const HOT = [0.97, 0.28, 0.03];

function withoutMotion(recipe) {
  const { motion, ...rest } = recipe;
  return rest;
}

function coolingRecipe(extra = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'box' }],
    materials: [{ id: 'grass', color: [0.2, 0.5, 0.2] }],
    nodes: [
      { id: 'floor', geometry: 'ground', material: 'grass' },
      { id: 'stool', asset: { id: ASSET_ID, materials: [{ name: 'Skin', id: 'stool-heat', emissiveColor: HOT, emission: 2 }] } },
    ],
    motion: {
      duration: 2,
      tracks: [
        { kind: 'material', id: 'stool-heat', property: 'emission', keyframes: [{ time: 0, value: 2 }, { time: 2, value: 0 }] },
        { kind: 'material', id: 'stool-heat', property: 'emissiveColor', keyframes: [{ time: 0, value: HOT }, { time: 2, value: [0.2, 0.02, 0] }] },
      ],
    },
    ...extra,
  };
}

function stoolMaterial(scene) {
  return scene.parts.find(part => part.name === 'stool/0').material;
}

test('an asset material override with an id takes emission and emissiveColor tracks', async () => {
  const scene = createAgentScene(coolingRecipe(), {}, { assets: await loadedAssets() });
  const material = stoolMaterial(scene);
  scene.sampleMotion(0);
  assert.equal(material.emission, 2);
  assert.deepEqual(Array.from(material.emissiveColor), HOT);
  scene.sampleMotion(1);
  assert.equal(material.emission, 1, 'the same material object reads the sampled value');
  assert.ok(Math.abs(material.emissiveColor[0] - 0.585) < 1e-6);
  scene.sampleMotion(2);
  assert.equal(material.emission, 0);
  assert.deepEqual(Array.from(material.emissiveColor), [0.2, 0.02, 0]);
});

test('the sampled emission is deterministic and keeps the decoded fields of the material', async () => {
  const first = createAgentScene(coolingRecipe(), {}, { assets: await loadedAssets() });
  const second = createAgentScene(coolingRecipe(), {}, { assets: await loadedAssets() });
  first.sampleMotion(0.75);
  second.sampleMotion(0.75);
  assert.deepEqual(Array.from(stoolMaterial(first).emissiveColor), Array.from(stoolMaterial(second).emissiveColor));
  assert.equal(stoolMaterial(first).emission, stoolMaterial(second).emission);
  const untracked = createAgentScene(withoutMotion(coolingRecipe()), {}, { assets: await loadedAssets() });
  assert.deepEqual(Object.keys(stoolMaterial(first)).sort(), Object.keys(stoolMaterial(untracked)).sort());
});

test('without an id the override is unchanged and no motion track can name it', async () => {
  const plain = coolingRecipe();
  plain.nodes[1].asset.materials[0] = { name: 'Skin', emissiveColor: HOT, emission: 2 };
  assert.throws(() => createAgentScene(plain, {}, { assets: new Map() }), /motion\.tracks\[0\]\.id.*stool-heat/s);
  const scene = createAgentScene(withoutMotion(plain), {}, { assets: await loadedAssets() });
  assert.equal(stoolMaterial(scene).emission, 2);
});

test('emission with no emissive colour glows white while a track drives it', async () => {
  const recipe = coolingRecipe();
  recipe.nodes[1].asset.materials[0] = { name: 'Skin', id: 'stool-heat' };
  recipe.motion.tracks = [{ kind: 'material', id: 'stool-heat', property: 'emission', keyframes: [{ time: 0, value: 0 }, { time: 2, value: 4 }] }];
  const scene = createAgentScene(recipe, {}, { assets: await loadedAssets() });
  scene.sampleMotion(2);
  assert.equal(stoolMaterial(scene).emission, 4);
  assert.deepEqual(Array.from(stoolMaterial(scene).emissiveColor), [1, 1, 1]);
});

test('bad ids and bad keyframe values throw errors that say what to pass', async () => {
  const assets = await loadedAssets();
  const badId = coolingRecipe();
  badId.nodes[1].asset.materials[0].id = '';
  assert.throws(() => createAgentScene(badId, {}, { assets }), /asset\.materials\[0\]\.id.*handle of 1 to 128 characters/s);
  const clash = coolingRecipe();
  clash.materials.push({ id: 'stool-heat' });
  assert.throws(() => createAgentScene(clash, {}, { assets }), /id that no other material or placed asset override uses/);
  const negative = coolingRecipe();
  negative.motion.tracks[0].keyframes[1].value = -1;
  assert.throws(() => createAgentScene(negative, {}, { assets }), /numbers of 0 or more for emission/);
  const twice = coolingRecipe();
  twice.nodes[1].asset.materials.push({ name: 'Skin', id: 'other' });
  assert.throws(() => createAgentScene(twice, {}, { assets }), /different source material/);
});
