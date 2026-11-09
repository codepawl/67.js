import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { FACE_TARGETS, MIXAMO_LIKE, UNREAL_LIKE, humanoidGlb, humanoidJoints, walkTracks } from './fixtures/humanoid-glb.js';

// Two humanoids that disagree on names, leg proportions and the rest pose of the arms (T-pose against a 30 degree A-pose).
// The source walks with each foot planted for half a cycle; the target is retargeted from it through an asset recipe.
const SOURCE_ID = 'ab'.repeat(32);
const TARGET_ID = 'cd'.repeat(32);
const SOURCE_JOINTS = humanoidJoints();
const TARGET_JOINTS = humanoidJoints({ hipsHeight: 1.1, thigh: 0.62, shin: 0.48, armTiltDegrees: 30 });

const parse = bytes => parseGltf(bytes, { maxVertices: 500000 });

async function sourceAsset() {
  const clips = [{ name: 'Walk', duration: 1, tracks: walkTracks(SOURCE_JOINTS) }];
  return parse(humanoidGlb({ names: MIXAMO_LIKE, joints: SOURCE_JOINTS, clips }));
}

async function createTarget(motion, { names = UNREAL_LIKE } = {}) {
  const asset = await parse(humanoidGlb({ names, joints: TARGET_JOINTS, face: true }));
  const recipe = { format: '67js.asset', schemaVersion: 1, assetId: TARGET_ID, ...(motion ? { motion } : {}) };
  const scene = createAgentAssetScene(asset, recipe,{ sources: { [SOURCE_ID]: await sourceAsset() } });
  const part = name => {
    const index = asset.parts.findIndex(candidate => candidate.name === name);
    assert.ok(index >= 0, `no part ${name}`);
    return scene.parts[index];
  };
  return { asset, scene, part };
}

const walkLayer = (extra = {}) => ({ from: { asset: SOURCE_ID, clip: 0 }, ...extra });
const motionOf = (extra = {}, layerExtra = {}) => ({ duration: 1, loop: true, layers: [walkLayer(layerExtra)], ...extra });
const hierarchyOf = target => target.scene.inspect({ kind: 'hierarchy' });

function footPosition(target, side, time) {
  target.scene.sampleMotion(time);
  return Array.from(target.part(`sole_${side}`).matrix.subarray(12, 15));
}

/** Biggest drift of a foot from where each of the given phases starts, in metres. */
function plantedDrift(target, side, phases) {
  let worst = 0;
  for (const phase of phases) {
    const anchor = footPosition(target, side, phase.start);
    for (let time = phase.start; time <= phase.end + 1e-9; time += 1 / 60) {
      const position = footPosition(target, side, Math.min(time, phase.end));
      worst = Math.max(worst, Math.hypot(position[0] - anchor[0], position[1] - anchor[1], position[2] - anchor[2]));
    }
  }
  return worst;
}

test('a walk from one humanoid file plays on another with different names, proportions and rest pose', async () => {
  const target = await createTarget(motionOf());
  const report = hierarchyOf(target);
  assert.equal(report.retargets.length, 1);
  assert.deepEqual(report.retargets[0].from, { asset: SOURCE_ID, clip: 0 });
  assert.deepEqual(report.retargets[0].source.missing, []);
  assert.deepEqual(report.retargets[0].target.missing, []);
  assert.equal(report.retargets[0].target.mapped, 15);
  const early = footPosition(target, 'left', 0.1);
  const later = footPosition(target, 'left', 0.6);
  assert.ok(Math.hypot(later[0] - early[0], later[2] - early[2]) > 0.2, 'the foot travels with the hips');
});

test('a layer from an unavailable clip, or between rigs without humanoid bones, says what is wrong', async () => {
  await assert.rejects(createTarget({ duration: 1, layers: [{ from: { asset: 'ee'.repeat(32), clip: 0 } }] }), /from\.asset: got .*expected the ID of a catalog asset/);
  await assert.rejects(createTarget({ duration: 1, layers: [{ from: { asset: SOURCE_ID, clip: 5 } }] }), /from\.clip: got 5; expected the index of a clip in that asset, from 0 to 0/);
  await assert.rejects(createTarget({ duration: 1, layers: [{ from: { asset: SOURCE_ID, clip: 0 }, clip: 0 }] }), /from: got .*expected from or clip, not both/);
  const broken = await createTarget(undefined, { names: { ...UNREAL_LIKE, leftLowerArm: 'misc', leftHand: 'misc2' } });
  const revision = hierarchyOf(broken).revision;
  assert.throws(() => broken.scene.apply([{ type: 'set-motion', motion: motionOf() }], { expectedRevision: revision }), /not humanoid to the bone map. Missing bones: leftLowerArm/);
});

