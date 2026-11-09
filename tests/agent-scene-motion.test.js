import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';

function recipe() {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'finish', color: [0.2, 0.4, 0.6], emission: 0 }],
    nodes: [
      { id: 'hinge', translation: [3, 0, 0] },
      { id: 'arm', parent: 'hinge', geometry: 'box', material: 'finish', translation: [1, 2, 0] },
    ],
    camera: { eye: [4, 3, 5], target: [0, 0, 0] },
    motion: {
      duration: 1,
      tracks: [
        { kind: 'node', id: 'hinge', property: 'rotation', keyframes: [
          { time: 0, value: [0, 0, 0, 1] }, { time: 1, value: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
        ] },
        { kind: 'material', id: 'finish', property: 'emission', keyframes: [
          { time: 0, value: 0 }, { time: 1, value: 2 },
        ] },
        { kind: 'camera', property: 'eye', keyframes: [
          { time: 0, value: [4, 3, 5] }, { time: 1, value: [5, 3, 5] },
        ] },
      ],
    },
  };
}

function pose(scene) {
  return { matrices: scene.parts.map(part => Array.from(part.matrix)), camera: scene.camera,
    materials: scene.parts.map(part => structuredClone(part.material)), time: scene.motionTime };
}

test('motion samples local joints with retained resources and exact shuffled seeks', () => {
  const scene = createAgentScene(recipe());
  const canonical = scene.exportRecipe();
  const authoredBounds = scene.inspect({ includeBounds: true });
  const parts = scene.parts;
  const geometry = parts[0].geometry;
  const matrix = parts[0].matrix;
  const material = parts[0].material;
  const start = pose(scene);
  scene.sampleMotion(1);
  const end = pose(scene);
  assert.ok(Math.abs(matrix[12] - 1) < 1e-6);
  assert.ok(Math.abs(matrix[13] - 1) < 1e-6);
  assert.equal(material.emission, 2);
  assert.equal(scene.camera.eye[0], 5);
  for (const time of [0.71, 0.12, 1, 0.5, 0]) {
    scene.sampleMotion(time);
  }
  assert.deepEqual(pose(scene), start);
  scene.sampleMotion(1);
  assert.deepEqual(pose(scene), end);
  assert.equal(scene.parts, parts);
  assert.equal(scene.parts[0].geometry, geometry);
  assert.equal(scene.parts[0].matrix, matrix);
  assert.equal(scene.parts[0].material, material);
  assert.equal(scene.revision, 0);
  assert.equal(scene.topologyRevision, 0);
  assert.deepEqual(scene.exportRecipe(), canonical);
  assert.deepEqual(scene.inspect({ includeBounds: true }).nodes, authoredBounds.nodes);
  assert.equal(scene.inspect().boundsSpace, 'authored-base-world');
});

test('base reset, checkpoints and authored edits rebuild motion bindings without seek revisions', () => {
  const input = recipe();
  input.motion.tracks[0].keyframes[0].value = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  const scene = createAgentScene(input);
  const checkpoint = scene.checkpoint();
  const canonical = scene.exportRecipe();
  const parts = scene.parts;
  assert.ok(Math.abs(parts[0].matrix[12] - 1) < 1e-6);
  scene.sampleMotion(null);
  assert.equal(parts[0].matrix[12], 4);
  assert.equal(scene.motionTime, null);
  scene.sampleMotion(1);
  scene.apply([{ type: 'set-motion', motion: null }], { expectedRevision: 0 });
  assert.equal(parts[0].matrix[12], 4);
  assert.equal(scene.inspect().motion, null);
  assert.throws(() => scene.sampleMotion(0), /no motion/);
  scene.restore(checkpoint, { expectedRevision: 1 });
  assert.deepEqual(scene.exportRecipe(), canonical);
  assert.equal(scene.motionTime, 0);
  assert.equal(scene.revision, 2);
  assert.equal(scene.parts, parts);
  assert.equal(scene.topologyRevision, 0);
});

