import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createAgentScene } from '../src/agent-scene.js';
import { exportGlb } from '../src/export.js';
import { mapHumanoidBones } from '../src/retarget.js';
import { computeSkinWeights, createRigFromArmature, armatureProblems } from '../src/rig.js';
import { gradeRecipe } from '../bench/agent-modeling/check.mjs';
import { taskById } from '../bench/agent-modeling/tasks.mjs';
import { walkerRecipe } from '../bench/agent-modeling/walker.mjs';

const failedLabels = grade => grade.results.filter(result => !result.pass).map(result => result.label ?? result.kind);
const task = taskById('rigged-walker');

test('a rig with a missing leg bone, an unskinned arm or a backward elbow fails its own check', async () => {
  const missingBone = walkerRecipe();
  missingBone.armatures = [{ id: 'rig', bones: walkerRecipe().armatures.length ? [] : [] }];
  const scene = createAgentScene(walkerRecipe());
  const bones = scene.exportRecipe().armatures[0].bones.filter(bone => bone.name !== 'leftLowerLeg').map(bone => (bone.parent === 'leftLowerLeg' ? { ...bone, parent: 'leftUpperLeg' } : bone));
  missingBone.armatures = [{ id: 'rig', bones }];
  missingBone.motion.tracks = missingBone.motion.tracks.filter(track => track.id !== 'leftLowerLeg');
  assert.ok(failedLabels(await gradeRecipe(task, missingBone)).includes('rigBones'));

  const unskinnedArm = walkerRecipe();
  delete unskinnedArm.nodes.find(node => node.id === 'left-upper-arm-mesh').skin;
  assert.deepEqual(failedLabels(await gradeRecipe(task, unskinnedArm)), ['rigSkinned']);

  const backwardElbow = walkerRecipe();
  backwardElbow.armatures[0].fit.landmarks = { leftLowerArm: [0.216, 1.08, 0.04] };
  assert.ok(failedLabels(await gradeRecipe(task, backwardElbow)).includes('walk cycle'));
});

test('the walker reference passes every check', async () => {
  const grade = await gradeRecipe(task, walkerRecipe());
  assert.equal(grade.pass, true, JSON.stringify(grade.results.filter(result => !result.pass)));
});

test('automatic weights give four influences that sum to one, and seams share weights', () => {
  const scene = createAgentScene(walkerRecipe());
  for (const part of scene.parts.filter(candidate => candidate.skin)) {
    const { skinIndices, skinWeights, positions } = part.geometry;
    const seen = new Map();
    for (let vertex = 0; vertex < positions.length / 3; vertex++) {
      const total = skinWeights.slice(vertex * 4, vertex * 4 + 4).reduce((sum, weight) => sum + weight, 0);
      assert.ok(Math.abs(total - 1) < 1e-5);
      const key = Array.from(positions.subarray(vertex * 3, vertex * 3 + 3)).map(value => value.toFixed(5)).join(',');
      const weights = `${Array.from(skinIndices.subarray(vertex * 4, vertex * 4 + 4))}|${Array.from(skinWeights.subarray(vertex * 4, vertex * 4 + 4))}`;
      assert.equal(seen.get(key) ?? weights, weights);
      seen.set(key, weights);
    }
  }
});

test('scene_inspect reports unweighted vertices, bones with no vertices and joint axis problems', () => {
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint' }],
    armatures: [{ id: 'rig', bones: [
      { name: 'root', parent: null, head: [0, 0, 0], tail: [0, 0.5, 0] },
      { name: 'leftUpperLeg', parent: 'root', head: [0, 0.5, 0] },
      { name: 'leftLowerLeg', parent: 'leftUpperLeg', head: [0, 0.25, 0] },
      { name: 'leftFoot', parent: 'leftLowerLeg', head: [0, 0, 0], tail: [0, 0, 0] },
      { name: 'antenna', parent: 'root', head: [0, 9, 0], tail: [0, 9.5, 0] },
    ] }],
    nodes: [{ id: 'block', geometry: 'block', material: 'paint', scale: [0.2, 0.2, 0.2], translation: [0, 0.4, 0], skin: { armature: 'rig', maxDistance: 0.05 } }],
  };
  const report = createAgentScene(recipe).inspect({}).rig[0];
  assert.ok(report.skinned[0].unweightedVertices > 0);
  assert.ok(report.bonesWithNoVertices.includes('antenna'));
  const problems = report.jointAxisProblems.map(problem => `${problem.bone}:${problem.problem}`);
  assert.ok(problems.includes('leftFoot:zero-length'));
  assert.ok(problems.includes('leftLowerLeg:straight-chain'));
});

