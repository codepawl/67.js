import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { meshFromGeometry, applyMeshEdits } from '../src/mesh.js';
import { vertexGroupWeights } from '../src/mesh-data.js';
import { checkOcclusionWork } from '../src/mesh-masks.js';

// A box cut into squares, so a vertex lies on a face, on an edge or at a corner.
function cutBox(cuts = 3) {
  return applyMeshEdits(meshFromGeometry(box(0, 1)), [{ op: 'subdivide_edges', edges: { all: true }, cuts }]).mesh;
}

function measured(edit, base = cutBox()) {
  const mesh = applyMeshEdits(base, [{ op: 'vertex_group', name: 'mask', ...edit }]).mesh;
  return { mesh, weights: vertexGroupWeights(mesh, 'mask') };
}

function sameBytes(first, second) {
  return Buffer.from(first.buffer).equals(Buffer.from(second.buffer));
}

test('the measures give back one weight from 0 to 1 for every vertex', () => {
  for (const measure of ['curvature', 'edge', 'occlusion']) {
    const { mesh, weights } = measured({ measure });
    assert.equal(weights.length, mesh.vertexCount, measure);
    assert.ok(weights.every(weight => weight >= 0 && weight <= 1), measure);
  }
});

test('edge is high on the convex folds of a box and falls to 0 away from them', () => {
  const { weights } = measured({ measure: 'edge', angle: 45 });
  assert.ok(weights.some(weight => weight === 1), 'a 90 degree fold passes a 45 degree limit');
  assert.ok(weights.some(weight => weight === 0), 'a flat face has no fold');
  const wide = measured({ measure: 'edge', angle: 179 }).weights;
  assert.ok(Math.max(...wide) < 0.6, 'a 90 degree fold is half of 179 degrees');
});

test('edge ignores a concave fold', () => {
  const room = applyMeshEdits(cutBox(), [{ op: 'flip_normals' }]).mesh;
  const { weights } = measured({ measure: 'edge' }, room);
  assert.ok(weights.every(weight => weight === 0), 'seen from inside, every fold of the box is concave');
});

test('curvature is 0.5 on a flat face and above it on a convex corner', () => {
  const { mesh, weights } = measured({ measure: 'curvature' });
  let corners = 0;
  let flats = 0;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const touching = [0, 1, 2].filter(axis => Math.abs(Math.abs(mesh.positions[vertex * 3 + axis]) - 0.5) < 1e-6).length;
    if (touching === 3) {
      assert.ok(weights[vertex] > 0.9, `corner ${vertex} is ${weights[vertex]}`);
      corners++;
    }
    if (touching === 1) {
      assert.ok(Math.abs(weights[vertex] - 0.5) < 1e-6, `face vertex ${vertex} is ${weights[vertex]}`);
      flats++;
    }
  }
  assert.ok(corners === 8 && flats > 0);
});

test('curvature is below 0.5 inside a concave box', () => {
  const room = applyMeshEdits(cutBox(), [{ op: 'flip_normals' }]).mesh;
  const { weights } = measured({ measure: 'curvature' }, room);
  assert.ok(Math.min(...weights) < 0.1);
  assert.ok(Math.max(...weights) < 0.55);
});

test('a larger curvature gain saturates sooner', () => {
  const soft = measured({ measure: 'curvature', gain: 0.5 }).weights;
  const hard = measured({ measure: 'curvature', gain: 8 }).weights;
  assert.ok(soft.every((weight, vertex) => hard[vertex] >= weight - 1e-6));
  assert.ok(soft.some((weight, vertex) => hard[vertex] > weight + 0.1));
});

// A box with a deep groove cut into its top: the groove floor sees little sky.
function grooved() {
  return applyMeshEdits(cutBox(7), [
    { op: 'inset_region', select: { tag: 'top' }, thickness: 0.15, depth: -0.3 },
  ]).mesh;
}

test('occlusion is higher at the bottom of a pocket than on the open top', () => {
  const pocket = grooved();
  const { mesh, weights } = measured({ measure: 'occlusion', rays: 48, distance: 1, seed: 7 }, pocket);
  let floor = 0;
  let floorCount = 0;
  let outside = 0;
  let outsideCount = 0;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const height = mesh.positions[vertex * 3 + 1];
    if (Math.abs(height - 0.2) < 0.01 && Math.abs(mesh.positions[vertex * 3]) < 0.1 && Math.abs(mesh.positions[vertex * 3 + 2]) < 0.1) {
      floor += weights[vertex];
      floorCount++;
    }
    if (height < -0.49) {
      outside += weights[vertex];
      outsideCount++;
    }
  }
  assert.ok(floorCount > 0 && outsideCount > 0);
  assert.ok(floor / floorCount > outside / outsideCount, `pocket floor ${floor / floorCount}, bottom ${outside / outsideCount}`);
});

