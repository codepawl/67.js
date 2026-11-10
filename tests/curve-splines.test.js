import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { curve, curveSet } from '../src/modeling.js';
import { sampleNurbs, sampleSpline, shapeToSpline, trimSamples } from '../src/modeling-splines.js';

function hashOf(mesh) {
  const hash = createHash('sha256');
  for (const array of [mesh.positions, mesh.normals, mesh.uvs, mesh.indices]) hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
  return hash.digest('hex');
}

function bounds({ positions }) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], positions[offset + axis]);
      maximum[axis] = Math.max(maximum[axis], positions[offset + axis]);
    }
  }
  return { minimum, maximum };
}

function openEdges({ positions, indices }) {
  const keyOf = vertex => Array.from(positions.subarray(vertex * 3, vertex * 3 + 3), value => value.toFixed(5)).join(',');
  const uses = new Map();
  for (let offset = 0; offset < indices.length; offset += 3) {
    for (let side = 0; side < 3; side++) {
      const from = keyOf(indices[offset + side]);
      const to = keyOf(indices[offset + (side + 1) % 3]);
      if (from === to) continue;
      const edge = from < to ? `${from}|${to}` : `${to}|${from}`;
      uses.set(edge, (uses.get(edge) ?? 0) + 1);
    }
  }
  return [...uses.values()].filter(count => count !== 2).length;
}

const wire = { radius: 0.01, radialSegments: 4 };

test('an arc primitive lies on its circle and ends where the sweep ends', () => {
  const spline = shapeToSpline({ type: 'arc', radius: 2, startAngle: 0, sweep: Math.PI, segments: 4 });
  const { points } = sampleSpline({ ...spline, points: spline.points }, 16);
  for (const point of points) assert.ok(Math.abs(Math.hypot(point[0], point[1]) - 2) < 1e-5, `off the circle: ${point}`);
  assert.deepEqual(points[0].map(Math.abs).map(value => Math.round(value * 1e6)), [2e6, 0, 0]);
  assert.ok(Math.abs(points.at(-1)[0] + 2) < 1e-9 && Math.abs(points.at(-1)[1]) < 1e-9);
  assert.equal(spline.closed, false);
  assert.equal(shapeToSpline({ type: 'arc', sweep: Math.PI * 2 }).closed, true, 'a full turn closes');
});

test('a spiral rises and widens, and a spiral staircase rail is a watertight swept tube', () => {
  const rail = curveSet([{ shape: { type: 'spiral', rotations: 1.5, startRadius: 1, endRadius: 1, height: 3, pointsPerRotation: 24 } }], { radius: 0.03, radialSegments: 6 });
  const { minimum, maximum } = bounds(rail);
  assert.ok(Math.abs(minimum[1]) < 0.06 || Math.abs(minimum[2]) < 0.06);
  assert.ok(Math.abs(maximum[2] - 3) < 0.04, `rail top at ${maximum[2]}`);
  assert.ok(maximum[0] <= 1.04 && minimum[0] >= -1.04);
  assert.equal(openEdges(rail), 0);
  const cone = shapeToSpline({ type: 'spiral', rotations: 2, startRadius: 0.5, endRadius: 2, height: 0, pointsPerRotation: 8 });
  assert.equal(cone.points.length, 17);
  assert.ok(Math.abs(Math.hypot(...cone.points.at(-1).slice(0, 2)) - 2) < 1e-9);
  const reversed = shapeToSpline({ type: 'spiral', rotations: 0.25, reverse: true, height: 0, pointsPerRotation: 4 });
  assert.ok(reversed.points[1][1] < 0, 'reverse turns clockwise');
});

test('a star alternates outer and inner radius and is a closed poly spline', () => {
  const star = shapeToSpline({ type: 'star', points: 5, innerRadius: 0.4, outerRadius: 1, innerTwist: 0 });
  assert.equal(star.type, 'poly');
  assert.equal(star.closed, true);
  assert.equal(star.points.length, 10);
  star.points.forEach((point, index) => assert.ok(Math.abs(Math.hypot(point[0], point[1]) - (index % 2 ? 0.4 : 1)) < 1e-9));
  assert.equal(openEdges(curveSet([{ shape: { type: 'star' } }], wire)), 0);
});

