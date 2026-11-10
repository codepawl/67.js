import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';

const WALL_CENTER = [0, 0, 5];
const WALL_SCALE = 2;
const TOLERANCE = 1e-4;

function recipe(system) {
  return {
    format: '67js.scene', schemaVersion: 1,
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
  failure({ emitter: { shape: 'mesh', mesh: 'wall', from: 'inside' } }, /emitter\.from[\s\S]*surface, vertices, volume/);
  failure({ emitter: { shape: 'point', mesh: 'wall' } }, /emitter\.mesh[\s\S]*shape is "mesh"/);
  failure({ emitter: { shape: 'mesh', mesh: 'wall', from: 'volume', normalSpeed: 1 } }, /normalSpeed[\s\S]*volume/);
  failure({ emitter: { shape: 'point' }, orient: 'normal' }, /orient[\s\S]*"mesh"/);
  failure({ emitter: { shape: 'mesh', mesh: 'wall' }, orient: 'sideways' }, /orient[\s\S]*none, random, normal/);
  failure({ instances: [] }, /instances[\s\S]*at least one node ID/);
  failure({ instances: ['missing'] }, /instances\[0\][\s\S]*ID of a node/);
  failure({ instances: Array(9).fill('leaf') }, /instances/);
  failure({ emitter: { shape: 'mesh', mesh: 'leaf', from: 'volume' } }, /closed mesh/);
});
