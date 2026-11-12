import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4, vec3 } from 'gl-matrix';
import { createAgentScene } from '../src/agent-scene.js';
import { bakeCloth } from '../src/cloth.js';
import { armatureNodes } from '../src/rig.js';
import { compileAgentMotion } from '../src/agent-motion.js';
import { CAPE, CAPE_THICKNESS, WALK_SECONDS, walkingCapeRecipe } from './support/walking-cape.mjs';

const FRAMES_PER_SECOND = 60;
const PENETRATION_TOLERANCE = 0.002;

// World matrices of the walker's nodes at a time (read from a scene still at its authored pose, so there is no second cloth bake), composed here from the motion sampler so the check does not lean on the cloth module's pose code.
function createPoser(scene) {
  const exported = scene.exportRecipe();
  const nodes = [...exported.armatures.flatMap(armatureNodes), ...exported.nodes];
  const byId = new Map(nodes.map(node => [node.id, node]));
  const sampler = compileAgentMotion(exported.motion, { ...exported, nodes });
  return {
    armature: exported.armatures[0],
    worldAt(time) {
      const patches = time === null ? new Map() : sampler.sample(time).nodes;
      const worlds = new Map();
      const worldOf = nodeId => {
        if (!worlds.has(nodeId)) {
          const node = byId.get(nodeId);
          const patch = patches.get(nodeId);
          const local = mat4.fromRotationTranslationScale(mat4.create(), patch?.rotation ?? node.rotation, patch?.translation ?? node.translation, patch?.scale ?? node.scale);
          worlds.set(nodeId, node.parent === null ? local : mat4.multiply(local, worldOf(node.parent), local));
        }
        return worlds.get(nodeId);
      };
      return worldOf;
    },
  };
}

// One capsule per bone, head to tail, radius a fifth of the bone length as the ragdoll fits it.
function boneCapsules(poser, time) {
  const bones = poser.armature.bones;
  const restWorld = poser.worldAt(null);
  const posedWorld = poser.worldAt(time);
  const origin = [0, 0, 0];
  return bones.flatMap(bone => {
    const children = bones.filter(candidate => candidate.parent === bone.name);
    const tailInArmature = bone.tail ?? (children.length
      ? [0, 1, 2].map(axis => children.reduce((total, child) => total + child.head[axis], 0) / children.length)
      : null);
    if (!tailInArmature) return [];
    const head = vec3.transformMat4(vec3.create(), origin, restWorld(bone.name));
    const tail = vec3.transformMat4(vec3.create(), tailInArmature, restWorld(poser.armature.id));
    const tailInBone = vec3.transformMat4(vec3.create(), tail, mat4.invert(mat4.create(), restWorld(bone.name)));
    return [{
      name: bone.name, radius: vec3.distance(head, tail) * 0.2,
      start: vec3.transformMat4(vec3.create(), origin, posedWorld(bone.name)),
      end: vec3.transformMat4(vec3.create(), tailInBone, posedWorld(bone.name)),
    }];
  });
}

function distanceToSegment(point, start, end) {
  const axis = vec3.subtract(vec3.create(), end, start);
  const along = vec3.dot(vec3.subtract(vec3.create(), point, start), axis) / Math.max(vec3.dot(axis, axis), 1e-12);
  const closest = vec3.scaleAndAdd(vec3.create(), start, axis, Math.min(Math.max(along, 0), 1));
  return vec3.distance(point, closest);
}

function capeWorldVertices(scene, nodeId = 'cape') {
  const part = scene.parts.find(candidate => candidate.name === nodeId);
  const positions = part.geometry.positions;
  const matrix = part.matrix;
  const world = [];
  for (let vertex = 0; vertex < positions.length; vertex += 3) {
    world.push(vec3.transformMat4(vec3.create(), [positions[vertex], positions[vertex + 1], positions[vertex + 2]], matrix));
  }
  return world;
}

// How far inside the limb capsules (past the cloth thickness) any cape vertex gets in the walk, and how far the cape travels.
function walkMeasure(cloth) {
  const recipe = walkingCapeRecipe(cloth);
  const scene = createAgentScene(recipe);
  const poser = createPoser(scene);
  const rest = capeWorldVertices(scene);
  let deepest = Infinity;
  let travelled = 0;
  for (let frame = 1; frame <= WALK_SECONDS * FRAMES_PER_SECOND; frame += 3) {
    scene.sampleMotion(frame / FRAMES_PER_SECOND);
    const capsules = boneCapsules(poser, frame / FRAMES_PER_SECOND);
    const vertices = capeWorldVertices(scene);
    for (const vertex of vertices) {
      for (const capsule of capsules) {
        deepest = Math.min(deepest, distanceToSegment(vertex, capsule.start, capsule.end) - capsule.radius - CAPE_THICKNESS);
      }
    }
    travelled = Math.max(travelled, vec3.distance(vertices[vertices.length - 1], rest[rest.length - 1]));
  }
  return { deepest, travelled };
}

test('a cape pinned to a walking humanoid never enters the limb capsules in a 5 second walk', () => {
  const { deepest, travelled } = walkMeasure(CAPE);
  assert.ok(deepest > -PENETRATION_TOLERANCE, `a vertex sits ${(-deepest * 1000).toFixed(2)} mm inside a capsule`);
  assert.ok(travelled > 3, `the cape rode the walker ${travelled.toFixed(2)} m forward`);
  const { colliders, ...withoutColliders } = CAPE;
  const free = walkMeasure(withoutColliders);
  assert.ok(free.deepest < -0.02, `the same cape without colliders is only ${(-free.deepest * 1000).toFixed(1)} mm inside, so the check proves nothing`);
});