test('every measure gives the same bytes for the same mesh and seed, and occlusion changes with the seed', () => {
  for (const measure of ['curvature', 'edge', 'occlusion']) {
    assert.ok(sameBytes(measured({ measure }, grooved()).weights, measured({ measure }, grooved()).weights), measure);
  }
  const edit = { measure: 'occlusion', rays: 8, distance: 2 };
  assert.ok(sameBytes(measured({ ...edit, seed: 5 }, grooved()).weights, measured({ ...edit, seed: 5 }, grooved()).weights));
  assert.ok(!sameBytes(measured({ ...edit, seed: 5 }, grooved()).weights, measured({ ...edit, seed: 6 }, grooved()).weights));
});

test('select limits which vertices a measure writes', () => {
  const some = measured({ measure: 'edge', select: { tag: 'top' } }).weights;
  const all = measured({ measure: 'edge' }).weights;
  const count = weights => weights.filter(weight => weight === 1).length;
  assert.ok(count(some) > 0 && count(some) < count(all));
});

test('invalid measure edits say what to pass', () => {
  const run = edit => () => applyMeshEdits(cutBox(), [{ op: 'vertex_group', name: 'mask', ...edit }]);
  assert.throws(run({ measure: 'rust' }), /one of curvature, edge, occlusion/);
  assert.throws(run({ measure: 'edge', rays: 8 }), /measure "edge" takes angle/);
  assert.throws(run({ measure: 'curvature', gain: 100 }), /gain/);
  assert.throws(run({ measure: 'occlusion', rays: 0 }), /whole number from 1 to 128/);
  assert.throws(run({ measure: 'occlusion', distance: -1 }), /distance/);
  assert.throws(run({ measure: 'edge', weight: 1 }), /only one of/);
});

test('occlusion refuses work over the ray limit and says how to shrink it', () => {
  assert.throws(() => checkOcclusionWork(20000, 128), /fewer rays/);
  assert.doesNotThrow(() => checkOcclusionWork(10000, 128));
});

test('a vertex_color gradient follows the weights of a group, in three stops', () => {
  const stops = [[0.1, 0.1, 0.1], [0.8, 0.1, 0.1], [0.9, 0.9, 0.9]];
  const mesh = applyMeshEdits(cutBox(), [
    { op: 'vertex_group', name: 'wear', measure: 'curvature' },
    { op: 'vertex_color', gradient: { group: 'wear', colors: stops } },
  ]).mesh;
  const weights = vertexGroupWeights(mesh, 'wear');
  const colors = mesh.attributes.corner.color.data;
  for (let corner = 0; corner < mesh.cornerCount; corner++) {
    const position = weights[mesh.cornerVertices[corner]] * 2;
    const lower = Math.min(1, Math.floor(position));
    for (let channel = 0; channel < 3; channel++) {
      const expected = stops[lower][channel] + (stops[lower + 1][channel] - stops[lower][channel]) * (position - lower);
      assert.ok(Math.abs(colors[corner * 3 + channel] - expected) < 1e-5);
    }
  }
});

test('a vertex_color group gradient names the fix for an unknown group or a bad gradient', () => {
  const run = gradient => () => applyMeshEdits(cutBox(), [{ op: 'vertex_color', gradient }]);
  assert.throws(run({ group: 'nope', colors: [[0, 0, 0], [1, 1, 1]] }), /Unknown vertex group nope/);
  assert.throws(run({ group: 'wear', colors: [[0, 0, 0]] }), /two colors/);
  assert.throws(run({ group: 'wear', axis: 'y', colors: [[0, 0, 0], [1, 1, 1]] }), /group gradient fields/);
});

test('stratified occlusion rays give the same bytes on every run, in whole shares of the rays, and 0 on an open face', () => {
  const edit = { measure: 'occlusion', rays: 64, distance: 1, seed: 3 };
  const first = measured(edit, grooved());
  const second = measured(edit, grooved());
  assert.ok(sameBytes(first.weights, second.weights));
  for (const weight of first.weights) {
    assert.ok(Math.abs(weight * 64 - Math.round(weight * 64)) < 1e-4, `${weight} is not a whole share of 64 rays`);
  }
  let topWeights = 0;
  let topCount = 0;
  for (let vertex = 0; vertex < first.mesh.vertexCount; vertex++) {
    if (first.mesh.positions[vertex * 3 + 1] > 0.49) {
      topWeights += first.weights[vertex];
      topCount++;
    }
  }
  assert.ok(topCount > 0);
  assert.equal(topWeights, 0, 'the open top is not occluded');
});