test('foot lock holds a planted foot within 2 cm where the retargeted walk slides', async () => {
  const settings = { contactHeight: 0.06, contactSpeed: 1.2 };
  const loose = await createTarget(motionOf({}, { scale: 1.25 }));
  const locked = await createTarget(motionOf({ footLock: settings }, { scale: 1.25 }));
  const feet = hierarchyOf(locked).footLock.feet;
  assert.ok(feet.every(foot => foot.phases.length >= 1), JSON.stringify(feet));
  const slide = plantedDrift(loose, 'left', feet[0].phases);
  assert.ok(slide > 0.02, `without the lock the foot slides ${slide}`);
  feet.forEach((foot, slot) => {
    const drift = plantedDrift(locked, ['left', 'right'][slot], foot.phases);
    assert.ok(drift < 0.02, `with the lock the ${foot.bone} slides ${drift}`);
  });
});

test('on a slope the planted sole follows the ground normal', async () => {
  const angle = 10 * Math.PI / 180;
  const normal = [0, Math.cos(angle), -Math.sin(angle)];
  const target = await createTarget(motionOf({ footLock: { contactHeight: 0.06, contactSpeed: 1.2, ground: { height: 0, normal } } }));
  const phase = hierarchyOf(target).footLock.feet[0].phases[0];
  target.scene.sampleMotion((phase.start + phase.end) / 2);
  const sole = target.part('sole_left').matrix;
  const cosine = sole[4] * normal[0] + sole[5] * normal[1] + sole[6] * normal[2];
  const degrees = Math.acos(Math.min(1, cosine)) * 180 / Math.PI;
  assert.ok(degrees < 5, `the sole is ${degrees} degrees off the normal`);
});

test('keyed morph weights blink and open the jaw by target name, and seeking repeats', async () => {
  const motion = {
    duration: 2, loop: false,
    tracks: [
      { kind: 'morph', id: 'eyeBlinkLeft', property: 'weight', keyframes: [{ time: 0.5, value: 0 }, { time: 0.6, value: 1 }, { time: 0.7, value: 0 }] },
      { kind: 'morph', id: 'jawOpen', property: 'weight', interpolation: 'STEP', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 0.5 }] },
      { kind: 'morph', id: 'mouthSmile', property: 'weight', keyframes: [{ time: 0, value: 0, easing: 'easeInQuad' }, { time: 1, value: 1 }] },
    ],
  };
  const target = await createTarget(motion);
  const face = () => Array.from(target.part('Face').morph.weights, weight => Number(weight.toFixed(4)));
  target.scene.sampleMotion(0.6);
  const atBlink = face();
  assert.equal(atBlink[0], 1);
  assert.equal(atBlink[2], 0);
  assert.ok(atBlink[3] > 0 && atBlink[3] < 0.6, `the smile eases in: ${atBlink[3]}`);
  target.scene.sampleMotion(1.5);
  assert.deepEqual(face(), [0, 0, 0.5, 1]);
  target.scene.sampleMotion(0.6);
  assert.deepEqual(face(), atBlink, 'seeking back repeats the earlier weights');
  assert.deepEqual(hierarchyOf(target).morphTargetNames, FACE_TARGETS);
  await assert.rejects(createTarget({ duration: 1, tracks: [{ kind: 'morph', id: 'cheekPuff', property: 'weight', keyframes: [{ time: 0, value: 1 }] }] }), /motion\.tracks\[0\]\.id: got "cheekPuff"; expected the ID of a morph in this recipe; morph targets of this asset: eyeBlinkLeft/);
  await assert.rejects(createTarget({ duration: 1, tracks: [{ kind: 'morph', id: 'jawOpen', property: 'weight', keyframes: [{ time: 0, value: 2 }] }] }), /morph weight from 0 to 1/);
});
