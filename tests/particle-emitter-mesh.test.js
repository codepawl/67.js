import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';

const WALL_CENTER = [0, 0, 5];
const WALL_SCALE = 2;
const TOLERANCE = 1e-4;

function recipe(system) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'speck', type: 'box', bevel: 0 },
      { id: 'cube', type: 'box', bevel: 0 },
      { id: 'ball', type: 'sphere', segments: 8, rings: 6 },
      { id: 'sheet', type: 'grid', segments: 1 },
      { id: 'spike', type: 'cone', radiusTop: 0, radiusBottom: 0.5, segments: 6 },
    ],
    materials: [{ id: 'paint' }],
    nodes: [
      { id: 'sparks', geometry: 'speck', material: 'paint' },
      { id: 'wall', geometry: 'cube', material: 'paint', translation: WALL_CENTER, scale: [WALL_SCALE, WALL_SCALE, WALL_SCALE] },
      { id: 'leaf', geometry: 'sheet', material: 'paint' },
      { id: 'pebble', geometry: 'ball', material: 'paint' },
      { id: 'thorn', geometry: 'spike', material: 'paint' },
    ],
    particles: { gravity: [0, 0, 0], systems: [{ node: 'sparks', seed: 5, count: 80, speed: 0, spread: 0, size: 0.001, lifetime: 5, ...system }] },
  };
}

function sparksGeometry(scene) {
  return scene.parts.find(part => part.name === 'sparks').geometry;
}

// Each particle is a tiny box centred on its position; the mean of its vertices is that position.
function particleCentres(geometry, verticesPerParticle) {
  const centres = [];
  for (let first = 0; first < geometry.positions.length / 3; first += verticesPerParticle) {
    const centre = [0, 0, 0];
    for (let vertex = first; vertex < first + verticesPerParticle; vertex++) {
      for (let axis = 0; axis < 3; axis++) centre[axis] += geometry.positions[vertex * 3 + axis] / verticesPerParticle;
    }
    centres.push(centre);
  }
  return centres;
}

// How far a point is outside the wall cube (0 on its surface, negative inside).
function distanceBeyondWall(point) {
  return Math.max(...point.map((value, axis) => Math.abs(value - WALL_CENTER[axis]) - WALL_SCALE * 0.5));
}

function emittedCentres(emitter, extraSystem = {}, time = 0) {
  const scene = createAgentScene(recipe({ emitter: { shape: 'mesh', mesh: 'wall', ...emitter }, ...extraSystem }));
  scene.sampleMotion(time);
  return particleCentres(sparksGeometry(scene), 24);
}

test('surface points lie on the mesh and cover every face', () => {
  const centres = emittedCentres({ from: 'surface' });
  assert.equal(centres.length, 80);
  const facesHit = new Set();
  for (const centre of centres) {
    assert.ok(Math.abs(distanceBeyondWall(centre)) < TOLERANCE, `point ${centre} is off the surface`);
    const axis = [0, 1, 2].reduce((best, candidate) => Math.abs(centre[candidate] - WALL_CENTER[candidate]) > Math.abs(centre[best] - WALL_CENTER[best]) ? candidate : best);
    facesHit.add(`${axis}${Math.sign(centre[axis] - WALL_CENTER[axis])}`);
  }
  assert.equal(facesHit.size, 6, 'equal areas reach all six faces');
});

test('volume points lie inside the mesh', () => {
  const centres = emittedCentres({ from: 'volume' });
  for (const centre of centres) {
    assert.ok(distanceBeyondWall(centre) < -TOLERANCE, `point ${centre} is not inside`);
  }
});

test('vertex points sit on the mesh corners', () => {
  const centres = emittedCentres({ from: 'vertices' });
  for (const centre of centres) {
    const offsets = centre.map((value, axis) => Math.abs(value - WALL_CENTER[axis]));
    for (const offset of offsets) assert.ok(Math.abs(offset - WALL_SCALE * 0.5) < TOLERANCE, `point ${centre} is not a corner`);
  }
});

test('normalSpeed sends surface points straight out along the face normal', () => {
  const centres = emittedCentres({ from: 'surface', normalSpeed: 3 }, {}, 0.5);
  for (const centre of centres) {
    assert.ok(Math.abs(distanceBeyondWall(centre) - 1.5) < 1e-3, `point ${centre} is not 1.5 m from the surface`);
  }
});

