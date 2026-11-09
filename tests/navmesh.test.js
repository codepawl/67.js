import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavmesh } from '../src/navmesh.js';
import { createTerrain } from '../src/terrain.js';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';

function flatGround(size, holes = []) {
  const terrain = createTerrain({ size, chunks: 1, levels: 1, resolution: 64, holes, height: () => 0 });
  const { positions, indices } = terrain.parts[0].geometry;
  return { positions, indices };
}

function distanceToHoleCentre(point, hole) {
  return Math.hypot(point[0] - hole.center[0], point[2] - hole.center[1]);
}

test('a path goes around a hole, keeps the agent radius and is deterministic', () => {
  const hole = { center: [0, 0], radius: 3 };
  const navmesh = createNavmesh({ ...flatGround(40, [hole]), agentRadius: 0.3 });
  const first = navmesh.findPath([-15, -15], [15, 15], { spacing: 0.5 });
  const second = createNavmesh({ ...flatGround(40, [hole]), agentRadius: 0.3 }).findPath([-15, -15], [15, 15], { spacing: 0.5 });
  assert.deepEqual(first, second);
  assert.deepEqual(first.points[0].map(Math.round), [-15, 0, -15]);
  assert.deepEqual(first.points.at(-1).map(Math.round), [15, 0, 15]);
  for (const point of first.points) assert.ok(distanceToHoleCentre(point, hole) >= hole.radius + 0.3, `point ${point} is too close to the hole`);
  const straight = Math.hypot(30, 30);
  assert.ok(first.length > straight && first.length < straight * 1.1, `length ${first.length}`);
});

test('string pulling leaves a straight line where nothing is in the way', () => {
  const navmesh = createNavmesh({ ...flatGround(40) });
  const path = navmesh.findPath([-10, -8], [12, 9], { spacing: 100 });
  assert.equal(path.points.length, 2);
  assert.ok(Math.abs(path.length - Math.hypot(22, 17)) < 1e-6);
});

test('a start inside a hole, outside the ground or beside an obstacle is refused with a reason', () => {
  const navmesh = createNavmesh({ ...flatGround(40, [{ center: [0, 0], radius: 3 }]), obstacles: [{ min: [8, 8], max: [10, 10] }] });
  assert.throws(() => navmesh.findPath([0, 0], [10, 0]), /Start .* \(a hole\)/);
  assert.throws(() => navmesh.findPath([-30, 0], [10, 0]), /Start .* outside the ground/);
  assert.throws(() => navmesh.findPath([-10, 0], [9, 9]), /Goal .* not walkable/);
});

test('a wall of holes that cuts the ground in two has no path', () => {
  const wall = Array.from({ length: 11 }, (_, index) => ({ center: [0, -20 + index * 4], radius: 2.2 }));
  const navmesh = createNavmesh({ ...flatGround(40, wall.slice(0, 11)) });
  assert.throws(() => navmesh.findPath([-10, 0], [10, 0]), /no walkable route/);
});

test('the cell and search budgets give clear errors', () => {
  assert.throws(() => createNavmesh({ ...flatGround(40), cellSize: 0.05, maxCells: 1000 }), /over the budget of 1000.*Raise cellSize/);
  const navmesh = createNavmesh({ ...flatGround(40, [{ center: [0, 0], radius: 8 }]) });
  assert.throws(() => navmesh.findPath([-15, -15], [15, 15], { maxSearchNodes: 20 }), /search used 20 nodes/);
});

test('ground that climbs faster than the slope limit blocks the way', () => {
  const terrain = createTerrain({ size: 40, chunks: 1, levels: 1, resolution: 64, height: (x) => (x > 0 ? 6 : 0) });
  const { positions, indices } = terrain.parts[0].geometry;
  const steep = createNavmesh({ positions, indices, maxSlopeDegrees: 30, cellSize: 0.6 });
  assert.throws(() => steep.findPath([-10, 0], [10, 0]), /no walkable route/);
  const gentleTerrain = createTerrain({ size: 40, chunks: 1, levels: 1, resolution: 64, height: (x) => x * 0.2 });
  const gentle = createNavmesh({ positions: gentleTerrain.parts[0].geometry.positions, indices: gentleTerrain.parts[0].geometry.indices, maxSlopeDegrees: 30, cellSize: 0.6 });
  const path = gentle.findPath([-10, 0], [10, 0]);
  assert.ok(Math.abs(path.points.at(-1)[1] - 2) < 0.1);
});

test('scene_inspect path returns translation keyframes around the hole of a recipe terrain', async () => {
  const recipe = {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'terrain', size: 40, resolution: 64, seed: 3, amplitude: 1.2, holes: [{ center: [0, 0], radius: 3 }] }, { id: 'rock', type: 'box' }],
    materials: [{ id: 'grass', color: [0.3, 0.6, 0.2] }],
    nodes: [{ id: 'ground', geometry: 'ground', material: 'grass' }, { id: 'rock', geometry: 'rock', material: 'grass', translation: [-7, 0.5, -7], scale: [3, 1, 3] }],
  };
  await loadAllAgentSceneModules();
  const scene = createAgentScene(recipe);
  const { path } = scene.inspect({ path: { ground: 'ground', from: [-15, -15], to: [15, 15], avoid: ['rock'], seconds: 10, lift: 0.5 } });
  assert.equal(path.keyframes[0].time, 0);
  assert.equal(path.keyframes.at(-1).time, 10);
  for (const { value } of path.keyframes) {
    assert.ok(Math.hypot(value[0], value[2]) >= 3.3, `${value} is inside the hole margin`);
    assert.ok(!(value[0] > -8.8 && value[0] < -5.2 && value[2] > -8.8 && value[2] < -5.2), `${value} is inside the rock`);
  }
  assert.throws(() => scene.inspect({ path: { ground: 'ground', from: [0, 0], to: [15, 15] } }), /a hole/);
  assert.throws(() => scene.inspect({ path: { ground: 'nowhere', from: [0, 0], to: [15, 15] } }), /not a node/);
  assert.throws(() => scene.inspect({ path: { ground: 'ground', from: [-15, -15], to: [15, 15], seconds: 2, speed: 1 } }), /path\.speed: got 1; expected speed or seconds, not both/);
});