test('trim by factor keeps a prefix of the curve, and by length matches', () => {
  const full = [[0, 0, 0], [4, 0, 0]];
  const half = curve(full, { ...wire, trim: { end: 0.5 } });
  assert.ok(Math.abs(bounds(half).maximum[0] - 2) < 1e-6);
  assert.equal(openEdges(half), 0, 'a trimmed curve is capped');
  const byLength = curve(full, { ...wire, trim: { start: 1, end: 3, length: true } });
  const { minimum, maximum } = bounds(byLength);
  assert.ok(Math.abs(minimum[0] - 1) < 1e-6 && Math.abs(maximum[0] - 3) < 1e-6);
  const clamped = curve(full, { ...wire, trim: { start: 1, end: 99, length: true } });
  assert.ok(Math.abs(bounds(clamped).maximum[0] - 4) < 1e-6, 'a length past the end stops at the end');
  const whole = curve(full, { ...wire, trim: { start: 0, end: 1 } });
  assert.equal(hashOf(whole), hashOf(curve(full, wire)), 'the full range changes nothing on an open curve');
});

test('trimming a closed curve opens it', () => {
  const ring = { shape: { type: 'arc', sweep: Math.PI * 2, segments: 8 } };
  const closed = curveSet([ring], wire);
  const quarter = curveSet([{ ...ring, trim: { end: 0.25 } }], wire);
  assert.equal(openEdges(closed), 0);
  assert.equal(openEdges(quarter), 0);
  const { minimum, maximum } = bounds(quarter);
  assert.ok(minimum[0] > -0.02 && minimum[1] > -0.02, 'a quarter turn stays in the first quadrant');
  assert.ok(Math.abs(maximum[0] - 1) < 0.02 && Math.abs(maximum[1] - 1) < 0.02);
});

test('a growing vine: each growth step extends the previous trim with the same start', () => {
  const vine = [[0, 0, 0], [1, 1, 0], [2, 0, 1], [3, 1, 1], [4, 0, 0]];
  const reach = growth => bounds(curve(vine, { ...wire, resolution: 8, trim: { end: growth } })).maximum[0];
  const fractions = [0.1, 0.25, 0.5, 0.75, 1];
  const reaches = fractions.map(reach);
  for (let index = 1; index < reaches.length; index++) assert.ok(reaches[index] > reaches[index - 1], `step ${index} grows`);
  const sampled = sampleSpline({ type: 'bezier', closed: false, points: vine.map(position => ({ position })) }, 8);
  const prefix = trimSamples(sampled, false, { end: 0.5 });
  assert.deepEqual(prefix.points[0], sampled.points[0]);
  const lastKept = prefix.points.at(-2);
  assert.ok(sampled.points.some(point => point.every((value, axis) => value === lastKept[axis])), 'interior samples are untouched');
});

test('a spline set merges its splines into one mesh with indices offset', () => {
  const first = curve([[0, 0, 0], [1, 0, 0]], wire);
  const second = curveSet([{ shape: { type: 'star' } }], wire);
  const both = curveSet([{ points: [[0, 0, 0], [1, 0, 0]] }, { shape: { type: 'star' } }], wire);
  assert.equal(both.positions.length, first.positions.length + second.positions.length);
  assert.equal(both.indices.length, first.indices.length + second.indices.length);
  assert.deepEqual(Array.from(both.positions.subarray(0, first.positions.length)), Array.from(first.positions));
  assert.equal(Math.max(...both.indices), both.positions.length / 3 - 1);
  assert.equal(openEdges(both), 0);
});

test('a poly spline keeps its corners and a NURBS spline passes through its ends', () => {
  const corner = [[0, 0, 0], [1, 0, 0], [1, 1, 0]];
  const poly = curve(corner, { ...wire, kind: 'poly' });
  assert.ok(Math.abs(bounds(poly).maximum[0] - 1.01) < 1e-6, 'the corner is not rounded off');
  const nurbs = sampleNurbs(corner, [1, 1, 1], false, 8);
  assert.deepEqual(nurbs.points[0], corner[0]);
  assert.ok(nurbs.points.at(-1).every((value, axis) => Math.abs(value - corner[2][axis]) < 1e-12));
  const pulled = sampleNurbs(corner, [1, 8, 1], false, 8);
  const middle = point => Math.hypot(point[0] - 1, point[1] - 0);
  assert.ok(Math.min(...pulled.points.map(middle)) < Math.min(...nurbs.points.map(middle)), 'a higher weight pulls the curve to its point');
  const ring = sampleNurbs([[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]], [1, 1, 1, 1], true, 6);
  assert.equal(ring.points.length, 24);
  assert.equal(openEdges(curve([[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]], { ...wire, kind: 'nurbs', closed: true })), 0);
});

