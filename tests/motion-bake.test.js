import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AnimationMixer, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createAgentScene, loadPhysicsEngine } from '../src/agent-scene.js';
import { exportGlb } from '../src/export.js';
import { walkerRecipe } from '../bench/agent-modeling/walker.mjs';

await loadPhysicsEngine();

const STEP = 0.05;

function pathRecipe() {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.6, 0.6, 0.6] }],
    nodes: [
      { id: 'rider', geometry: 'box', material: 'paint' },
      { id: 'still', geometry: 'box', material: 'paint', translation: [3, 0, 0] },
    ],
    motion: {
      duration: 2, loop: false, tracks: [],
      constraints: [{ type: 'follow_path', node: 'rider', points: [[0, 0, 0], [2, 1, 0], [3, 0, 2], [0, 2, 3]], followCurve: true, forwardAxis: '+z', upAxis: 'y', duration: 2 }],
    },
  };
}

function frameTimes(duration, step) {
  return Array.from({ length: Math.round(duration / step) + 1 }, (_, index) => Math.min(duration, Math.round(index * step * 1e6) / 1e6));
}

function matrixAt(scene, name, time) {
  scene.sampleMotion(time);
  return Array.from(scene.parts.find(part => part.name === name).matrix);
}

function largestDifference(first, second) {
  return Math.max(...first.map((value, index) => Math.abs(value - second[index])));
}

function applyBake(scene, operation) {
  return scene.apply([{ type: 'bake-motion', ...operation }], { expectedRevision: scene.revision });
}

test('baked keys reproduce the live constraint sample at every frame', () => {
  const live = createAgentScene(pathRecipe());
  const baked = createAgentScene(pathRecipe());
  applyBake(baked, { nodes: ['rider'], step: STEP });
  const motion = baked.exportRecipe().motion;
  assert.equal(motion.constraints, undefined, 'the constraint is gone once its result is keys');
  assert.deepEqual(motion.tracks.map(track => `${track.id}.${track.property}`).sort(), ['rider.rotation', 'rider.translation']);
  for (const time of frameTimes(2, STEP)) {
    assert.ok(largestDifference(matrixAt(baked, 'rider', time), matrixAt(live, 'rider', time)) < 1e-5, `rider at ${time}`);
  }
});

test('simplifying keeps every frame within the tolerance and drops keys', () => {
  const live = createAgentScene(pathRecipe());
  const baked = createAgentScene(pathRecipe());
  const tolerance = { position: 0.01, angle: 1 };
  applyBake(baked, { nodes: ['rider'], step: 0.02, tolerance });
  const tracks = baked.exportRecipe().motion.tracks;
  const keys = tracks.reduce((total, track) => total + track.keyframes.length, 0);
  assert.ok(keys < 2 * 101 / 2, `${keys} keys instead of 202`);
  assert.ok(tracks.every(track => track.keyframes.length <= 64));
  for (const time of frameTimes(2, 0.02)) {
    const difference = largestDifference(matrixAt(baked, 'rider', time), matrixAt(live, 'rider', time));
    assert.ok(difference < 0.05, `rider at ${time} is ${difference} off`);
  }
});

test('a bake repeats byte for byte', () => {
  const recipes = [0, 1].map(() => {
    const scene = createAgentScene(pathRecipe());
    applyBake(scene, { nodes: ['rider', 'still'], step: 0.04, tolerance: {} });
    return JSON.stringify(scene.exportRecipe());
  });
  assert.equal(recipes[0], recipes[1]);
});

test('a node at its rest value gets no track, and a steady one gets a single key', () => {
  const scene = createAgentScene(pathRecipe());
  applyBake(scene, { nodes: ['still'], step: 0.5 });
  assert.equal(scene.exportRecipe().motion.constraints.length, 1, 'the rider keeps its constraint');
  assert.deepEqual(scene.exportRecipe().motion.tracks, []);
  const withAnchor = pathRecipe();
  withAnchor.nodes.push({ id: 'anchor', geometry: 'box', material: 'paint', translation: [0, 5, 0] });
  const moved = createAgentScene({ ...withAnchor, motion: { duration: 1, tracks: [], constraints: [{ type: 'copy_location', node: 'still', target: 'anchor' }] } });
  applyBake(moved, { nodes: ['still'], start: 0, end: 1, step: 0.5, tolerance: {} });
  assert.equal(moved.exportRecipe().motion.tracks.find(track => track.property === 'translation').keyframes.length, 1);
});

test('a bake that cannot be honest names the field and what to pass', () => {
  const scene = createAgentScene(pathRecipe());
  const fails = (operation, pattern) => assert.throws(() => applyBake(scene, operation), pattern);
  fails({ nodes: ['ghost'] }, /nodes\[0\].*ghost.*scene_inspect/);
  fails({ nodes: [] }, /nodes.*1 to 32/);
  fails({ nodes: ['rider', 'rider'] }, /nodes\[1\].*each node ID once/);
  fails({ nodes: ['rider'], end: 0, start: 1 }, /end.*after start/);
  fails({ nodes: ['rider'], step: 0.001 }, /step.*0.0083/);
  fails({ nodes: ['rider'], step: 0.001 * 20, end: 30 }, /step.*512 samples/);
  fails({ nodes: ['rider'], step: 0.01 }, /tolerance.*64 keys/);
  fails({ nodes: ['rider'], tolerance: { position: -1 } }, /tolerance.position/);
  fails({ nodes: ['rider'], speed: 2 }, /Unknown.*speed/);
  assert.equal(scene.revision, 0, 'a failed bake changes nothing');
  const motionless = pathRecipe();
  delete motionless.motion;
  const still = createAgentScene(motionless);
  assert.throws(() => applyBake(still, { nodes: ['rider'] }), /nodes.*add motion or physics first/);
});