test('the same seed gives identical bytes, another seed gives other points, and more particles keep the earlier ones', () => {
  const bytesOf = system => {
    const scene = createAgentScene(recipe({ emitter: { shape: 'mesh', mesh: 'wall', from: 'volume' }, ...system }));
    scene.sampleMotion(0);
    const geometry = sparksGeometry(scene);
    return Buffer.from(geometry.positions.buffer, geometry.positions.byteOffset, geometry.positions.byteLength);
  };
  assert.ok(bytesOf({}).equals(bytesOf({})));
  assert.ok(!bytesOf({}).equals(bytesOf({ seed: 6 })));
  const small = emittedCentres({ from: 'surface' }, { count: 10 });
  const large = emittedCentres({ from: 'surface' }, { count: 40 });
  assert.deepEqual(large.slice(0, 10), small);
});

test('each particle draws one of the listed instance meshes, the same on every run', () => {
  const instanced = recipe({ emitter: { shape: 'mesh', mesh: 'wall' }, instances: ['sparks', 'leaf', 'pebble'], count: 60, size: 0.1 });
  const scene = createAgentScene(instanced);
  scene.sampleMotion(0);
  const counts = ['sparks', 'leaf', 'pebble'].map(name => scene.parts.find(part => part.name === name).geometry.positions.length / 3);
  const drawn = sparksGeometry(scene).positions.length / 3;
  assert.ok(drawn > 60 * Math.min(...counts) && drawn < 60 * Math.max(...counts), `${drawn} vertices is a mix of ${counts}`);
  const again = createAgentScene(instanced);
  again.sampleMotion(0);
  assert.deepEqual(Array.from(sparksGeometry(again).positions), Array.from(sparksGeometry(scene).positions));
});

test('orient normal turns the instance up axis onto the surface normal', () => {
  const scene = createAgentScene(recipe({ emitter: { shape: 'mesh', mesh: 'wall' }, instances: ['thorn'], orient: 'normal', count: 30, size: 0.1 }));
  scene.sampleMotion(0);
  const geometry = sparksGeometry(scene);
  const template = scene.parts.find(part => part.name === 'thorn').geometry.positions;
  const verticesPerParticle = template.length / 3;
  let top = 0;
  for (let vertex = 0; vertex < verticesPerParticle; vertex++) {
    if (template[vertex * 3 + 1] > template[top * 3 + 1]) top = vertex;
  }
  // The centre of the cone base lies on its axis, like the tip.
  const baseCentreVertex = [...Array(verticesPerParticle).keys()].find(vertex => template[vertex * 3 + 1] < 0 && template[vertex * 3] === 0 && template[vertex * 3 + 2] === 0);
  let checked = 0;
  for (let index = 0; index < 30; index++) {
    const base = index * verticesPerParticle;
    const baseCentre = [0, 1, 2].map(axis => geometry.positions[(base + baseCentreVertex) * 3 + axis]);
    const upAxis = [0, 1, 2].map(axis => geometry.positions[(base + top) * 3 + axis] - baseCentre[axis]);
    const up = upAxis.map(component => component / Math.hypot(...upAxis));
    // The tip is on the cone's up axis, so stepping back from it gives the point the cone grew from.
    const origin = [0, 1, 2].map(axis => geometry.positions[(base + top) * 3 + axis] - up[axis] * template[top * 3 + 1] * 0.1);
    const faceNormal = [0, 1, 2].map(axis => Math.abs(Math.abs(origin[axis] - WALL_CENTER[axis]) - WALL_SCALE * 0.5) < TOLERANCE ? Math.sign(origin[axis] - WALL_CENTER[axis]) : 0);
    if (Math.hypot(...faceNormal) !== 1) continue;
    const dot = up[0] * faceNormal[0] + up[1] * faceNormal[1] + up[2] * faceNormal[2];
    assert.ok(dot > 0.999, `thorn ${index} does not point along its surface normal (${dot})`);
    checked++;
  }
  assert.ok(checked > 20, 'most points sit inside a face, not on an edge');
});