test('final batch reference validation prevents dangling tracks and permits atomic replacement', () => {
  const scene = createAgentScene(recipe());
  scene.sampleMotion(1);
  const before = pose(scene);
  const canonical = scene.exportRecipe();
  assert.throws(() => scene.apply([{ type: 'remove-node', id: 'hinge', recursive: true }], { expectedRevision: 0 }), /target/);
  assert.deepEqual(pose(scene), before);
  assert.deepEqual(scene.exportRecipe(), canonical);
  assert.throws(() => scene.apply([{ type: 'set-motion' }], { expectedRevision: 0 }), /motion: got undefined; expected a motion value, or null to clear it/);
  scene.apply([
    { type: 'remove-node', id: 'hinge', recursive: true },
    { type: 'remove-material', id: 'finish' },
    { type: 'set-motion', motion: null },
  ], { expectedRevision: 0 });
  assert.equal(scene.revision, 1);
  assert.equal(scene.parts.length, 0);
});

test('invalid cubic mid-pose rejects a whole seek without publishing other channels', () => {
  const input = recipe();
  input.motion.tracks.push({ kind: 'node', id: 'arm', property: 'scale', interpolation: 'CUBICSPLINE', keyframes: [
    { time: 0, value: [1, 1, 1], inTangent: [0, 0, 0], outTangent: [-16, 0, 0] },
    { time: 1, value: [1, 1, 1], inTangent: [16, 0, 0], outTangent: [0, 0, 0] },
  ] });
  const scene = createAgentScene(input);
  const before = pose(scene);
  assert.throws(() => scene.sampleMotion(0.5), /scale/);
  assert.deepEqual(pose(scene), before);
  assert.equal(scene.revision, 0);
  scene.sampleMotion(1);
  assert.equal(scene.parts[0].material.emission, 2);
  scene.sampleMotion(0);
  assert.deepEqual(pose(scene), before);
});

test('combined parent transforms and invalid camera crossings cannot publish valid sibling tracks', () => {
  for (const invalid of ['graph', 'camera']) {
    const input = recipe();
    if (invalid === 'graph') {
      for (const id of ['hinge', 'arm']) {
        input.motion.tracks.push({ kind: 'node', id, property: 'scale', keyframes: [
          { time: 0, value: [1, 1, 1] }, { time: 1, value: [1e20, 1e20, 1e20] },
        ] });
      }
    } else {
      input.motion.tracks[2].keyframes = [
        { time: 0, value: [4, 3, 5] }, { time: 1, value: [-4, -3, -5] },
      ];
    }
    const scene = createAgentScene(input);
    const before = pose(scene);
    assert.throws(() => scene.sampleMotion(invalid === 'graph' ? 1 : 0.5));
    assert.deepEqual(pose(scene), before);
    assert.equal(scene.revision, 0);
    scene.sampleMotion(0);
    assert.deepEqual(pose(scene), before);
  }
});

test('failed set-motion initial sampling is atomic across recipe, transforms and materials', () => {
  const scene = createAgentScene(recipe());
  scene.sampleMotion(1);
  const before = pose(scene);
  const canonical = scene.exportRecipe();
  const motion = { duration: 1, tracks: [{ kind: 'camera', property: 'eye', keyframes: [{ time: 0, value: [0, 0, 0] }] }] };
  assert.throws(() => scene.apply([
    { type: 'set-material', id: 'finish', color: [1, 0, 0] },
    { type: 'set-node', id: 'arm', translation: [10, 10, 10] },
    { type: 'set-motion', motion },
  ], { expectedRevision: 0 }));
  assert.deepEqual(pose(scene), before);
  assert.deepEqual(scene.exportRecipe(), canonical);
  assert.equal(scene.revision, 0);
});

test('motion loop is optional boolean and never accepts null as a hidden default', () => {
  const input = recipe();
  input.motion.loop = null;
  assert.throws(() => createAgentScene(input), /motion\.loop: got .*; expected true or false/);
});