function ragdollRecipe() {
  const recipe = walkerRecipe();
  delete recipe.motion;
  recipe.geometries.push({ id: 'slab', type: 'box' });
  recipe.nodes.push({ id: 'floor', geometry: 'slab', material: 'cloth', translation: [0, -0.25, 0], scale: [8, 0.5, 8] });
  recipe.armatures[0].translation = [0, 1, 0];
  recipe.physics = { duration: 3, bodies: [{ node: 'floor', type: 'fixed' }], ragdoll: { armature: 'rig' } };
  return recipe;
}

function jointWorlds(scene, time) {
  scene.sampleMotion(time);
  return scene.parts.filter(part => part.skin).flatMap(part => Array.from(part.skin.jointWorldMatrices));
}

function worldBoneIds(recipe) {
  return [...recipe.nodes.filter(node => node.armature === 'rig' && node.id !== 'rig').map(node => node.id), 'floor'];
}

test('a ragdoll fall bakes to keys, simplifies and exports as a clip a viewer plays the same', async () => {
  const live = createAgentScene(ragdollRecipe());
  const baked = createAgentScene(ragdollRecipe());
  const ids = worldBoneIds(baked.exportRecipe());
  assert.throws(() => applyBake(baked, { nodes: ids.slice(1) }), /every node the physics world moves, so also/);
  applyBake(baked, { nodes: ids, tolerance: { position: 0.01, angle: 1 } });
  const recipe = baked.exportRecipe();
  assert.equal(recipe.physics, undefined, 'the recording is replaced by keys');
  const keys = recipe.motion.tracks.reduce((total, track) => total + track.keyframes.length, 0);
  assert.ok(keys > 0 && keys < ids.length * 2 * 91 / 2, `${keys} keys`);
  for (const time of frameTimes(3, 1 / 6)) {
    const difference = largestDifference(jointWorlds(baked, time), jointWorlds(live, time));
    assert.ok(difference < 0.1, `joints at ${time} are ${difference} off`);
  }
  const gltf = await new GLTFLoader().parseAsync(exportGlb(baked.parts, baked.rigExport()), '');
  assert.equal(gltf.animations.length, 1);
  const skinned = [];
  gltf.scene.traverse(object => {
    if (object.isSkinnedMesh) skinned.push(object);
  });
  const mixer = new AnimationMixer(gltf.scene);
  mixer.clipAction(gltf.animations[0]).play();
  const bones = skinned[0].skeleton.bones;
  const POSITION_TOLERANCE = 0.05;
  const ROTATION_TOLERANCE = 0.05;
  for (const time of frameTimes(2.9, 0.1)) {
    mixer.setTime(time);
    gltf.scene.updateMatrixWorld(true);
    const liveJoints = jointWorlds(live, time);
    bones.forEach((bone, index) => {
      const liveMatrix = liveJoints.slice(index * 16, index * 16 + 16);
      const viewerMatrix = bone.matrixWorld.elements;
      const positionError = Math.hypot(viewerMatrix[12] - liveMatrix[12], viewerMatrix[13] - liveMatrix[13], viewerMatrix[14] - liveMatrix[14]);
      const rotationError = largestDifference(Array.from(viewerMatrix).slice(0, 11), liveMatrix.slice(0, 11));
      assert.ok(positionError < POSITION_TOLERANCE, `${bone.name} at ${time} is ${positionError} m off in the viewer`);
      assert.ok(rotationError < ROTATION_TOLERANCE, `${bone.name} at ${time} is ${rotationError} off in rotation in the viewer`);
    });
  }
});

function armRecipe() {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.6, 0.6, 0.6] }],
    nodes: [
      { id: 'shoulder', translation: [0, 1, 0] },
      { id: 'elbow', parent: 'shoulder', translation: [0.5, 0, 0] },
      { id: 'tip', parent: 'elbow', translation: [0.4, 0, 0], geometry: 'box', material: 'paint', scale: [0.03, 0.03, 0.03] },
    ],
    motion: {
      duration: 1, tracks: [],
      ik: [{ type: 'two-bone', root: 'shoulder', middle: 'elbow', end: 'tip', pole: [0, 3, 0], target: { keyframes: [{ time: 0, value: [0.4, 1.5, 0.3] }, { time: 1, value: [0.2, 1.1, -0.3] }] } }],
    },
  };
}

test('IK bakes whole: the arm joints become rotation keys, and a partial bake is refused', () => {
  const live = createAgentScene(armRecipe());
  const baked = createAgentScene(armRecipe());
  assert.throws(() => applyBake(baked, { nodes: ['elbow'] }), /nodes.*every node the two-bone IK solver moves, so also shoulder, tip/);
  applyBake(baked, { nodes: ['shoulder', 'elbow', 'tip'], step: 0.1 });
  assert.equal(baked.exportRecipe().motion.ik, undefined);
  for (const time of frameTimes(1, 0.1)) {
    assert.ok(largestDifference(matrixAt(baked, 'tip', time), matrixAt(live, 'tip', time)) < 1e-4, `tip at ${time}`);
  }
});
