import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGltf } from '../src/gltf.js';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { assetCopyKey } from '../src/agent-scene-assets.js';
import { createTerrain } from '../src/terrain.js';
import { scatterVegetation } from '../src/vegetation.js';
import { seasonLeafColor } from '../src/agent-vegetation.js';
import { skinnedStripAsset } from './fixtures/skinned-strip.js';

await loadAllAgentSceneModules();

const GROUND = { id: 'ground', type: 'terrain', size: 60, resolution: 48, seed: 3, amplitude: 2 };
const CLEARING = { center: [0, 0], radius: 9 };
const SCATTER = { ground: 'hills', density: 0.02, slopeLimit: 30, exclude: [CLEARING], variants: 2 };

function forestRecipe(overrides = {}) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [GROUND, { id: 'marker', type: 'box' }],
    materials: [{ id: 'grass', tag: 'grass', color: [0.2, 0.4, 0.1] }, { id: 'steel', color: [0.6, 0.6, 0.6] }],
    nodes: [
      { id: 'hills', geometry: 'ground', material: 'grass' },
      { id: 'forest', vegetation: { mix: { broadleaf: 3, birch: 1, conifer: 2 }, seed: 11, scatter: SCATTER, ...overrides } },
      { id: 'marker', geometry: 'marker', material: 'steel', translation: [0, 1, 0] },
    ],
    camera: { eye: [0, 6, 40], target: [0, 4, 0] },
    environment: { wind: { strength: 0.8, direction: 30 } },
    motion: { duration: 2, tracks: [{ kind: 'node', id: 'marker', property: 'translation', keyframes: [{ time: 0, value: [0, 1, 0] }, { time: 2, value: [3, 1, 0] }] }] },
  };
}

function stillRecipe() {
  const { motion, ...still } = forestRecipe();
  return still;
}

function vegetationMatrices(scene) {
  return scene.parts.filter(part => part.name.startsWith('forest/')).map(part => [part.name, Array.from(part.matrix)]);
}

test('a forest clearing grows on terrain through the recipe, keeps the clearing clear, and a seek gives the same frame', () => {
  const scene = createAgentScene(forestRecipe());
  const report = scene.inspect().vegetation[0];
  assert.equal(report.mode, 'scatter');
  assert.ok(report.instances > 20, `placed ${report.instances}`);
  const parts = scene.parts.filter(part => part.name.startsWith('forest/'));
  assert.ok(parts.length >= report.instances, 'bark and foliage parts for the instances');
  for (const part of parts) {
    assert.ok(Math.hypot(part.matrix[12], part.matrix[14]) > CLEARING.radius, `${part.name} stands outside the clearing`);
  }
  const counted = Object.values(report.species).reduce((total, species) => total + species.instances, 0);
  assert.equal(counted, report.instances);
  const drawnLevels = Object.values(report.species).flatMap(species => species.levels).reduce((total, count) => total + count, 0);
  assert.equal(drawnLevels + report.culled, report.instances);
  assert.ok(report.triangles > 0);
  assert.ok(parts.some(part => part.material.tag === 'foliage'));

  const before = vegetationMatrices(scene);
  const levelsBefore = JSON.stringify(report.species);
  scene.sampleMotion(1.5);
  assert.equal(scene.parts.find(part => part.name === 'marker').matrix[12], 2.25, 'the motion did move the scene');
  assert.deepEqual(vegetationMatrices(scene), before);
  scene.sampleMotion(0);
  assert.deepEqual(vegetationMatrices(scene), before);
  assert.equal(JSON.stringify(scene.inspect().vegetation[0].species), levelsBefore);
});

test('the same scatter through the recipe and through the addon gives the same instances for a seed', () => {
  const scene = createAgentScene(forestRecipe());
  const terrain = createTerrain({
    size: 60, chunks: 1, levels: 1, resolution: 48, seed: 3,
    height: { amplitude: 2, featureSize: 15, warp: 0, mountainMask: () => 0 },
  });
  const addon = scatterVegetation({
    area: { minX: -29.5, maxX: 29.5, minZ: -29.5, maxZ: 29.5 },
    density: 0.02, terrainHeight: terrain.heightAt, slopeLimit: 30,
    exclusion: (x, z) => Math.hypot(x - CLEARING.center[0], z - CLEARING.center[1]) <= CLEARING.radius,
    seed: 11, mix: { broadleaf: 3, birch: 1, conifer: 2 }, variants: 2, leaves: 'cards',
  });
  const recipePlaced = new Map();
  for (const part of scene.parts.filter(candidate => candidate.name.startsWith('forest/'))) {
    recipePlaced.set(Number(part.name.split('/')[1]), Array.from(part.matrix));
  }
  assert.equal(scene.inspect().vegetation[0].instances, addon.instances.length);
  assert.ok(addon.instances.length > 20);
  addon.instances.forEach((instance, index) => {
    assert.deepEqual(recipePlaced.get(index), Array.from(instance.matrix), `instance ${index} (${instance.species})`);
  });
  assert.deepEqual(scene.inspect().vegetation[0].species, Object.fromEntries(Object.entries(addon.counts).map(([name, count]) => [name, { instances: count, levels: scene.inspect().vegetation[0].species[name].levels }])));
});