test('the pinned top edge stays on the chest while the walker moves', () => {
  const scene = createAgentScene(walkingCapeRecipe(CAPE));
  const poser = createPoser(scene);
  const offsets = [];
  for (const time of [0, 1.7, 4.2]) {
    scene.sampleMotion(time);
    const chest = vec3.transformMat4(vec3.create(), [0, 0, 0], poser.worldAt(time)('chest'));
    const topCorner = capeWorldVertices(scene).reduce((best, vertex) => (vertex[1] > best[1] ? vertex : best));
    offsets.push(vec3.distance(chest, topCorner));
  }
  assert.ok(Math.max(...offsets) - Math.min(...offsets) < 0.2, `top edge drifted: ${offsets.map(offset => offset.toFixed(3))}`);
});

test('seeking to a time gives the cloth that playing to it gives', () => {
  const played = createAgentScene(walkingCapeRecipe(CAPE));
  for (let time = 0; time <= 3.01; time += 0.5) played.sampleMotion(time);
  const playedVertices = capeWorldVertices(played);
  const sought = createAgentScene(walkingCapeRecipe(CAPE));
  sought.sampleMotion(4.4);
  sought.sampleMotion(3);
  assert.deepEqual(capeWorldVertices(sought), playedVertices);
  const fresh = createAgentScene(walkingCapeRecipe(CAPE));
  fresh.sampleMotion(3);
  assert.deepEqual(capeWorldVertices(fresh), playedVertices, 'a second scene from the same recipe bakes the same cloth');
});

test('a ball and a capsule on nodes follow their node and push cloth aside', () => {
  const recipe = {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'sheet', type: 'grid', segments: 20 }],
    materials: [{ id: 'fabric', doubleSided: true }],
    nodes: [
      { id: 'cloth', geometry: 'sheet', material: 'fabric', translation: [0, 1, 0], rotation: [-0.7071068, 0, 0, 0.7071068], scale: [2, 2, 1] },
      { id: 'hand', translation: [0, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], parent: null },
      { id: 'fingertip', translation: [0.3, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], parent: 'hand' },
    ],
    motion: { duration: 2, loop: false, tracks: [{ kind: 'node', id: 'hand', property: 'translation', interpolation: 'LINEAR', keyframes: [{ time: 0, value: [0, 0.5, 0] }, { time: 2, value: [0, 1.2, 0] }] }] },
    cloth: { duration: 2, sheets: [{ node: 'cloth', thickness: 0.01 }], colliders: [{ attach: 'hand', shape: 'capsule', to: 'fingertip', radius: 0.15 }] },
  };
  const scene = createAgentScene(recipe);
  scene.sampleMotion(2);
  const raised = capeWorldVertices(scene, 'cloth');
  const highest = Math.max(...raised.map(vertex => vertex[1]));
  assert.ok(highest > 1.3, `cloth lifted to ${highest.toFixed(2)} m by the rising capsule`);
});

test('a soft pin pulls the particle less than a hard pin', () => {
  const positions = Float64Array.from([0, 0, 0, 1, 0, 0]);
  const triangles = Uint32Array.from([0, 1, 0]);
  const track = Float64Array.from({ length: 4 * 60 * 3 }, (_, index) => (index % 3 === 1 ? 5 : 0));
  const bake = weight => bakeCloth(positions, triangles, {
    frameCount: 61, gravity: [0, 0, 0],
    moving: { anchorParticles: Uint32Array.of(0), anchorWeights: Float64Array.of(weight), anchorTrack: track, colliderCount: 0, colliderTrack: new Float64Array(0) },
  });
  const hardEnd = bake(1).frames.subarray(60 * 6, 60 * 6 + 3);
  const softEnd = bake(0.2).frames.subarray(60 * 6, 60 * 6 + 3);
  assert.equal(hardEnd[1], 5);
  assert.ok(softEnd[1] > 4 && softEnd[1] < 5.0001, `soft pin reached ${softEnd[1]}`);
});

test('recipe checks refuse bad moving colliders and pins', () => {
  const bad = cloth => () => createAgentScene(walkingCapeRecipe({ ...CAPE, ...cloth }));
  assert.throws(bad({ colliders: [{ attach: 'chest', shape: 'capsule', radius: 0.1 }] }), /cloth\.colliders\[0\]\.to: got undefined; expected the ID of the node the capsule other end rides on/);
  assert.throws(bad({ colliders: [{ attach: 'nowhere', radius: 0.1 }] }), /cloth\.colliders\[0\]\.attach: got "nowhere"; expected the ID of a node in the recipe/);
  assert.throws(bad({ colliders: [{ armature: 'rig', exclude: ['tail'] }] }), /cloth\.colliders\[0\]\.exclude: got "tail"; expected a bone name of rig/);
  assert.throws(bad({ colliders: [{ armature: 'ghost' }] }), /cloth\.colliders\[0\]\.armature: got "ghost"; expected the ID of an armature/);
  assert.throws(bad({ sheets: [{ node: 'cape', pinTo: { node: 'chest' } }] }), /cloth\.sheets\[0\]\.pinTo: got .*; expected a sheet that also sets pin/);
  assert.throws(bad({ sheets: [{ node: 'cape', pin: ['top'], pinTo: { node: 'chest', weight: 0 } }] }), /cloth\.sheets\[0\]\.pinTo\.weight: got 0; expected a number from 0\.01 to 1/);
});