test('a straight-legged humanoid and a backward knee are both flagged', () => {
  const rig = createAgentScene(walkerRecipe()).exportRecipe().armatures[0];
  assert.deepEqual(armatureProblems(rig), []);
  const backward = structuredClone(rig);
  backward.bones.find(bone => bone.name === 'leftLowerLeg').head[2] = -0.05;
  assert.deepEqual(armatureProblems(backward).map(problem => problem.problem), ['knee-bends-backward']);
});

test('armature bones are recipe nodes, and an exported recipe loads back unchanged', () => {
  const scene = createAgentScene(walkerRecipe());
  const recipe = scene.exportRecipe();
  assert.ok(recipe.nodes.some(node => node.id === 'leftLowerLeg' && node.armature === 'rig'));
  const reloaded = createAgentScene(recipe).exportRecipe();
  assert.equal(reloaded.nodes.length, recipe.nodes.length);
  assert.deepEqual(reloaded.armatures, recipe.armatures);
});

test('a preset armature maps to humanoid bones without overrides', () => {
  const rig = createRigFromArmature(createAgentScene(walkerRecipe()).exportRecipe().armatures[0]);
  assert.deepEqual(mapHumanoidBones(rig.joints.map(joint => joint.name)).missing, []);
});

test('a quadruped preset fits the bounds of a mesh node', () => {
  const scene = createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }], materials: [{ id: 'paint' }],
    armatures: [{ id: 'dog', preset: 'quadruped', fit: { node: 'body' } }],
    nodes: [{ id: 'body', geometry: 'block', material: 'paint', translation: [0, 0.4, 0], scale: [0.4, 0.8, 1.2], skin: { armature: 'dog' } }],
  });
  const bones = scene.exportRecipe().armatures[0].bones;
  assert.equal(bones.length, 20);
  assert.ok(bones.find(bone => bone.name === 'head').head[2] > bones.find(bone => bone.name === 'hips').head[2]);
});

test('weights depend on position only and unweighted vertices still bind to a bone', () => {
  const identity = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const result = computeSkinWeights({
    positions: Float32Array.from([0, 5, 0]), meshMatrix: identity, maxInfluences: 4, maxDistance: 1, softness: 0.02,
    segments: [{ head: [0, 0, 0], tail: [0, 1, 0] }, { head: [0, 1, 0], tail: [0, 2, 0] }],
  });
  assert.equal(result.unweighted.length, 1);
  assert.ok(result.weights[0] > 0.5 && result.indices[0] === 1);
});

test('the walker exports to a GLB that three.js loads with its skeleton and walk clip', async () => {
  const scene = createAgentScene(walkerRecipe());
  const rig = scene.rigExport();
  assert.equal(rig.clips.length, 1);
  const binary = exportGlb(scene.parts, rig);
  const gltf = await new GLTFLoader().parseAsync(binary, '');
  const skinned = [];
  gltf.scene.traverse(object => {
    if (object.isSkinnedMesh) skinned.push(object);
  });
  assert.equal(skinned.length, 14);
  assert.equal(skinned[0].skeleton.bones.length, 21);
  assert.equal(gltf.animations.length, 1);
  assert.ok(gltf.animations[0].tracks.length >= 8);
});

test('set-armatures replaces the rig and refuses to leave a skin without one', () => {
  const scene = createAgentScene(walkerRecipe());
  assert.throws(() => scene.apply([{ type: 'set-armatures', armatures: null }], { expectedRevision: scene.revision }), /skin/);
  scene.apply([{ type: 'set-armatures', armatures: [{ id: 'rig', preset: 'humanoid', fit: { bounds: { min: [-0.3, 0, -0.1], max: [0.3, 2, 0.1] } } }] }], { expectedRevision: scene.revision });
  assert.equal(scene.exportRecipe().armatures[0].bones.find(bone => bone.name === 'head').tail[1], 2);
});
