import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4, quat, vec3 } from 'gl-matrix';
import { createAnimationClip } from '../src/animation.js';
import { createSkinPose } from '../src/skinning.js';
import { createSkinClipPlayer } from '../src/retarget.js';
import { createSkeletonPose } from '../src/skeleton-pose.js';

const NAMES = {
  hips: 'mixamorig:Hips', spine: 'mixamorig:Spine', head: 'mixamorig:Head',
  leftUpperArm: 'mixamorig:LeftArm', leftLowerArm: 'mixamorig:LeftForeArm', leftHand: 'mixamorig:LeftHand',
  leftUpperLeg: 'mixamorig:LeftUpLeg', leftLowerLeg: 'mixamorig:LeftLeg', leftFoot: 'mixamorig:LeftFoot',
  rightUpperArm: 'mixamorig:RightArm', rightLowerArm: 'mixamorig:RightForeArm', rightHand: 'mixamorig:RightHand',
  rightUpperLeg: 'mixamorig:RightUpLeg', rightLowerLeg: 'mixamorig:RightLeg', rightFoot: 'mixamorig:RightFoot',
};

function createRig() {
  const joints = [];
  const add = (bone, parent, translation) => {
    joints.push({ name: NAMES[bone], parent, translation, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    return joints.length - 1;
  };
  const hips = add('hips', -1, [0, 1, 0]);
  const spine = add('spine', hips, [0, 0.3, 0]);
  add('head', spine, [0, 0.5, 0]);
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    const upperArm = add(`${side}UpperArm`, spine, [sign * 0.2, 0.4, 0]);
    const lowerArm = add(`${side}LowerArm`, upperArm, [sign * 0.3, 0, 0]);
    add(`${side}Hand`, lowerArm, [sign * 0.25, 0, 0]);
    const upperLeg = add(`${side}UpperLeg`, hips, [sign * 0.1, 0, 0]);
    const lowerLeg = add(`${side}LowerLeg`, upperLeg, [0, -0.45, 0]);
    add(`${side}Foot`, lowerLeg, [0, -0.45, 0]);
  }
  return { joints };
}

function rotationAbout(axis, degrees) {
  return Array.from(quat.setAxisAngle(new Float64Array(4), axis, degrees * Math.PI / 180));
}

function rotationClip(target, degrees, axis = [0, 0, 1], duration = 1) {
  return createAnimationClip({
    duration,
    tracks: [{ target, property: 'rotation', keyframes: [{ time: 0, value: [0, 0, 0, 1] }, { time: duration, value: rotationAbout(axis, degrees) }] }],
  });
}

function assertClose(actual, expected, tolerance = 1e-6, label = '') {
  for (let index = 0; index < expected.length; index++) {
    assert.ok(Math.abs(actual[index] - expected[index]) <= tolerance, `${label} ${JSON.stringify(Array.from(actual))} vs ${JSON.stringify(Array.from(expected))}`);
  }
}

function assertSameRotation(actual, expected, tolerance = 1e-6) {
  assert.ok(1 - Math.abs(quat.dot(actual, expected)) <= tolerance, `${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
}

test('with no layers the pose is the rest pose', () => {
  const pose = createSkeletonPose({ rig: createRig() });
  pose.apply(0);
  assertClose(pose.jointWorld('head').position, [0, 1.8, 0]);
  assertClose(pose.jointWorld('leftFoot').position, [0.1, 0.1, 0]);
});

test('one full-weight layer matches the existing skin clip player', () => {
  const rig = createRig();
  const clip = rotationClip(NAMES.spine, 40);
  const createSkin = () => {
    const skin = createSkinPose(rig.joints.length);
    skin.inverseBindMatrices = new Float32Array(rig.joints.length * 16);
    for (let joint = 0; joint < rig.joints.length; joint++) skin.inverseBindMatrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], joint * 16);
    return skin;
  };
  const skinA = createSkin();
  const skinB = createSkin();
  createSkinClipPlayer(skinA, clip, { rig }).apply(0.5);
  createSkeletonPose({ skin: skinB, rig, layers: [{ clip }] }).apply(0.5);
  assertClose(skinB.jointMatrices, skinA.jointMatrices, 1e-5);
});

test('a mask limits a layer to a joint and its descendants, minus exclusions', () => {
  const clip = createAnimationClip({
    duration: 1,
    tracks: [
      { target: NAMES.leftUpperArm, property: 'rotation', keyframes: [{ time: 0, value: rotationAbout([0, 0, 1], 90) }] },
      { target: NAMES.leftLowerArm, property: 'rotation', keyframes: [{ time: 0, value: rotationAbout([0, 0, 1], 90) }] },
      { target: NAMES.rightUpperArm, property: 'rotation', keyframes: [{ time: 0, value: rotationAbout([0, 0, 1], 90) }] },
    ],
  });
  const rest = createSkeletonPose({ rig: createRig() });
  rest.apply(0);
  const masked = createSkeletonPose({ rig: createRig(), layers: [{ clip, mask: { joints: ['leftUpperArm'] } }] });
  masked.apply(0);
  assertClose(masked.jointWorld('rightHand').position, rest.jointWorld('rightHand').position);
  assert.ok(vec3.distance(masked.jointWorld('leftHand').position, rest.jointWorld('leftHand').position) > 0.1);

  const noDescendants = createSkeletonPose({ rig: createRig(), layers: [{ clip, mask: { joints: ['leftUpperArm'], descendants: false } }] });
  noDescendants.apply(0);
  assertSameRotation(noDescendants.jointWorld('leftLowerArm').rotation, rotationAbout([0, 0, 1], 90));

  const excluded = createSkeletonPose({ rig: createRig(), layers: [{ clip, mask: { joints: ['leftUpperArm'], exclude: ['leftLowerArm'] } }] });
  excluded.apply(0);
  assertSameRotation(excluded.jointWorld('leftLowerArm').rotation, rotationAbout([0, 0, 1], 90));
  assertClose(excluded.jointWorld('leftLowerArm').position, noDescendants.jointWorld('leftLowerArm').position);
});

test('a masked layer overrides only its joints on top of a base layer', () => {
  const walk = createAnimationClip({
    duration: 1,
    tracks: [
      { target: NAMES.leftUpperLeg, property: 'rotation', keyframes: [{ time: 0, value: rotationAbout([1, 0, 0], 30) }] },
      { target: NAMES.leftUpperArm, property: 'rotation', keyframes: [{ time: 0, value: rotationAbout([1, 0, 0], 30) }] },
    ],
  });
  const wave = createAnimationClip({
    duration: 1,
    tracks: [{ target: NAMES.leftUpperArm, property: 'rotation', keyframes: [{ time: 0, value: rotationAbout([0, 0, 1], 80) }] }],
  });
  const pose = createSkeletonPose({ rig: createRig(), layers: [{ clip: walk }, { clip: wave, mask: { joints: ['leftUpperArm'] } }] });
  pose.apply(0);
  assertSameRotation(pose.jointWorld('leftUpperArm').rotation, rotationAbout([0, 0, 1], 80));
  assertSameRotation(pose.jointWorld('leftUpperLeg').rotation, rotationAbout([1, 0, 0], 30));
});

test('layer weight blends, and can be a function of time', () => {
  const clip = createAnimationClip({
    duration: 1,
    tracks: [{ target: NAMES.spine, property: 'rotation', keyframes: [{ time: 0, value: rotationAbout([0, 0, 1], 90) }] }],
  });
  const half = createSkeletonPose({ rig: createRig(), layers: [{ clip, weight: 0.5 }] });
  half.apply(0);
  assertSameRotation(half.jointWorld('spine').rotation, rotationAbout([0, 0, 1], 45));
  const fading = createSkeletonPose({ rig: createRig(), layers: [{ clip, weight: time => Math.min(1, time) }] });
  fading.apply(0);
  assertSameRotation(fading.jointWorld('spine').rotation, [0, 0, 0, 1]);
  fading.apply(1);
  assertSameRotation(fading.jointWorld('spine').rotation, rotationAbout([0, 0, 1], 90));
  assert.throws(() => createSkeletonPose({ rig: createRig(), layers: [{ clip, weight: 2 }] }), /weight must be from 0 to 1/);
  const broken = createSkeletonPose({ rig: createRig(), layers: [{ clip, weight: () => Number.NaN }] });
  assert.throws(() => broken.apply(0), /returned NaN/);
});

test('an additive layer adds its change from the reference onto the pose below', () => {
  const base = createAnimationClip({
    duration: 1,
    tracks: [{ target: NAMES.spine, property: 'rotation', keyframes: [{ time: 0, value: rotationAbout([0, 0, 1], 30) }] }],
  });
  const breathe = rotationClip(NAMES.spine, 20);
  const pose = createSkeletonPose({ rig: createRig(), layers: [{ clip: base }, { clip: breathe, additive: true }] });
  pose.apply(0);
  assertSameRotation(pose.jointWorld('spine').rotation, rotationAbout([0, 0, 1], 30));
  pose.apply(1);
  assertSameRotation(pose.jointWorld('spine').rotation, rotationAbout([0, 0, 1], 50));

  const halfway = createSkeletonPose({ rig: createRig(), layers: [{ clip: base }, { clip: breathe, additive: true, weight: 0.5 }] });
  halfway.apply(1);
  assertSameRotation(halfway.jointWorld('spine').rotation, rotationAbout([0, 0, 1], 40));

  const fromEnd = createSkeletonPose({ rig: createRig(), layers: [{ clip: base }, { clip: breathe, additive: true, reference: 1 }] });
  fromEnd.apply(1);
  assertSameRotation(fromEnd.jointWorld('spine').rotation, rotationAbout([0, 0, 1], 30));
});

test('additive translation adds the offset from the reference', () => {
  const bob = createAnimationClip({
    duration: 1,
    tracks: [{ target: NAMES.hips, property: 'translation', keyframes: [{ time: 0, value: [0, 1, 0] }, { time: 1, value: [0, 1.1, 0] }] }],
  });
  const pose = createSkeletonPose({ rig: createRig(), layers: [{ clip: bob, additive: true }] });
  pose.apply(1);
  assertClose(pose.jointWorld('hips').position, [0, 1.1, 0], 1e-6);
});

test('seeking gives the same pose as playing forward', () => {
  const clip = rotationClip(NAMES.leftUpperArm, 70);
  const options = { layers: [{ clip }], ik: [{ type: 'aim', joint: 'head', forward: [0, 0, 1], target: time => [time, 2, 1] }] };
  const played = createSkeletonPose({ rig: createRig(), ...options });
  for (const time of [0, 0.2, 0.4, 0.6]) played.apply(time);
  const seeked = createSkeletonPose({ rig: createRig(), ...options });
  seeked.apply(0.9);
  seeked.apply(0.6);
  assertClose(played.jointWorld('leftHand').position, seeked.jointWorld('leftHand').position, 1e-12);
  assertClose(played.jointWorld('head').rotation, seeked.jointWorld('head').rotation, 1e-12);
});

test('two-bone IK reaches a target, keeps bone lengths and keeps the foot rotation', () => {
  const target = [0.25, 0.35, 0.3];
  const start = createSkeletonPose({ rig: createRig() });
  start.apply(0);
  const footRotation = start.jointWorld('leftFoot').rotation;
  const pose = createSkeletonPose({
    rig: createRig(),
    ik: [{ type: 'two-bone', root: 'leftUpperLeg', middle: 'leftLowerLeg', end: 'leftFoot', target, pole: [0.1, 0.6, 1] }],
  });
  pose.apply(0);
  assert.equal(pose.ikResults[0].reached, true);
  assert.ok(pose.ikResults[0].error < 1e-6, `error ${pose.ikResults[0].error}`);
  assertClose(pose.jointWorld('leftFoot').position, target, 1e-6);
  const hip = pose.jointWorld('leftUpperLeg').position;
  const knee = pose.jointWorld('leftLowerLeg').position;
  const ankle = pose.jointWorld('leftFoot').position;
  assert.ok(Math.abs(vec3.distance(hip, knee) - 0.45) < 1e-6);
  assert.ok(Math.abs(vec3.distance(knee, ankle) - 0.45) < 1e-6);
  assertSameRotation(pose.jointWorld('leftFoot').rotation, footRotation);
  assert.ok(knee[2] > 0.1, `knee bends toward the pole: ${knee}`);
});

test('two-bone IK bends toward the pole on either side', () => {
  const makePose = pole => createSkeletonPose({
    rig: createRig(),
    ik: [{ type: 'two-bone', root: 'leftUpperLeg', middle: 'leftLowerLeg', end: 'leftFoot', target: [0.1, 0.4, 0], pole }],
  });
  const forward = makePose([0.1, 0.5, 1]);
  forward.apply(0);
  const backward = makePose([0.1, 0.5, -1]);
  backward.apply(0);
  assert.ok(forward.jointWorld('leftLowerLeg').position[2] > 0.1);
  assert.ok(backward.jointWorld('leftLowerLeg').position[2] < -0.1);
});

test('two-bone IK reports an unreachable target and reaches toward it', () => {
  const pose = createSkeletonPose({
    rig: createRig(),
    ik: [{ type: 'two-bone', root: 'leftUpperLeg', middle: 'leftLowerLeg', end: 'leftFoot', target: [0.1, 1, 5] }],
  });
  pose.apply(0);
  assert.equal(pose.ikResults[0].reached, false);
  const hip = pose.jointWorld('leftUpperLeg').position;
  const ankle = pose.jointWorld('leftFoot').position;
  assert.ok(Math.abs(vec3.distance(hip, ankle) - 0.9) < 1e-3);
  assert.ok(ankle[2] > 0.85, `reaches toward the target: ${ankle}`);
});

test('a target function can plant a foot from the animated position', () => {
  const swing = createAnimationClip({
    duration: 1,
    tracks: [{ target: NAMES.leftUpperLeg, property: 'rotation', keyframes: [{ time: 0, value: rotationAbout([1, 0, 0], 15) }] }],
  });
  const groundHeight = 0.2;
  const pose = createSkeletonPose({
    rig: createRig(),
    layers: [{ clip: swing }],
    ik: [{
      type: 'two-bone', root: 'leftUpperLeg', middle: 'leftLowerLeg', end: 'leftFoot', pole: [0.1, 0.6, 1],
      target: (time, foot) => [foot[0], groundHeight, foot[2]],
    }],
  });
  pose.apply(0);
  const plantedError = Math.abs(pose.jointWorld('leftFoot').position[1] - groundHeight);
  assert.ok(plantedError < 1e-6, `foot is ${plantedError} from the ground`);
});

test('IK weight fades the solve in, and zero leaves the pose alone', () => {
  const rest = createSkeletonPose({ rig: createRig() });
  rest.apply(0);
  const make = weight => createSkeletonPose({
    rig: createRig(),
    ik: [{ type: 'two-bone', root: 'leftUpperLeg', middle: 'leftLowerLeg', end: 'leftFoot', target: [0.25, 0.35, 0.3], pole: [0.1, 0.6, 1], weight }],
  });
  const off = make(0);
  off.apply(0);
  assertClose(off.jointWorld('leftFoot').position, rest.jointWorld('leftFoot').position);
  const half = make(0.5);
  half.apply(0);
  const full = make(1);
  full.apply(0);
  const restFoot = rest.jointWorld('leftFoot').position;
  const halfDistance = vec3.distance(half.jointWorld('leftFoot').position, restFoot);
  const fullDistance = vec3.distance(full.jointWorld('leftFoot').position, restFoot);
  assert.ok(halfDistance > 0.1 * fullDistance && halfDistance < 0.9 * fullDistance, `${halfDistance} of ${fullDistance}`);
});

test('aim IK points the forward axis at the target', () => {
  const pose = createSkeletonPose({ rig: createRig(), ik: [{ type: 'aim', joint: 'head', forward: [0, 0, 1], target: [3, 1.8, 0] }] });
  pose.apply(0);
  const forward = vec3.transformQuat(new Float64Array(3), [0, 0, 1], pose.jointWorld('head').rotation);
  assertClose(forward, [1, 0, 0], 1e-6);
  assert.equal(pose.ikResults[0].reached, true);
});

test('aim IK respects maxAngle and shares the turn along a chain', () => {
  const limited = createSkeletonPose({ rig: createRig(), ik: [{ type: 'aim', joint: 'head', forward: [0, 0, 1], target: [3, 1.8, 0], maxAngle: 30 }] });
  limited.apply(0);
  const limitedForward = vec3.transformQuat(new Float64Array(3), [0, 0, 1], limited.jointWorld('head').rotation);
  assert.ok(Math.abs(vec3.angle(limitedForward, [0, 0, 1]) - 30 * Math.PI / 180) < 1e-6);
  assert.equal(limited.ikResults[0].reached, false);

  const chain = createSkeletonPose({ rig: createRig(), ik: [{ type: 'aim', joints: ['spine', 'head'], forward: [0, 0, 1], target: [0, 1.8, 3], maxAngle: 180 }] });
  chain.apply(0);
  const shared = createSkeletonPose({ rig: createRig(), ik: [{ type: 'aim', joints: ['spine', 'head'], forward: [0, 0, 1], target: [3, 1.8, 0] }] });
  shared.apply(0);
  const spineTurn = vec3.angle(vec3.transformQuat(new Float64Array(3), [0, 0, 1], shared.jointWorld('spine').rotation), [0, 0, 1]);
  assert.ok(spineTurn > 0.5 && spineTurn < 1, `spine takes about half of the turn: ${spineTurn}`);
});

test('solvers run in order on the pose the previous one left', () => {
  const pose = createSkeletonPose({
    rig: createRig(),
    ik: [
      { type: 'aim', joint: 'spine', forward: [0, 1, 0], target: [1, 2.3, 0] },
      { type: 'two-bone', root: 'leftUpperArm', middle: 'leftLowerArm', end: 'leftHand', target: [0.5, 1.5, 0.3], pole: [0.5, 1, -1] },
    ],
  });
  pose.apply(0);
  assert.ok(pose.ikResults[1].error < 1e-6, `error ${pose.ikResults[1].error}`);
  assertClose(pose.jointWorld('leftHand').position, [0.5, 1.5, 0.3], 1e-6);
});

test('joints resolve by name or humanoid bone, and mistakes say what to pass', () => {
  const rig = createRig();
  const byName = createSkeletonPose({ rig });
  byName.apply(0);
  assert.deepEqual(byName.jointWorld(NAMES.head), byName.jointWorld('head'));
  assert.throws(() => byName.jointWorld('tail'), /joint tail is not in the rig/);
  assert.throws(() => createSkeletonPose(), /needs a skin or a rig/);
  assert.throws(() => createSkeletonPose({ rig, layers: [{}] }), /Layer 0 needs a clip/);
  assert.throws(() => createSkeletonPose({ rig, layers: [{ clip: rotationClip('nothing', 10) }] }), /no clip track names a joint/);
  assert.throws(() => createSkeletonPose({ rig, ik: [{ type: 'fabrik', target: [0, 0, 0] }] }), /type must be two-bone, aim, chain or spline/);
  assert.throws(() => createSkeletonPose({ rig, ik: [{ type: 'two-bone', root: 'leftFoot', middle: 'leftLowerLeg', end: 'leftUpperLeg', target: [0, 0, 0] }] }), /end must descend from middle/);
  assert.throws(() => createSkeletonPose({ rig, ik: [{ type: 'aim', joint: 'head' }] }), /target must be three finite numbers/);
  const badTarget = createSkeletonPose({ rig, ik: [{ type: 'aim', joint: 'head', target: () => [Number.NaN, 0, 0] }] });
  assert.throws(() => badTarget.apply(0), /target must be three finite numbers/);
  assert.throws(() => byName.apply(Number.NaN), /time must be finite/);
});

test('on a skin with real bind matrices, rest is the identity palette and IK moves a bound vertex to the target', () => {
  const rig = createRig();
  const rest = createSkeletonPose({ rig });
  rest.apply(0);
  const skin = createSkinPose(rig.joints.length);
  skin.joints = rig.joints.map(joint => ({ name: joint.name, parent: joint.parent }));
  skin.inverseBindMatrices = new Float32Array(rig.joints.length * 16);
  rig.joints.forEach((joint, index) => {
    const world = mat4.fromTranslation(mat4.create(), rest.jointWorld(joint.name).position);
    skin.inverseBindMatrices.set(mat4.invert(mat4.create(), world), index * 16);
  });
  const resting = createSkeletonPose({ skin, rig });
  resting.apply(0);
  for (let index = 0; index < rig.joints.length; index++) {
    assertClose(skin.jointMatrices.subarray(index * 16, index * 16 + 16), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 1e-5, rig.joints[index].name);
  }
  const target = [0.25, 0.35, 0.3];
  const solved = createSkeletonPose({ skin, rig, ik: [{ type: 'two-bone', root: 'leftUpperLeg', middle: 'leftLowerLeg', end: 'leftFoot', target, pole: [0.1, 0.6, 1] }] });
  solved.apply(0);
  const footIndex = rig.joints.findIndex(joint => joint.name === NAMES.leftFoot);
  const footVertex = vec3.transformMat4(new Float64Array(3), rest.jointWorld('leftFoot').position, skin.jointMatrices.subarray(footIndex * 16, footIndex * 16 + 16));
  assertClose(footVertex, target, 1e-5, 'bound vertex');
});

test('multi-bone chain IK and spline IK solve long chains with pole, poleAngle, stretch, limits and curves', () => {
  const tentacleRig = {
    joints: [
      { name: 'b0', parent: -1, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { name: 'b1', parent: 0, translation: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { name: 'b2', parent: 1, translation: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { name: 'b3', parent: 2, translation: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { name: 'tip', parent: 3, translation: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    ],
  };
  const target = [2.2, 1.4, 0.5];
  const chainPose = createSkeletonPose({
    rig: tentacleRig,
    ik: [{
      type: 'chain',
      chain: ['b0', 'b1', 'b2', 'b3', 'tip'],
      target,
      pole: [1, 3, 0],
      poleAngle: 15,
      iterations: 24,
      limits: { b0: { z: [-80, 80] } },
    }],
  });
  chainPose.apply(0);
  assert.equal(chainPose.ikResults[0].reached, true);
  assertClose(chainPose.jointWorld('tip').position, target, 1e-2);

  // Root and end shorthand + stretch beyond rest length (4.0 m -> 5.0 m).
  const stretchTarget = [5, 0, 0];
  const stretched = createSkeletonPose({
    rig: tentacleRig,
    ik: [{ type: 'chain', root: 'b0', end: 'tip', target: stretchTarget, stretch: 1, weight: 0.5 }],
  });
  stretched.apply(0);
  assertClose(stretched.jointWorld('tip').position, [4.5, 0, 0], 1e-3);

  // Spline IK fits joints along a 4-point curve with and without stretch.
  const curve = [[0, 0, 0], [1.5, 1, 0], [3, 1, 0], [4.5, 0, 0]];
  const splinePose = createSkeletonPose({
    rig: tentacleRig,
    ik: [{ type: 'spline', chain: ['b0', 'b1', 'b2', 'b3', 'tip'], curve, stretch: true }],
  });
  splinePose.apply(0);
  assert.equal(splinePose.ikResults[0].reached, true);
  assertClose(splinePose.jointWorld('tip').position, [4.5, 0, 0], 1e-2);

  const unstretchedSpline = createSkeletonPose({
    rig: tentacleRig,
    ik: [{ type: 'spline', root: 'b0', end: 'tip', curve: () => [[0, 0, 0], [6, 0, 0]], stretch: false, weight: 0.5 }],
  });
  unstretchedSpline.apply(0);
  assertClose(unstretchedSpline.jointWorld('tip').position, [4, 0, 0], 1e-2);

  assert.throws(() => createSkeletonPose({ rig: tentacleRig, ik: [{ type: 'chain', chain: ['b0'], target: [1, 0, 0] }] }), /chain must list 2 to 64 joints/);
  assert.throws(() => createSkeletonPose({ rig: tentacleRig, ik: [{ type: 'chain', target: [1, 0, 0] }] }), /needs chain/);
  assert.throws(() => createSkeletonPose({ rig: tentacleRig, ik: [{ type: 'chain', root: 'b0', end: 'tip', target: [1, 0, 0], poleAngle: 200 }] }), /poleAngle/);
  assert.throws(() => createSkeletonPose({ rig: tentacleRig, ik: [{ type: 'chain', root: 'b0', end: 'tip', target: [1, 0, 0], stretch: 2 }] }), /stretch/);
  assert.throws(() => createSkeletonPose({ rig: tentacleRig, ik: [{ type: 'chain', root: 'b0', end: 'tip', target: [1, 0, 0], iterations: 0 }] }), /iterations/);
  assert.throws(() => createSkeletonPose({ rig: tentacleRig, ik: [{ type: 'spline', root: 'b0', end: 'tip', curve: [[0, 0, 0]] }] }), /curve must be 2 to 64/);
});
