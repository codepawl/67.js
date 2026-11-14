import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGltf } from '../src/gltf.js';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { assetCopyKey } from '../src/agent-scene-assets.js';
import { createFragmentShader, createVertexShader } from '../src/shaders.js';
import { materialLayerState, MATERIAL_LAYER_STATE_LENGTH } from '../src/material-layers.js';
import { normalizeEmissionMask } from '../src/emission-mask.js';
import { skinnedStripAsset } from './fixtures/skinned-strip.js';

const ASSET_ID = 'ab'.repeat(32);
const MASK = { axis: 'y', from: 0.2, to: 0.5 };

await loadAllAgentSceneModules();

async function loadedAssets() {
  const document = skinnedStripAsset(gltf => {
    gltf.materials[0].name = 'Skin';
  });
  return new Map([[assetCopyKey(ASSET_ID, 0), await parseGltf(document)]]);
}

function stoolRecipe(override = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'box' }],
    materials: [{ id: 'grass', color: [0.2, 0.5, 0.2] }],
    nodes: [
      { id: 'floor', geometry: 'ground', material: 'grass' },
      { id: 'stool', asset: { id: ASSET_ID, materials: [{ name: 'Skin', emissiveColor: [0.97, 0.28, 0.03], emission: 2, ...override }] } },
    ],
  };
}

async function stoolMaterial(override) {
  const scene = createAgentScene(stoolRecipe(override), {}, { assets: await loadedAssets() });
  return scene.parts.find(part => part.name === 'stool/0').material;
}

test('an asset override carries the mask to the material the renderer draws', async () => {
  const material = await stoolMaterial({ emissionMask: MASK });
  assert.deepEqual({ ...material.emissionMask }, MASK);
  assert.deepEqual(materialLayerState(material).slice(-3), [1, 0.2, 0.5]);
});

test('the same recipe builds the same mask every time', async () => {
  const first = await stoolMaterial({ emissionMask: MASK });
  const second = await stoolMaterial({ emissionMask: MASK });
  assert.deepEqual(materialLayerState(first), materialLayerState(second));
});

test('without a mask the material and its layer state are unchanged', async () => {
  const material = await stoolMaterial({});
  assert.equal(material.emissionMask, undefined);
  const state = materialLayerState(material);
  assert.equal(state.length, MATERIAL_LAYER_STATE_LENGTH);
  assert.deepEqual(state.slice(-3), [-1, 0, 1]);
  assert.notDeepEqual(state, materialLayerState(await stoolMaterial({ emissionMask: MASK })));
});

test('a recipe material takes the same mask', () => {
  const scene = createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box' }],
    materials: [{ id: 'ember', color: [0.3, 0.3, 0.3], emission: 3, emissiveColor: [1, 0.3, 0.05], emissionMask: { axis: 'x', from: 1, to: 0 } }],
    nodes: [{ id: 'block', geometry: 'cube', material: 'ember' }],
  });
  assert.deepEqual({ ...scene.parts[0].material.emissionMask }, { axis: 'x', from: 1, to: 0 });
});

test('the shader code appears only when a mask is used', () => {
  const plain = createFragmentShader(['studioLighting']);
  const masked = createFragmentShader(['studioLighting', 'emissionMask']);
  assert.ok(!plain.includes('materialEmissionMask'));
  assert.ok(masked.includes('materialEmissionMask'));
  const plainVertex = createVertexShader(['studioLighting']);
  const maskedVertex = createVertexShader(['studioLighting', 'emissionMask']);
  assert.ok(plainVertex.includes('if (false) {'), 'the object position stays off without the feature');
  assert.ok(!maskedVertex.includes('if (false) {\n  boxPosition'));
});

test('errors name the field and what to pass', async () => {
  assert.throws(() => normalizeEmissionMask({ axis: 'w', from: 0, to: 1 }, 'asset.materials[0].emissionMask'), /emissionMask\.axis.*one of x, y, z/);
  assert.throws(() => normalizeEmissionMask({ axis: 'y', from: 'low', to: 1 }), /emissionMask\.from.*finite coordinate/);
  assert.throws(() => normalizeEmissionMask({ axis: 'y', from: 0.3, to: 0.3 }), /emissionMask\.to.*different from from/);
  assert.throws(() => normalizeEmissionMask({ axis: 'y', from: 0, to: 1, extra: 1 }), /emissionMask\.extra.*no such field/);
  assert.throws(() => normalizeEmissionMask([0, 1]), /emissionMask.*an object/);
  await assert.rejects(async () => stoolMaterial({ emissionMask: { axis: 'q', from: 0, to: 1 } }), /asset\.materials\[0\]\.emissionMask\.axis/);
});