test('levels follow the recipe camera and are not changed by time', () => {
  const near = createAgentScene(forestRecipe()).inspect().vegetation[0];
  const far = createAgentScene({ ...forestRecipe(), camera: { eye: [0, 6, 400], target: [0, 4, 0] } }).inspect().vegetation[0];
  const meanLevel = report => {
    const levels = Object.values(report.species).flatMap(species => species.levels.map((count, level) => [count, level]));
    return levels.reduce((total, [count, level]) => total + count * level, 0) / Math.max(1, levels.reduce((total, [count]) => total + count, 0));
  };
  assert.ok(meanLevel(far) > meanLevel(near));
  const culled = createAgentScene(forestRecipe({ cullDistance: 20 })).inspect().vegetation[0];
  assert.ok(culled.culled > 0 && culled.culled < culled.instances);
});

test('season tints leaves, and bare season drops deciduous foliage but keeps conifers green', () => {
  const leafMap = scene => scene.parts.find(part => part.material.tag === 'foliage').material.map;
  const stand = season => createAgentScene({ ...stillRecipe(), nodes: [
    { id: 'hills', geometry: 'ground', material: 'grass' },
    { id: 'forest', vegetation: { mix: { broadleaf: 1 }, seed: 5, season, scatter: SCATTER } },
  ] });
  const summer = stand(0);
  const autumn = stand(0.5);
  assert.notEqual(leafMap(autumn), leafMap(summer), 'autumn recolours the leaf sprite');
  assert.deepEqual(seasonLeafColor([64, 110, 36], 0), [64, 110, 36]);
  assert.deepEqual(seasonLeafColor([64, 110, 36], 0.35), [196, 150, 40]);
  const bare = createAgentScene(forestRecipe({ season: 1 }));
  const roles = bare.parts.filter(part => part.name.startsWith('forest/')).map(part => part.name.split('/')[2]);
  assert.ok(roles.includes('foliage'), 'conifer foliage stays');
  const deciduousOnly = stand(1);
  assert.ok(deciduousOnly.parts.filter(part => part.name.startsWith('forest/')).every(part => part.name.endsWith('/bark')));
});

test('one tree grows at the node transform and validation names the problem', () => {
  const single = createAgentScene({
    format: '67js.scene', schemaVersion: 1,
    nodes: [{ id: 'oak', translation: [4, 0, 2], vegetation: { species: 'broadleaf', seed: 2, height: 9 } }],
    camera: { eye: [4, 4, 20], target: [4, 4, 2] },
  });
  assert.equal(single.inspect().vegetation[0].mode, 'tree');
  assert.equal(single.parts.length, 2);
  assert.equal(single.parts[0].matrix[12], 4);
  const bad = (vegetation, pattern) => assert.throws(() => createAgentScene({ ...stillRecipe(), nodes: [{ id: 'hills', geometry: 'ground', material: 'grass' }, { id: 'marker', geometry: 'marker', material: 'steel' }, { id: 'forest', vegetation }] }), pattern);
  bad({ mix: { broadleaf: 1 }, scatter: { ground: 'marker' } }, /vegetation\.scatter\.ground: got "marker"; expected the ID of a node that draws a terrain geometry/);
  bad({ mix: { oak: 1 }, scatter: { ground: 'hills' } }, /vegetation\.mix: got "oak"; expected species names among/);
  bad({ species: 'broadleaf', mix: { birch: 1 } }, /vegetation\.species: got "broadleaf"; expected exactly one of species/);
  bad({ species: 'grass' }, /vegetation\.species: got "grass"; expected one of broadleaf/);
  bad({ mix: { grass: 1 }, scatter: { ground: 'hills', density: 4 } }, /vegetation\.scatter\.density: got 4; expected a density that tries at most/);
});

test('environment.wind validates and survives export', () => {
  const scene = createAgentScene(forestRecipe());
  assert.deepEqual(scene.environment.wind, { strength: 0.8, direction: 30 });
  assert.deepEqual(scene.exportRecipe().environment.wind, { strength: 0.8, direction: 30 });
  assert.throws(() => createAgentScene({ ...forestRecipe(), environment: { wind: { strength: 9 } } }), /environment\.wind\.strength: got 9; expected a number from 0 to 4/);
  assert.throws(() => createAgentScene({ ...forestRecipe(), environment: { wind: { speed: 1 } } }), /environment\.wind\.speed: got 1; expected no such field; use one of strength, direction/);
});

test('an imported tree with a foliage override gets the swaying tag and shares it between placements', async () => {
  const id = 'ef'.repeat(32);
  const asset = await parseGltf(skinnedStripAsset(document => { document.materials[0].name = 'Leaves'; }));
  const assets = new Map([[assetCopyKey(id, 0), asset]]);
  const recipe = {
    format: '67js.scene', schemaVersion: 1,
    nodes: [
      { id: 'a', asset: { id, materials: [{ name: 'Leaves', tag: 'foliage', color: [0.2, 0.5, 0.1] }] } },
      { id: 'b', translation: [3, 0, 0], asset: { id, materials: [{ name: 'Leaves', tag: 'foliage', color: [0.2, 0.5, 0.1] }] } },
      { id: 'plain', translation: [6, 0, 0], asset: { id } },
    ],
  };
  const scene = createAgentScene(recipe, {}, { assets });
  const material = name => scene.parts.find(part => part.name === `${name}/0`).material;
  assert.equal(material('a').tag, 'foliage');
  assert.equal(material('a'), material('b'));
  assert.notEqual(material('plain').tag, 'foliage');
  assert.throws(() => createAgentScene({ ...recipe, nodes: [{ id: 'a', asset: { id, materials: [{ name: 'Leaves', tag: 'water' }] } }] }, {}, { assets }), /^RangeError: nodes\[0\]\.asset\.materials\[0\]\.tag: got "water"; expected one of surface, foliage, grass/);
});
