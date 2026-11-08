import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { exportGlb } from '../src/export.js';

function faceRecipe(extra = {}) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{
      id: 'face', type: 'mesh', base: { type: 'box', bevel: 0, subdivisions: 2 },
      shapeKeys: [
        { name: 'lift', offsets: [{ select: { tag: 'top' }, offset: [0, 0.5, 0] }] },
        { name: 'widen', edits: [{ op: 'set_position', offset: { vec: [{ mul: [{ attr: 'position', component: 'x' }, 0.5] }, 0, 0] } }] },
      ],
    }],
    materials: [{ id: 'skin' }],
    nodes: [{ id: 'head', geometry: 'face', material: 'skin' }],
    motion: {
      duration: 2,
      tracks: [
        { kind: 'morph', id: 'lift', property: 'weight', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1 }] },
        { kind: 'morph', id: 'widen', property: 'weight', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 0.5 }] },
      ],
    },
    ...extra,
  };
}

// The renderer adds weight times offset to every vertex; this does the same on the CPU.
function blendedPositions(part) {
  const { positions, morphTargets } = part.geometry;
  const blended = Float32Array.from(positions);
  morphTargets.forEach((target, index) => {
    for (let component = 0; component < blended.length; component++) blended[component] += part.morph.weights[index] * target.positions[component];
  });
  return blended;
}

function highestY(positions) {
  let highest = -Infinity;
  for (let index = 1; index < positions.length; index += 3) highest = Math.max(highest, positions[index]);
  return highest;
}

function widestX(positions) {
  let widest = -Infinity;
  for (let index = 0; index < positions.length; index += 3) widest = Math.max(widest, positions[index]);
  return widest;
}

test('a recipe mesh carries named shape keys as morph targets with offsets only where the key moves vertices', () => {
  const scene = createAgentScene(faceRecipe());
  const [part] = scene.parts;
  assert.deepEqual(part.geometry.morphTargetNames, ['lift', 'widen']);
  assert.equal(part.geometry.morphTargets.length, 2);
  assert.deepEqual(Array.from(part.morph.weights), [0, 0]);
  const lift = part.geometry.morphTargets[0].positions;
  const base = part.geometry.positions;
  for (let vertex = 0; vertex < base.length / 3; vertex++) {
    const onTop = Math.abs(base[vertex * 3 + 1] - 0.5) < 1e-6;
    assert.ok(Math.abs(lift[vertex * 3 + 1] - (onTop ? 0.5 : 0)) < 1e-6, `vertex ${vertex}`);
  }
});

test('morph tracks blend two shape keys of a recipe mesh', () => {
  const scene = createAgentScene(faceRecipe());
  const [part] = scene.parts;
  const rest = Float32Array.from(part.geometry.positions);
  scene.sampleMotion(0);
  assert.deepEqual(Array.from(part.morph.weights), [0, 0]);
  scene.sampleMotion(0.5);
  assert.deepEqual(Array.from(part.morph.weights), [0.5, 0.25]);
  const half = blendedPositions(part);
  assert.ok(Math.abs(highestY(half) - (highestY(rest) + 0.25)) < 1e-6, 'lift at half weight raises the top by 0.25');
  assert.ok(Math.abs(widestX(half) - widestX(rest) * (1 + 0.5 * 0.25)) < 1e-6, 'widen at quarter weight stretches x by 12.5 percent');
  scene.sampleMotion(1);
  assert.deepEqual(Array.from(part.morph.weights), [1, 0.5]);
  const full = blendedPositions(part);
  assert.ok(Math.abs(highestY(full) - (highestY(rest) + 0.5)) < 1e-6);
  assert.ok(Math.abs(widestX(full) - widestX(rest) * 1.25) < 1e-6);
});

test('shape keys that change the vertex count, repeat a name or sit on a missing track are refused', () => {
  const mesh = faceRecipe();
  const extruding = structuredClone(mesh);
  delete extruding.motion;
  extruding.geometries[0].shapeKeys = [{ name: 'grow', edits: [{ op: 'extrude_face_region', select: { tag: 'top' }, offset: 0.2 }] }];
  assert.throws(() => createAgentScene(extruding), /changed the mesh/);
  const repeated = structuredClone(mesh);
  repeated.geometries[0].shapeKeys[1].name = 'lift';
  assert.throws(() => createAgentScene(repeated), /used twice/);
  const both = structuredClone(mesh);
  both.geometries[0].shapeKeys[0].edits = [];
  assert.throws(() => createAgentScene(both), /exactly one of edits or offsets/);
  const unknownTrack = structuredClone(mesh);
  unknownTrack.motion.tracks[0].id = 'smile';
  assert.throws(() => createAgentScene(unknownTrack), /Motion target was not found: smile/);
});

test('the starting value of a key is the weight without motion, and a GLB export writes the morph targets', () => {
  const recipe = faceRecipe();
  delete recipe.motion;
  recipe.geometries[0].shapeKeys[0].value = 0.75;
  const scene = createAgentScene(recipe);
  const [part] = scene.parts;
  assert.deepEqual(Array.from(part.morph.weights), [0.75, 0]);
  const bytes = new Uint8Array(exportGlb(scene.parts));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const document = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true))));
  assert.equal(document.meshes[0].primitives[0].targets.length, 2);
  assert.ok(document.meshes[0].primitives[0].targets.every(target => target.POSITION !== undefined));
  assert.deepEqual(document.meshes[0].extras.targetNames, ['lift', 'widen']);
  assert.deepEqual(document.nodes.find(node => node.mesh === 0).weights, [0.75, 0]);
});