test('curve output is deterministic and matches the recorded geometry', () => {
  const build = () => curveSet([
    { shape: { type: 'spiral', rotations: 1, height: 1 }, trim: { start: 0.1, end: 0.9 } },
    { points: [[0, 0, 0], [1, 1, 0], [2, 0, 1], [3, 1, 1]], kind: 'nurbs', weights: [1, 2, 1, 1] },
    { shape: { type: 'star', points: 6 } },
  ], { radius: 0.02, radialSegments: 5, taper: [1, 0.5] });
  assert.equal(hashOf(build()), hashOf(build()));
  assert.equal(hashOf(build()), '066f5ace79bc38d147707b116d1488465cc729d4effa8a17ce10ae9a1f31289b');
});

test('curve rejects bad splines with the field and what to pass', () => {
  const line = [[0, 0, 0], [1, 0, 0]];
  const cases = [
    [() => curve(line, { trim: { start: 0.6, end: 0.4 } }), /trim\.end must be greater than points\.trim\.start|trim\.end must be greater/],
    [() => curve(line, { trim: { end: 2 } }), /trim\.start and .*trim\.end must be from 0 to 1/],
    [() => curve(line, { trim: { bogus: 1 } }), /Unknown .*trim field: bogus/],
    [() => curve(line, { kind: 'spiral' }), /kind must be one of bezier, poly, nurbs/],
    [() => curve(line, { weights: [1, 1] }), /weights apply to kind nurbs only/],
    [() => curve(line, { kind: 'nurbs', weights: [1] }), /needs one weight per point \(2\)/],
    [() => curve(line, { kind: 'nurbs', weights: [1, 0] }), /greater than 0/],
    [() => curveSet([], {}), /splines needs 1 to 64 entries/],
    [() => curveSet(Array.from({ length: 65 }, () => ({ points: line })), {}), /splines needs 1 to 64 entries/],
    [() => curveSet([{ points: line, shape: { type: 'star' } }], {}), /exactly one of points or shape/],
    [() => curveSet([{ shape: { type: 'star' }, closed: true }], {}), /closed and .*kind come from shape/],
    [() => curveSet([{ shape: { type: 'wave' } }], {}), /shape\.type must be one of arc, spiral, star/],
    [() => curveSet([{ shape: { type: 'star', points: 2 } }], {}), /shape\.points must be an integer from 3 to 256/],
    [() => curveSet([{ shape: { type: 'arc', sweep: 0 } }], {}), /shape\.sweep must not be 0/],
    [() => curveSet([{ shape: { type: 'spiral', rotations: 64, pointsPerRotation: 128 } }], {}), /at most 1024 points/],
    [() => curveSet([{ shape: { type: 'star', spikes: 3 } }], {}), /Unknown shape field: spikes/],
    [() => curveSet([{ points: line }, { points: [line[0]] }], {}), /splines\[1\]\.points needs 2 to 1024 entries/],
    [() => curveSet(Array.from({ length: 5 }, () => ({ points: Array.from({ length: 1000 }, (_, index) => [index, 0, 0]) })), {}), /at most 4096/],
    [() => curveSet([{ shape: { type: 'star', points: 256 } }], { maxVertices: 100 }), /exceeding maxVertices 100/],
  ];
  for (const [attempt, pattern] of cases) assert.throws(attempt, pattern);
});

test('a recipe curve geometry takes a shape, splines, kind and trim, and rejects mixing them', () => {
  const recipe = geometry => ({
    format: '67js.scene',
    schemaVersion: 1,
    materials: [{ id: 'metal', color: [0.6, 0.6, 0.65], metallic: 1, roughness: 0.3 }],
    geometries: [{ id: 'g', type: 'curve', ...geometry }],
    nodes: [{ id: 'n', geometry: 'g', material: 'metal' }],
  });
  const star = createAgentScene(recipe({ shape: { type: 'star' }, radius: 0.02 }));
  assert.ok(star.parts[0].geometry.indices.length > 0);
  const several = createAgentScene(recipe({ splines: [{ points: [[0, 0, 0], [1, 0, 0]], trim: { end: 0.5 } }, { shape: { type: 'arc' } }], radius: 0.02 }));
  assert.ok(several.parts[0].geometry.indices.length > 0);
  assert.throws(() => createAgentScene(recipe({ points: [[0, 0, 0], [1, 0, 0]], splines: [{ shape: { type: 'star' } }] })), /cannot be used with splines/);
  assert.throws(() => createAgentScene(recipe({ shape: { type: 'star', points: 1 } })), /shape\.points/);
  assert.throws(() => createAgentScene(recipe({ shape: { type: 'star' }, trim: { end: 3 } })), /trim/);
});

