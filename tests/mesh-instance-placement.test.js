import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box, sphere } from '../src/geometry.js';
import { createAgentScene } from '../src/agent-scene.js';
import { expandInstancedNodes } from '../src/mesh-instances.js';

const base = { id: 'rock', geometry: 'rockA', material: 'stone' };
const surfaceGeometry = sphere(16, 8);
const options = { maxNodes: 4096, resolveSurface: () => surfaceGeometry };

function expand(instances, node = base, extra = options) {
  return expandInstancedNodes([{ ...node, instances }], extra);
}

function children(nodes) {
  return nodes.slice(1);
}

function minimumDistance(nodes) {
  let smallest = Infinity;
  const list = children(nodes);
  for (let first = 0; first < list.length; first++) {
    for (let second = first + 1; second < list.length; second++) {
      smallest = Math.min(smallest, Math.hypot(...list[first].translation.map((value, axis) => value - list[second].translation[axis])));
    }
  }
  return smallest;
}

test('a rock field with Poisson spacing has no overlaps, three variants and is deterministic', () => {
  const field = {
    scatter: { count: 600, min: [-10, 0, -10], max: [10, 0, 10] },
    seed: 11,
    yaw: true,
    place: { spacing: 1.5, variants: ['rockA', 'rockB', { geometry: 'rockC', material: 'moss' }] },
  };
  const first = expand(field);
  assert.ok(children(first).length > 40, `kept ${children(first).length}`);
  assert.ok(minimumDistance(first) >= 1.5, `closest pair ${minimumDistance(first)}`);
  const used = new Set(children(first).map(node => `${node.geometry}/${node.material}`));
  assert.deepEqual([...used].sort(), ['rockA/stone', 'rockB/stone', 'rockC/moss']);
  assert.equal(JSON.stringify(first), JSON.stringify(expand(field)));
  assert.notEqual(JSON.stringify(first), JSON.stringify(expand({ ...field, seed: 12 })));
});

test('a variant field picks the geometry by index, wrapped', () => {
  const nodes = expand({
    grid: { counts: [6, 1, 1], spacing: [1, 1, 1] },
    place: { variants: ['a', 'b', 'c'], variant: { attr: 'index' } },
  });
  assert.deepEqual(children(nodes).map(node => node.geometry), ['a', 'b', 'c', 'a', 'b', 'c']);
});

test('density keeps points by chance and a zero density drops them all', () => {
  const grid = { counts: [20, 1, 20], spacing: [1, 1, 1] };
  const half = children(expand({ grid, seed: 3, place: { density: 0.5 } })).length;
  assert.ok(half > 120 && half < 280, `kept ${half}`);
  assert.equal(children(expand({ grid, place: { density: 0 } })).length, 0);
  assert.equal(children(expand({ grid, place: { density: 1 } })).length, 400);
  const ramp = children(expand({ grid, seed: 3, place: { density: { saturate: { add: [0.5, { mul: [0.1, { attr: 'position', component: 'x' }] }] } } } }));
  const eastShare = ramp.filter(node => node.translation[0] > 0).length / ramp.length;
  assert.ok(eastShare > 0.7, `east share ${eastShare}`);
});

test('rotation and size fields turn and stretch each instance', () => {
  const nodes = children(expand({
    grid: { counts: [2, 1, 1], spacing: [1, 1, 1] },
    place: { rotation: { vec: [0, Math.PI, 0] }, size: { vec: [1, { add: [1, { attr: 'index' }] }, 1] } },
  }));
  assert.deepEqual(nodes[0].scale, [1, 1, 1]);
  assert.deepEqual(nodes[1].scale, [1, 2, 1]);
  assert.ok(Math.abs(nodes[0].rotation[1] - 1) < 1e-9 && Math.abs(nodes[0].rotation[3]) < 1e-9);
  const uniform = children(expand({ grid: { counts: [1, 1, 1], spacing: [1, 1, 1] }, scale: [2, 2], place: { size: 3 } }));
  assert.deepEqual(uniform[0].scale, [6, 6, 6]);
  const clamped = children(expand({ grid: { counts: [1, 1, 1], spacing: [1, 1, 1] }, place: { size: -4 } }));
  assert.deepEqual(clamped[0].scale, [0.001, 0.001, 0.001]);
});

test('a fence follows a curve with evenly spaced posts turned along it', () => {
  const nodes = children(expand({
    curve: { points: [[0, 0, 0], [8, 0, 0], [8, 0, 6]], count: 8 },
    alignToNormal: true,
    place: { variants: ['post', 'postWithRail'], variant: { mod: [{ attr: 'index' }, 2] } },
  }));
  assert.equal(nodes.length, 8);
  assert.deepEqual(nodes[0].translation, [0, 0, 0]);
  assert.ok(Math.abs(nodes[7].translation[0] - 8) < 1e-9 && Math.abs(nodes[7].translation[2] - 6) < 1e-9);
  assert.deepEqual(nodes.map(node => node.geometry), ['post', 'postWithRail', 'post', 'postWithRail', 'post', 'postWithRail', 'post', 'postWithRail']);
  assert.ok(nodes[0].rotation[2] !== 0, 'the first post turns to the +X direction of travel');
});

