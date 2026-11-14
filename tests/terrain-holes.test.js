import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTerrain, normalizeTerrainHoles } from '../src/terrain.js';
import { createAgentScene, loadAgentSceneModules, agentSceneModulesNeeded, AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';

const SEEDED_OPTIONS = { size: 128, chunks: 4, resolution: 16, levels: 3, height: { amplitude: 10, mountainAmplitude: 30, featureSize: 60 }, seed: 5, eye: [10, 20, 10] };
// Digest of the geometry the terrain made before holes existed. It must not move while the new fields are absent.
const SEEDED_TERRAIN_DIGEST = 'b292b9b25158063726e954d6968a7c538e292da166e5e5c480577b5f1859610e';

function digestOf(terrain) {
  const hash = createHash('sha256');
  for (const part of terrain.parts) {
    for (const key of ['positions', 'normals', 'uvs', 'indices']) {
      const array = part.geometry[key];
      hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
    }
  }
  return hash.digest('hex');
}

function triangleCenters(geometry) {
  const centers = [];
  for (let offset = 0; offset < geometry.indices.length; offset += 3) {
    const center = [0, 0];
    for (let corner = 0; corner < 3; corner++) {
      center[0] += geometry.positions[geometry.indices[offset + corner] * 3] / 3;
      center[1] += geometry.positions[geometry.indices[offset + corner] * 3 + 2] / 3;
    }
    centers.push(center);
  }
  return centers;
}

function triangleTotal(terrain) {
  return terrain.parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
}

test('seeded terrain is byte-identical while holes are absent, undefined or empty', () => {
  assert.equal(digestOf(createTerrain(SEEDED_OPTIONS)), SEEDED_TERRAIN_DIGEST);
  assert.equal(digestOf(createTerrain({ ...SEEDED_OPTIONS, holes: undefined })), SEEDED_TERRAIN_DIGEST);
  assert.equal(digestOf(createTerrain({ ...SEEDED_OPTIONS, holes: [] })), SEEDED_TERRAIN_DIGEST);
});

test('a hole leaves no surface inside it, keeps the rest and reports isHole', () => {
  const holes = [{ center: [6, -10], radius: 9 }];
  const whole = createTerrain(SEEDED_OPTIONS);
  const pierced = createTerrain({ ...SEEDED_OPTIONS, holes });
  assert.ok(triangleTotal(pierced) < triangleTotal(whole));
  assert.equal(pierced.isHole(6, -10), true);
  assert.equal(pierced.isHole(40, 40), false);
  assert.equal(whole.isHole(6, -10), false);
  for (const part of pierced.parts) {
    for (const [centerX, centerZ] of triangleCenters(part.geometry)) {
      assert.ok(Math.hypot(centerX - 6, centerZ + 10) > 9 - 8, 'no triangle sits deep inside the hole');
    }
  }
  assert.equal(pierced.heightAt(30, 30), whole.heightAt(30, 30));
});

test('a hole covering the whole ground gives empty geometry instead of throwing', () => {
  const terrain = createTerrain({ size: 16, chunks: 1, levels: 1, resolution: 8, holes: [{ center: [0, 0], radius: 100 }] });
  assert.equal(terrain.triangleCount, 0);
  assert.equal(terrain.parts[0].geometry.indices.length, 0);
});

test('hostile hole lists are rejected with a clear error', () => {
  const hostile = [
    'holes', 5, {}, [null], [{}], [{ center: [0, 0] }], [{ radius: 2 }],
    [{ center: [0, 0], radius: 0 }], [{ center: [0, 0], radius: -3 }], [{ center: [0, 0], radius: Infinity }],
    [{ center: [NaN, 0], radius: 2 }], [{ center: [0], radius: 2 }], [{ center: [0, 0, 0], radius: 2 }], [{ center: 'ab', radius: 2 }],
    Array.from({ length: 65 }, () => ({ center: [0, 0], radius: 1 })),
  ];
  for (const holes of hostile) assert.throws(() => normalizeTerrainHoles(holes), RangeError, JSON.stringify(holes)?.slice(0, 40));
  assert.throws(() => createTerrain({ ...SEEDED_OPTIONS, holes: [{ center: [0, 0], radius: -1 }] }), RangeError);
});

const baseRecipe = terrain => ({
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'ground', ...terrain }],
  materials: [{ id: 'grass', color: [0.3, 0.6, 0.2] }],
  nodes: [{ id: 'ground', geometry: 'ground', material: 'grass' }],
});

async function sceneFor(terrain) {
  const recipe = baseRecipe(terrain);
  await loadAgentSceneModules(recipe);
  return createAgentScene(recipe);
}

test('a recipe terrain has hills, a hole and a stable seed', async () => {
  const description = { type: 'terrain', size: 40, resolution: 64, seed: 3, amplitude: 1.5, holes: [{ center: [0, 0], radius: 3 }] };
  assert.deepEqual(agentSceneModulesNeeded(baseRecipe(description)), ['terrain']);
  const scene = await sceneFor(description);
  const geometry = scene.parts[0].geometry;
  const heights = Array.from({ length: geometry.positions.length / 3 }, (_, index) => geometry.positions[index * 3 + 1]);
  assert.ok(Math.max(...heights) - Math.min(...heights) > 0.3, 'the ground rolls');
  assert.ok(Math.max(...heights.map(Math.abs)) <= 1.6, 'hills stay within the amplitude');
  assert.ok(triangleCenters(geometry).every(([centerX, centerZ]) => Math.hypot(centerX, centerZ) > 2), 'the hole is open');
  assert.ok(triangleCenters(geometry).some(([centerX, centerZ]) => Math.hypot(centerX - 8, centerZ - 8) < 1), 'the rest is solid');
  const again = await sceneFor(description);
  assert.deepEqual(Array.from(again.parts[0].geometry.positions), Array.from(geometry.positions));
  assert.equal(scene.exportRecipe().geometries[0].holes[0].radius, 3);
});

test('recipe terrain rejects out-of-range, hostile and unknown fields before building', async () => {
  const bad = [
    { type: 'terrain', size: 0 }, { type: 'terrain', size: 5000 }, { type: 'terrain', size: NaN },
    { type: 'terrain', resolution: 1 }, { type: 'terrain', resolution: 257 }, { type: 'terrain', resolution: 12.5 },
    { type: 'terrain', amplitude: -1 }, { type: 'terrain', amplitude: 1e9 },
    { type: 'terrain', holes: 'one' }, { type: 'terrain', holes: Array.from({ length: 17 }, () => ({ center: [0, 0], radius: 1 })) },
    { type: 'terrain', holes: [{ center: [0, 0], radius: -2 }] }, { type: 'terrain', holes: [null] },
    { type: 'terrain', unknown: 1 },
  ];
  for (const description of bad) {
    await assert.rejects(() => sceneFor(description), Error, JSON.stringify(description).slice(0, 60));
  }
});

test('the capabilities list the terrain geometry and its limits', () => {
  assert.ok(AGENT_SCENE_CAPABILITIES.geometryTypes.includes('terrain'));
  assert.match(AGENT_SCENE_CAPABILITIES.terrain, /holes/);
});