function vineRecipe(grow = { name: 'vine', steps: 8 }, keyframes = [{ time: 0, value: 0 }, { time: 1, value: 1 }]) {
  return {
    format: '67js.scene',
    schemaVersion: 1,
    materials: [{ id: 'leaf', color: [0.2, 0.6, 0.2] }],
    geometries: [{ id: 'vine', type: 'curve', points: [[0, 0, 0], [2, 0, 0], [4, 1, 0], [6, 1, 0]], kind: 'poly', radius: 0.02, radialSegments: 4, grow }],
    nodes: [{ id: 'vine', geometry: 'vine', material: 'leaf' }],
    motion: { duration: 1, tracks: [{ kind: 'morph', id: 'vine', property: 'weight', keyframes }] },
  };
}

function still(grow) {
  const { motion, ...recipe } = vineRecipe(grow);
  return recipe;
}

// The renderer adds weight times offset to every vertex; this does the same on the CPU.
function blendedPositions(part) {
  const blended = Float32Array.from(part.geometry.positions);
  part.geometry.morphTargets.forEach((target, index) => {
    for (let component = 0; component < blended.length; component++) blended[component] += part.morph.weights[index] * target.positions[component];
  });
  return blended;
}

test('a growing vine reaches further along its curve as the grow track plays, and seeking equals playing', () => {
  const scene = createAgentScene(vineRecipe());
  const [part] = scene.parts;
  const reach = () => bounds({ positions: blendedPositions(part) }).maximum[0];
  const played = [0, 0.25, 0.5, 0.75, 1].map(time => {
    scene.sampleMotion(time);
    return reach();
  });
  played.reduce((previous, current) => {
    assert.ok(current > previous, `the vine grew from ${previous} to ${current}`);
    return current;
  });
  assert.ok(played[0] < 0.3, `a bare root at the start (${played[0]})`);
  const whole = curve([[0, 0, 0], [2, 0, 0], [4, 1, 0], [6, 1, 0]], { kind: 'poly', radius: 0.02, radialSegments: 4 });
  assert.ok(Math.abs(bounds(whole).maximum[0] - played.at(-1)) < 0.02, `the whole curve at the end (${played.at(-1)})`);
  scene.sampleMotion(1);
  scene.sampleMotion(0.5);
  const sought = reach();
  const fresh = createAgentScene(vineRecipe());
  fresh.sampleMotion(0.5);
  assert.equal(sought, bounds({ positions: blendedPositions(fresh.parts[0]) }).maximum[0], 'seeking equals a fresh sample');
  assert.equal(sought, played[2]);
});

test('a growing vine without a track shows the curve grown to grow.value, and the targets are deterministic', () => {
  const grown = createAgentScene(still({ name: 'vine', steps: 4 }));
  const [part] = grown.parts;
  assert.deepEqual(part.geometry.morphTargetNames, ['vine#1', 'vine#2', 'vine#3', 'vine#4']);
  assert.deepEqual(Array.from(part.morph.weights), [0, 0, 0, 1]);
  const half = createAgentScene(still({ name: 'vine', steps: 4, value: 0.5 }));
  assert.deepEqual(Array.from(half.parts[0].morph.weights), [0, 1, 0, 0]);
  const again = createAgentScene(still({ name: 'vine', steps: 4 }));
  assert.deepEqual(part.geometry.morphTargets[2].positions, again.parts[0].geometry.morphTargets[2].positions);
});

test('grow rejects bad fields with what to pass', () => {
  for (const [grow, pattern] of [
    [{ steps: 4 }, /grow\.name/],
    [{ name: 'vine', steps: 1 }, /grow\.steps/],
    [{ name: 'vine', steps: 99 }, /grow\.steps/],
    [{ name: 'vine', value: 2 }, /grow\.value/],
    [{ name: 'vine', bogus: 1 }, /Unknown grow field: bogus/],
  ]) assert.throws(() => createAgentScene(still(grow)), pattern);
});