test('place.at takes the vertices or face centres of a surface, welded and bounded', () => {
  const cube = box(0, 1);
  const cubeOptions = { ...options, resolveSurface: () => cube };
  const surface = { geometry: 'crate', count: 64 };
  const vertices = children(expand({ surface, place: { at: 'vertices' } }, base, cubeOptions));
  assert.equal(vertices.length, 8);
  const faces = children(expand({ surface, place: { at: 'faces' } }, base, cubeOptions));
  assert.equal(faces.length, cube.indices.length / 3);
  assert.throws(() => expand({ surface: { geometry: 'crate', count: 4 }, place: { at: 'vertices' } }, base, cubeOptions), /raise the surface count/);
  assert.throws(() => expand({ grid: { counts: [1, 1, 1], spacing: [1, 1, 1] }, place: { at: 'vertices' } }), /needs a surface source/);
});

test('bad place records name the field', () => {
  const grid = { counts: [2, 1, 1], spacing: [1, 1, 1] };
  const bad = [
    [{ spacing: 0 }, /spacing/],
    [{ spacing: 'wide' }, /spacing/],
    [{ at: 'edges' }, /at is/],
    [{ variants: [] }, /variants/],
    [{ variants: [{ geometry: 'a', extra: 1 }] }, /variants entries/],
    [{ variant: 1 }, /needs a variants list/],
    [{ colour: 1 }, /does not take/],
    [{ density: [1, 2, 3] }, /expected a number/],
    [{ rotation: 1 }, /expected a vector/],
    [[], /must be an object/],
  ];
  for (const [place, message] of bad) {
    assert.throws(() => expand({ grid, place }), message, JSON.stringify(place));
  }
  assert.throws(() => expandInstancedNodes([{ id: 'bare', material: 'stone', instances: { grid } }], options), /geometry and material/);
});

test('curve source accepts length spacing or count, with fillet and closed loops', () => {
  const open = children(expand({
    curve: { points: [[0, 0, 0], [6, 0, 0], [6, 0, 4]], length: 2 },
    alignToNormal: true,
  }));
  assert.equal(open.length, 6);
  assert.deepEqual(open[0].translation, [0, 0, 0]);
  assert.ok(Math.abs(open[5].translation[0] - 6) < 1e-9 && Math.abs(open[5].translation[2] - 4) < 1e-9);

  const closed = children(expand({
    curve: { points: [[0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4]], length: 4, closed: true, fillet: 0.5 },
  }));
  assert.equal(closed.length, 4);

  assert.throws(() => expand({ curve: { points: [[0, 0, 0], [2, 0, 0]], count: 3, length: 1 } }), /count or length/);
  assert.throws(() => expand({ curve: { points: [[0, 0, 0], [2, 0, 0]] } }), /count or length/);
  assert.throws(() => expand({ curve: { points: [[0, 0, 0], [2, 0, 0]], length: 0 } }), /curve length/);
});

test('realize merges instances into one mesh per material in expandInstancedNodes and createAgentScene', () => {
  const cube = box(0, 1);
  const cubeVerts = cube.positions.length / 3;
  const cubeIndices = cube.indices.length;
  const realized = children(expand({
    grid: { counts: [4, 1, 1], spacing: [2, 0, 0] },
    place: {
      variants: ['rockA', { geometry: 'rockB', material: 'moss' }],
      variant: { mod: [{ attr: 'index' }, 2] },
      realize: true,
    },
  }, base, { ...options, resolveSurface: () => cube }));
  assert.equal(realized.length, 2);
  assert.equal(realized[0].material, 'stone');
  assert.equal(realized[1].material, 'moss');
  assert.equal(realized[0].realizedGeometry.positions.length / 3, cubeVerts * 2);
  assert.equal(realized[0].realizedGeometry.indices.length, cubeIndices * 2);

  assert.throws(() => expand({
    grid: { counts: [10, 1, 1], spacing: [1, 1, 1] },
    realize: true,
  }, base, { ...options, maxVertices: cubeVerts * 2, resolveSurface: () => cube }), /Realized instances have/);
  assert.throws(() => expand({ grid: { counts: [2, 1, 1], spacing: [1, 1, 1] }, realize: 'yes' }), /realize must be boolean/);
  assert.throws(() => expand({ grid: { counts: [2, 1, 1], spacing: [1, 1, 1] }, place: { realize: 'yes' } }), /realize must be boolean/);

  const scene = createAgentScene({
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'post', type: 'box', bevel: 0, subdivisions: 1 }],
    materials: [{ id: 'wood', color: [0.5, 0.3, 0.1] }],
    nodes: [{
      id: 'fence', geometry: 'post', material: 'wood',
      instances: { curve: { points: [[0, 0, 0], [6, 0, 0]], length: 2 }, alignToNormal: true, realize: true },
    }],
  });
  assert.equal(scene.parts.length, 1);
  assert.equal(scene.parts[0].name, 'fence.0');
  assert.equal(scene.parts[0].geometry.positions.length / 3, 24 * 4);
  const afterEdit = scene.apply([{ type: 'set-node', id: 'fence', translation: [0, 1, 0] }], { expectedRevision: scene.revision });
  assert.equal(afterEdit, 1);
  assert.equal(scene.parts.length, 1);
});