test('bad emitter input names the field and what to pass', () => {
  const failure = (system, pattern) => assert.throws(() => createAgentScene(recipe(system)), pattern);
  failure({ emitter: { shape: 'mesh' } }, /particles\.systems\[0\]\.emitter\.mesh[\s\S]*ID of a node/);
  failure({ emitter: { shape: 'mesh', mesh: 'wall', from: 'inside' } }, /emitter\.from[\s\S]*surface, vertices, edges, volume/);
  failure({ emitter: { shape: 'point', mesh: 'wall' } }, /emitter\.mesh[\s\S]*shape is "mesh"/);
  failure({ emitter: { shape: 'mesh', mesh: 'wall', from: 'volume', normalSpeed: 1 } }, /normalSpeed[\s\S]*volume/);
  failure({ emitter: { shape: 'point' }, orient: 'normal' }, /orient[\s\S]*"mesh"/);
  failure({ emitter: { shape: 'mesh', mesh: 'wall' }, orient: 'sideways' }, /orient[\s\S]*none, random, normal/);
  failure({ instances: [] }, /instances[\s\S]*at least one node ID/);
  failure({ instances: ['missing'] }, /instances\[0\][\s\S]*ID of a node/);
  failure({ instances: Array(9).fill('leaf') }, /instances/);
  failure({ emitter: { shape: 'mesh', mesh: 'leaf', from: 'volume' } }, /closed mesh/);
});

// A wall whose top row of vertices is painted into the vertex group "rim".
function rimWallRecipe(system) {
  const base = recipe(system);
  base.geometries.push({
    id: 'rimmed', type: 'mesh', base: { type: 'box', bevel: 0 },
    edits: [{ op: 'vertex_group', name: 'rim', select: { tag: 'top' }, weight: 1 }],
  });
  base.nodes.push({ id: 'rimwall', geometry: 'rimmed', material: 'paint', translation: WALL_CENTER, scale: [WALL_SCALE, WALL_SCALE, WALL_SCALE] });
  return base;
}

function rimCentres(system) {
  const scene = createAgentScene(rimWallRecipe(system));
  scene.sampleMotion(0);
  return particleCentres(sparksGeometry(scene), 24);
}

test('a vertex group keeps sparks on the painted rim, from vertices and from the surface', () => {
  const topHeight = WALL_CENTER[1] + WALL_SCALE * 0.5;
  const fromVertices = rimCentres({ emitter: { shape: 'mesh', mesh: 'rimwall', from: 'vertices', group: 'rim' } });
  assert.equal(fromVertices.length, 80);
  for (const centre of fromVertices) assert.ok(Math.abs(centre[1] - topHeight) < TOLERANCE, `y ${centre[1]}`);
  // Surface triangles weigh area times the mean group weight: the unpainted bottom face gets none and the top face the most.
  const bottomHeight = WALL_CENTER[1] - WALL_SCALE * 0.5;
  const onTop = centres => centres.filter(centre => Math.abs(centre[1] - topHeight) < TOLERANCE).length;
  const fromSurface = rimCentres({ emitter: { shape: 'mesh', mesh: 'rimwall', group: 'rim' }, count: 400 });
  const ungrouped = rimCentres({ emitter: { shape: 'mesh', mesh: 'rimwall' }, count: 400 });
  assert.ok(fromSurface.every(centre => centre[1] > bottomHeight + TOLERANCE), 'no spark on the unpainted bottom face');
  assert.ok(onTop(fromSurface) > onTop(ungrouped) * 1.8, `${onTop(fromSurface)} on top against ${onTop(ungrouped)} without a group`);
});

test('sparks from a group and leaves picked from 3 meshes work in one scene, with the same bytes each run', () => {
  const build = () => {
    const scene = createAgentScene(rimWallRecipe({ emitter: { shape: 'mesh', mesh: 'rimwall', group: 'rim' }, instances: ['sparks', 'leaf', 'thorn'], count: 40, size: 0.1 }));
    scene.sampleMotion(0.5);
    return Array.from(sparksGeometry(scene).positions);
  };
  assert.deepEqual(build(), build());
});

test('a vertex group that is missing, nameless or aimed at a volume names the field and what to pass', () => {
  const failure = (emitter, pattern) => assert.throws(() => createAgentScene(rimWallRecipe({ emitter: { shape: 'mesh', mesh: 'rimwall', ...emitter } })), pattern);
  failure({ group: 'hem' }, /emitter\.group[\s\S]*known groups: rim/);
  failure({ group: '' }, /emitter\.group[\s\S]*name of a vertex group/);
  failure({ group: 'rim', from: 'volume' }, /emitter\.group[\s\S]*"surface", "vertices" or "edges"/);
});

// A beam 4 long and 1 by 1 across: its 12 edges are four of length 4 and eight of length 1.
const BEAM_LENGTH = 4;

function beamCentres(emitter, extraSystem = {}) {
  const base = recipe({ emitter: { shape: 'mesh', mesh: 'beam', ...emitter }, ...extraSystem });
  base.nodes.push({ id: 'beam', geometry: 'cube', material: 'paint', translation: WALL_CENTER, scale: [BEAM_LENGTH, 1, 1] });
  const scene = createAgentScene(base);
  scene.sampleMotion(0);
  return particleCentres(sparksGeometry(scene), 24);
}

// How many of the three axes a point sits at the outer face of the beam on (2 means it lies on an edge).
function extremeAxes(point) {
  const halfSizes = [BEAM_LENGTH / 2, 0.5, 0.5];
  return point.filter((value, axis) => Math.abs(Math.abs(value - WALL_CENTER[axis]) - halfSizes[axis]) < TOLERANCE).length;
}

test('sharp edge points lie on the cube edges and split by edge length', () => {
  const centres = beamCentres({ from: 'edges', sharpAngle: 30 }, { count: 2000 });
  assert.equal(centres.length, 2000);
  for (const centre of centres) assert.ok(extremeAxes(centre) >= 2, `point ${centre} is off every beam edge`);
  // Edges along x are 16 of the 24 units of edge length.
  const alongLength = centres.filter(centre => Math.abs(centre[1] - WALL_CENTER[1]) > 0.49 && Math.abs(centre[2] - WALL_CENTER[2]) > 0.49).length;
  assert.ok(Math.abs(alongLength / centres.length - 16 / 24) < 0.04, `${alongLength} of ${centres.length} on the long edges`);
});

test('without a sharp angle the flat diagonals take edges too, and an angle nothing exceeds leaves no edge', () => {
  const offEdge = centres => centres.filter(centre => extremeAxes(centre) < 2).length;
  assert.ok(offEdge(beamCentres({ from: 'edges' }, { count: 400 })) > 0, 'face diagonals are edges of the triangles');
  assert.throws(() => beamCentres({ from: 'edges', sharpAngle: 180 }), /emitter\.mesh[\s\S]*edge/);
});

test('an edge group keeps sparks on the painted rim, and sharp edges narrow it further', () => {
  const topHeight = WALL_CENTER[1] + WALL_SCALE * 0.5;
  const grouped = rimCentres({ emitter: { shape: 'mesh', mesh: 'rimwall', from: 'edges', group: 'rim' }, count: 300 });
  for (const centre of grouped) assert.ok(Math.abs(centre[1] - topHeight) < TOLERANCE, `y ${centre[1]}`);
  const rim = rimCentres({ emitter: { shape: 'mesh', mesh: 'rimwall', from: 'edges', group: 'rim', sharpAngle: 30 }, count: 300 });
  for (const centre of rim) {
    assert.ok(Math.abs(centre[1] - topHeight) < TOLERANCE);
    const distances = [0, 2].map(axis => Math.abs(Math.abs(centre[axis] - WALL_CENTER[axis]) - WALL_SCALE * 0.5));
    assert.ok(Math.min(...distances) < TOLERANCE, `point ${centre} is inside the top face, off the rim`);
  }
});

test('edge points repeat on every run and change with the seed', () => {
  const emitter = { from: 'edges', sharpAngle: 30 };
  const first = beamCentres(emitter, { count: 50 });
  assert.deepEqual(first, beamCentres(emitter, { count: 50 }));
  assert.notDeepEqual(first, beamCentres(emitter, { count: 50, seed: 6 }));
});

test('sparks from an edge group and leaves picked from 3 meshes work in one scene, with the same bytes each run', () => {
  const build = () => {
    const scene = createAgentScene(rimWallRecipe({ emitter: { shape: 'mesh', mesh: 'rimwall', from: 'edges', group: 'rim', sharpAngle: 30, normalSpeed: 1 }, instances: ['sparks', 'leaf', 'thorn'], orient: 'normal', count: 40, size: 0.1 }));
    scene.sampleMotion(0.5);
    return Array.from(sparksGeometry(scene).positions);
  };
  assert.deepEqual(build(), build());
});

test('a sharp angle off edges or out of range names the field and what to pass', () => {
  const failure = (emitter, pattern) => assert.throws(() => createAgentScene(recipe({ emitter: { shape: 'mesh', mesh: 'wall', ...emitter } })), pattern);
  failure({ from: 'surface', sharpAngle: 30 }, /emitter\.sharpAngle[\s\S]*"edges"/);
  failure({ from: 'edges', sharpAngle: 200 }, /emitter\.sharpAngle[\s\S]*180/);
  failure({ from: 'edges', sharpAngle: 'sharp' }, /emitter\.sharpAngle/);
});
