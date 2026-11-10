import { mat4, quat, vec3 } from 'gl-matrix';
import { createAnimationClip, compileAnimationSampler } from './animation.js';
import { updateSkinPose } from './skinning.js';

const SIDES = ['left', 'right'];
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'];
const FINGER_STAGES = ['proximal', 'intermediate', 'distal'];
const SPINE_AND_HEAD_BONES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'];
const LIMB_BONES = ['shoulder', 'upperArm', 'lowerArm', 'hand', 'upperLeg', 'lowerLeg', 'foot', 'toes'];
const ARM_AND_LEG_BONES = new Set(LIMB_BONES);
const REQUIRED_LIMB_BONES = ['upperArm', 'lowerArm', 'hand', 'upperLeg', 'lowerLeg', 'foot'];

function capitalized(word) {
  return word[0].toUpperCase() + word.slice(1);
}

function sidedName(side, bone) {
  return `${side}${capitalized(bone)}`;
}

function buildCanonicalBones() {
  const bones = [...SPINE_AND_HEAD_BONES];
  for (const side of SIDES) {
    for (const limbBone of LIMB_BONES) bones.push(sidedName(side, limbBone));
  }
  for (const side of SIDES) {
    for (const finger of FINGERS) {
      for (const stage of FINGER_STAGES) bones.push(`${side}${capitalized(finger)}${capitalized(stage)}`);
    }
  }
  return Object.freeze(bones);
}

/** Canonical humanoid bone names: body, then limbs per side, then optional fingers. */
export const HUMANOID_BONES = buildCanonicalBones();

/** Bones a rig needs before it counts as humanoid. Chest, neck, shoulders, toes and fingers are optional. */
export const REQUIRED_HUMANOID_BONES = Object.freeze([
  'hips', 'spine', 'head',
  ...SIDES.flatMap(side => REQUIRED_LIMB_BONES.map(bone => sidedName(side, bone))),
]);

const GENERIC_ALIASES = {
  hips: ['hips', 'pelvis', 'hip'],
  spine: ['spine', 'spine01', 'abdomen'],
  chest: ['chest', 'spine1', 'spine02', 'torso'],
  upperChest: ['upperchest', 'spine2', 'spine03'],
  neck: ['neck', 'neck01', 'neck1'],
  head: ['head'],
  shoulder: ['shoulder', 'clavicle', 'collar'],
  upperArm: ['arm', 'upperarm'],
  lowerArm: ['forearm', 'lowerarm'],
  hand: ['hand', 'fist', 'wrist'],
  upperLeg: ['upleg', 'upperleg', 'thigh'],
  lowerLeg: ['leg', 'lowerleg', 'calf', 'shin'],
  foot: ['foot', 'ankle'],
  toes: ['toes', 'toe', 'toebase', 'ball'],
};

// Rigify deform bones number the spine from the pelvis, so the spine names shift by one.
const RIGIFY_SPINE_ALIASES = {
  hips: ['spine'],
  spine: ['spine001'],
  chest: ['spine002'],
  upperChest: ['spine003'],
  neck: ['spine004'],
  head: ['spine006', 'head'],
};

const IGNORED_NAME_WORDS = /^(mixamorig\d*|bip\d*|j|bip|c|def|org|cc|base|armature)$/;
const FINGER_KEY = /^(?:hand|f)?(thumb|index|middle|ring|pinky|little)(proximal|intermediate|distal|\d+)?$/;

function buildAliasLookup(aliasTable) {
  const lookup = new Map();
  for (const [bone, aliases] of Object.entries(aliasTable)) {
    for (const alias of aliases) lookup.set(alias, bone);
  }
  return lookup;
}

const GENERIC_LOOKUP = buildAliasLookup(GENERIC_ALIASES);
const RIGIFY_LOOKUP = buildAliasLookup({ ...GENERIC_ALIASES, ...RIGIFY_SPINE_ALIASES });

function splitNameWords(jointName) {
  const withoutNamespace = jointName.slice(jointName.lastIndexOf(':') + 1);
  const separated = withoutNamespace.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return separated.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function parseJointName(jointName) {
  let side = null;
  const remainingWords = [];
  for (const word of splitNameWords(jointName)) {
    if (word === 'left' || word === 'l') side = 'left';
    else if (word === 'right' || word === 'r') side = 'right';
    else if (!IGNORED_NAME_WORDS.test(word)) remainingWords.push(word);
  }
  return { side, key: remainingWords.join('') };
}

function fingerStageName(stageText) {
  if (!stageText) return null;
  if (FINGER_STAGES.includes(stageText)) return stageText;
  const stageNumber = Number.parseInt(stageText, 10);
  return FINGER_STAGES[stageNumber - 1] ?? null;
}

function canonicalBoneFor(parsed, lookup) {
  const bone = lookup.get(parsed.key);
  if (bone) {
    if (ARM_AND_LEG_BONES.has(bone)) return parsed.side ? sidedName(parsed.side, bone) : null;
    return bone;
  }
  const finger = FINGER_KEY.exec(parsed.key);
  if (!finger || !parsed.side) return null;
  const stage = fingerStageName(finger[2]);
  if (!stage) return null;
  const fingerName = finger[1] === 'pinky' ? 'little' : finger[1];
  return `${parsed.side}${capitalized(fingerName)}${capitalized(stage)}`;
}

/**
 * Match joint names from common humanoid rigs (Mixamo, VRM, Unreal, Rigify/Blender, Quaternius) to canonical bones.
 * Returns the mapping, the joints left unmapped and the required bones that are still missing.
 * `overrides` maps a canonical bone to the joint name that should win.
 */
export function mapHumanoidBones(jointNames, { overrides = {} } = {}) {
  if (!Array.isArray(jointNames) || jointNames.some(name => typeof name !== 'string')) {
    throw new TypeError('Joint names must be an array of strings.');
  }
  const mapping = {};
  for (const [bone, jointName] of Object.entries(overrides)) {
    if (!HUMANOID_BONES.includes(bone)) throw new RangeError(`Unknown humanoid bone in overrides: ${bone}`);
    if (!jointNames.includes(jointName)) throw new RangeError(`Override joint was not found in the rig: ${jointName}`);
    mapping[bone] = jointName;
  }
  const usesRigify = jointNames.some(name => /^def-/i.test(name));
  const lookup = usesRigify ? RIGIFY_LOOKUP : GENERIC_LOOKUP;
  const overriddenJoints = new Set(Object.values(overrides));
  for (const jointName of jointNames) {
    if (overriddenJoints.has(jointName)) continue;
    if (usesRigify && !/^def-/i.test(jointName)) continue;
    const bone = canonicalBoneFor(parseJointName(jointName), lookup);
    if (bone && !Object.hasOwn(mapping, bone)) mapping[bone] = jointName;
  }
  const mappedJoints = new Set(Object.values(mapping));
  return {
    mapping,
    unmapped: jointNames.filter(name => !mappedJoints.has(name)),
    missing: REQUIRED_HUMANOID_BONES.filter(bone => !Object.hasOwn(mapping, bone)),
  };
}

function decomposeMatrix(matrix) {
  const rotationMatrix = mat4.clone(matrix);
  const scale = mat4.getScaling(new Float64Array(3), matrix);
  for (let column = 0; column < 3; column++) {
    for (let row = 0; row < 3; row++) rotationMatrix[column * 4 + row] /= scale[column];
  }
  return {
    translation: Array.from(mat4.getTranslation(new Float64Array(3), matrix)),
    rotation: Array.from(quat.normalize(new Float64Array(4), mat4.getRotation(new Float64Array(4), rotationMatrix))),
    scale: Array.from(scale),
  };
}

/** The inverse of a matrix, or the identity when it has none (a joint authored at zero scale). */
function invertOrIdentity(matrix) {
  return mat4.invert(mat4.create(), matrix) ?? mat4.create();
}

/**
 * Build a rig from an imported skin pose. The bind pose becomes the rest pose.
 * `rootMatrix` is the world matrix of whatever sits above the root joints (for example a scaled Armature node).
 */
export function createRigFromSkin(skin, { rootMatrix = mat4.create() } = {}) {
  if (!skin?.joints || !skin.inverseBindMatrices) throw new TypeError('A skin with joints and inverseBindMatrices is required.');
  const bindWorldMatrices = skin.joints.map((_, index) => invertOrIdentity(skin.inverseBindMatrices.subarray(index * 16, index * 16 + 16)));
  const inverseRoot = invertOrIdentity(rootMatrix);
  const joints = skin.joints.map((joint, index) => {
    const parentWorld = joint.parent >= 0 ? bindWorldMatrices[joint.parent] : rootMatrix;
    const inverseParent = joint.parent >= 0 ? invertOrIdentity(parentWorld) : inverseRoot;
    const local = mat4.multiply(mat4.create(), inverseParent, bindWorldMatrices[index]);
    return { name: joint.name, parent: joint.parent, ...decomposeMatrix(local) };
  });
  return { joints, rootMatrix: Array.from(rootMatrix) };
}

function jointOrder(joints, label) {
  const order = [];
  const visited = new Array(joints.length).fill(0);
  function visit(index) {
    if (visited[index] === 2) return;
    if (visited[index] === 1) throw new RangeError(`${label} rig joints form a cycle.`);
    visited[index] = 1;
    const parent = joints[index].parent;
    if (parent >= 0) visit(parent);
    visited[index] = 2;
    order.push(index);
  }
  for (let index = 0; index < joints.length; index++) visit(index);
  return order;
}

export function validateRigJoints(joints, label) {
  if (!Array.isArray(joints) || !joints.length) throw new TypeError(`${label} rig needs a non-empty joints array.`);
  joints.forEach(joint => {
    const parentIsValid = Number.isInteger(joint.parent) && joint.parent >= -1 && joint.parent < joints.length;
    if (typeof joint.name !== 'string' || !parentIsValid) throw new TypeError(`${label} rig joints need a name and a parent index.`);
    if (joint.translation?.length !== 3 || joint.rotation?.length !== 4) throw new TypeError(`${label} rig joint ${joint.name} needs translation and rotation rest values.`);
  });
}

export function createPoseState(jointCount) {
  const createVectors = (size) => Array.from({ length: jointCount }, () => new Float64Array(size));
  return {
    rotations: createVectors(4),
    positions: createVectors(3),
    scales: new Float64Array(jointCount),
  };
}

function placeJoint(prepared, state, index, localRotation, localTranslation) {
  const parent = prepared.joints[index].parent;
  const parentRotation = parent >= 0 ? state.rotations[parent] : prepared.rootRotation;
  const parentPosition = parent >= 0 ? state.positions[parent] : prepared.rootPosition;
  const parentScale = parent >= 0 ? state.scales[parent] : prepared.rootScale;
  quat.multiply(state.rotations[index], parentRotation, localRotation);
  const offset = vec3.transformQuat(new Float64Array(3), localTranslation, parentRotation);
  vec3.scaleAndAdd(state.positions[index], parentPosition, offset, parentScale);
  state.scales[index] = parentScale * prepared.localScales[index];
}

export function computeWorldPose(prepared, state, localRotations, localTranslations) {
  for (const index of prepared.order) placeJoint(prepared, state, index, localRotations[index], localTranslations[index]);
}

function prepareRig(rig, label, overrides) {
  validateRigJoints(rig?.joints, label);
  const joints = rig.joints;
  const jointNames = joints.map(joint => joint.name);
  if (new Set(jointNames).size !== jointNames.length) throw new RangeError(`${label} rig joint names must be unique.`);
  const { mapping, missing } = rig.mapping ? { mapping: rig.mapping, missing: REQUIRED_HUMANOID_BONES.filter(bone => !rig.mapping[bone]) } : mapHumanoidBones(jointNames, { overrides });
  if (missing.length) {
    const error = new RangeError(`${label} rig is not humanoid. Missing bones: ${missing.join(', ')}. Pass overrides to map them.`);
    error.missingBones = missing;
    throw error;
  }
  const indexByName = new Map(jointNames.map((name, index) => [name, index]));
  const indexByBone = {};
  for (const [bone, jointName] of Object.entries(mapping)) {
    if (!indexByName.has(jointName)) throw new RangeError(`${label} mapping names a joint that is not in the rig: ${jointName}`);
    indexByBone[bone] = indexByName.get(jointName);
  }
  return { ...prepareRigGeometry(rig, label), indexByBone };
}

export function prepareRigGeometry(rig, label) {
  const joints = rig.joints;
  const root = decomposeMatrix(rig.rootMatrix ? Float64Array.from(rig.rootMatrix) : mat4.create());
  const prepared = {
    joints,
    indexByName: new Map(joints.map((joint, index) => [joint.name, index])),
    order: jointOrder(joints, label),
    localScales: joints.map(joint => joint.scale?.[0] ?? 1),
    restRotations: joints.map(joint => quat.normalize(new Float64Array(4), joint.rotation)),
    restTranslations: joints.map(joint => Float64Array.from(joint.translation)),
    rootRotation: Float64Array.from(root.rotation),
    rootPosition: Float64Array.from(root.translation),
    rootScale: root.scale[0],
    restWorld: createPoseState(joints.length),
  };
  computeWorldPose(prepared, prepared.restWorld, prepared.restRotations, prepared.restTranslations);
  return prepared;
}

function hipHeight(prepared) {
  const hipsPosition = prepared.restWorld.positions[prepared.indexByBone.hips];
  const heights = SIDES.map(side => Math.abs(hipsPosition[1] - prepared.restWorld.positions[prepared.indexByBone[sidedName(side, 'foot')]][1]));
  const height = (heights[0] + heights[1]) / 2;
  if (!(height > 0)) throw new RangeError('Rig hips must sit above the feet in the rest pose (+Y up).');
  return height;
}

function selectedBones(sourcePrepared, targetPrepared, requestedBones) {
  const shared = HUMANOID_BONES.filter(bone => bone in sourcePrepared.indexByBone && bone in targetPrepared.indexByBone);
  if (!requestedBones) return shared;
  for (const bone of requestedBones) {
    if (!shared.includes(bone)) throw new RangeError(`Bone is not mapped in both rigs: ${bone}`);
  }
  return shared.filter(bone => requestedBones.includes(bone));
}

function frameTimes(duration, frameRate) {
  const times = [];
  for (let frame = 0; frame / frameRate < duration - 1e-9; frame++) times.push(frame / frameRate);
  times.push(duration);
  return times;
}

export function bindSourceTracks(sampler, sourcePrepared) {
  const bindings = [];
  for (const track of sampler.tracks) {
    const index = sourcePrepared.indexByName.get(track.target);
    if (index === undefined) continue;
    if (track.property === 'rotation' || track.property === 'translation') bindings.push({ index, property: track.property, output: track.output });
  }
  return bindings;
}

function createRetargeter(sourcePrepared, targetPrepared, bones, options) {
  const sourceState = createPoseState(sourcePrepared.joints.length);
  const targetState = createPoseState(targetPrepared.joints.length);
  const sourceRotations = sourcePrepared.restRotations.map(rotation => Float64Array.from(rotation));
  const sourceTranslations = sourcePrepared.restTranslations.map(translation => Float64Array.from(translation));
  const targetRotations = targetPrepared.restRotations.map(rotation => Float64Array.from(rotation));
  const targetTranslations = targetPrepared.restTranslations.map(translation => Float64Array.from(translation));
  const sourceIndexForTarget = new Map(bones.map(bone => [targetPrepared.indexByBone[bone], sourcePrepared.indexByBone[bone]]));
  const sourceHips = sourcePrepared.indexByBone.hips;
  const targetHips = targetPrepared.indexByBone.hips;
  const hipsScale = (hipHeight(targetPrepared) / hipHeight(sourcePrepared)) * options.scale;
  const hipsDriven = sourceIndexForTarget.has(targetHips);

  function worldRotationDelta(sourceIndex) {
    const inverseRest = quat.invert(new Float64Array(4), sourcePrepared.restWorld.rotations[sourceIndex]);
    return quat.multiply(new Float64Array(4), sourceState.rotations[sourceIndex], inverseRest);
  }

  function hipsWorldPosition() {
    const delta = vec3.subtract(new Float64Array(3), sourceState.positions[sourceHips], sourcePrepared.restWorld.positions[sourceHips]);
    if (!options.rootMotion) {
      delta[0] = 0;
      delta[2] = 0;
    }
    return vec3.scaleAndAdd(new Float64Array(3), targetPrepared.restWorld.positions[targetHips], delta, hipsScale);
  }

  function hipsLocalTranslation(index, worldPosition) {
    const parent = targetPrepared.joints[index].parent;
    const parentRotation = parent >= 0 ? targetState.rotations[parent] : targetPrepared.rootRotation;
    const parentPosition = parent >= 0 ? targetState.positions[parent] : targetPrepared.rootPosition;
    const parentScale = parent >= 0 ? targetState.scales[parent] : targetPrepared.rootScale;
    const offset = vec3.subtract(new Float64Array(3), worldPosition, parentPosition);
    vec3.scale(offset, offset, 1 / parentScale);
    return vec3.transformQuat(offset, offset, quat.invert(new Float64Array(4), parentRotation));
  }

  return function retargetFrame(sourceBindings) {
    for (const binding of sourceBindings) {
      const destination = binding.property === 'rotation' ? sourceRotations[binding.index] : sourceTranslations[binding.index];
      destination.set(binding.output);
    }
    computeWorldPose(sourcePrepared, sourceState, sourceRotations, sourceTranslations);
    for (const index of targetPrepared.order) {
      const parent = targetPrepared.joints[index].parent;
      const parentRotation = parent >= 0 ? targetState.rotations[parent] : targetPrepared.rootRotation;
      const sourceIndex = sourceIndexForTarget.get(index);
      if (sourceIndex !== undefined) {
        const animatedWorld = quat.multiply(new Float64Array(4), worldRotationDelta(sourceIndex), targetPrepared.restWorld.rotations[index]);
        quat.multiply(targetRotations[index], quat.invert(new Float64Array(4), parentRotation), animatedWorld);
        quat.normalize(targetRotations[index], targetRotations[index]);
      }
      if (hipsDriven && index === targetHips) targetTranslations[index].set(hipsLocalTranslation(index, hipsWorldPosition()));
      placeJoint(targetPrepared, targetState, index, targetRotations[index], targetTranslations[index]);
    }
    return { rotations: targetRotations, translations: targetTranslations };
  };
}

/**
 * Transfer a humanoid clip from one rig to another with the rest-pose difference method.
 * Each bone's world-space rotation change from the source rest pose is applied to the target rest pose, so T-pose
 * and A-pose rigs, or rigs with different bone axes, end up pointing the same way. Both rigs must face the same direction
 * with +Y up. Hips translation is scaled by the ratio of rest hips heights above the feet.
 * Options: `bones` (canonical names), `rootMotion` (false keeps only the vertical hips motion), `scale`,
 * `frameRate` (resampling rate), `sourceOverrides` and `targetOverrides` (canonical bone to joint name).
 */
export function retargetClip(sourceRig, targetRig, clip, options = {}) {
  const { bones, rootMotion = true, scale = 1, frameRate = 30, sourceOverrides, targetOverrides } = options;
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('Retarget scale must be positive.');
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new RangeError('Retarget frameRate must be positive.');
  const sourcePrepared = prepareRig(sourceRig, 'Source', sourceOverrides);
  const targetPrepared = prepareRig(targetRig, 'Target', targetOverrides);
  const driven = selectedBones(sourcePrepared, targetPrepared, bones);
  const sampler = compileAnimationSampler(clip);
  const sourceBindings = bindSourceTracks(sampler, sourcePrepared);
  const retargetFrame = createRetargeter(sourcePrepared, targetPrepared, driven, { rootMotion, scale });
  const drivenTargetIndices = driven.map(bone => targetPrepared.indexByBone[bone]);
  const hipsIndex = targetPrepared.indexByBone.hips;
  const times = frameTimes(clip.duration, frameRate);
  const rotationKeyframes = drivenTargetIndices.map(() => []);
  const translationKeyframes = [];
  times.forEach(time => {
    sampler.sample(time);
    const pose = retargetFrame(sourceBindings);
    drivenTargetIndices.forEach((jointIndex, slot) => {
      const keyframes = rotationKeyframes[slot];
      const rotation = Array.from(pose.rotations[jointIndex]);
      const previous = keyframes[keyframes.length - 1]?.value;
      if (previous && quat.dot(previous, rotation) < 0) rotation.forEach((_, axis) => { rotation[axis] = -rotation[axis]; });
      keyframes.push({ time, value: rotation });
    });
    if (drivenTargetIndices.includes(hipsIndex)) translationKeyframes.push({ time, value: Array.from(pose.translations[hipsIndex]) });
  });
  const tracks = drivenTargetIndices.map((jointIndex, slot) => ({
    target: targetPrepared.joints[jointIndex].name, property: 'rotation', keyframes: rotationKeyframes[slot],
  }));
  if (translationKeyframes.length) tracks.push({ target: targetPrepared.joints[hipsIndex].name, property: 'translation', keyframes: translationKeyframes });
  return createAnimationClip({ duration: clip.duration, loop: clip.loop, tracks });
}

/**
 * Play a clip on a skin pose. Joint tracks replace the rig's local rest transforms, then the palette is rebuilt.
 * `meshWorldMatrix` defaults to the skin's bind matrix, which is what glTF skins use.
 */
export function createSkinClipPlayer(skin, clip, { rig = createRigFromSkin(skin), meshWorldMatrix = skin.bindMatrix ?? mat4.create() } = {}) {
  validateRigJoints(rig.joints, 'Skin');
  const prepared = prepareRigGeometry(rig, 'Skin');
  const bindMatrix = skin.bindMatrix ?? mat4.create();
  const sampler = compileAnimationSampler(clip);
  const bindings = bindSourceTracks(sampler, prepared);
  const localRotations = prepared.restRotations.map(rotation => Float64Array.from(rotation));
  const localTranslations = prepared.restTranslations.map(translation => Float64Array.from(translation));
  const state = createPoseState(rig.joints.length);
  const jointWorldMatrices = new Float32Array(rig.joints.length * 16);
  const scratch = mat4.create();
  return {
    clip,
    apply(time) {
      sampler.sample(time);
      for (const binding of bindings) {
        (binding.property === 'rotation' ? localRotations : localTranslations)[binding.index].set(binding.output);
      }
      computeWorldPose(prepared, state, localRotations, localTranslations);
      for (let index = 0; index < rig.joints.length; index++) {
        const worldScale = vec3.fromValues(state.scales[index], state.scales[index], state.scales[index]);
        mat4.fromRotationTranslationScale(scratch, state.rotations[index], state.positions[index], worldScale);
        jointWorldMatrices.set(scratch, index * 16);
      }
      updateSkinPose(skin, jointWorldMatrices, skin.inverseBindMatrices, meshWorldMatrix, bindMatrix);
      return skin;
    },
  };
}

function createRandomGenerator(seed) {
  let state = seed >>> 0;
  return function nextRandom() {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function gridPositions(count, spacing, columns) {
  const rows = Math.ceil(count / columns);
  return Array.from({ length: count }, (_, index) => [
    (index % columns - (columns - 1) / 2) * spacing,
    0,
    (Math.floor(index / columns) - (rows - 1) / 2) * spacing,
  ]);
}

function scatterPositions(count, spacing, size, nextRandom) {
  const positions = [];
  const minimumDistance = spacing * 0.75;
  for (let index = 0; index < count; index++) {
    let candidate;
    for (let attempt = 0; attempt < 40; attempt++) {
      candidate = [(nextRandom() - 0.5) * size, 0, (nextRandom() - 0.5) * size];
      const clear = positions.every(other => Math.hypot(other[0] - candidate[0], other[2] - candidate[2]) >= minimumDistance);
      if (clear) break;
    }
    positions.push(candidate);
  }
  return positions;
}

/**
 * Deterministic crowd placement and timing for one clip. Every instance gets a time offset, a playback rate near 1
 * and a yaw. `sample(seconds)` returns each instance's clip time and sampled tracks (buffers are reused per call).
 * Options: `count`, `clip`, `seed`, `layout` ('grid' or 'scatter'), `spacing`, `columns`, `size` (scatter side),
 * `rateJitter` (fraction), `randomYaw`.
 */
export function createCrowd({ count, clip, seed = 1, layout = 'grid', spacing = 1.5, columns, size, rateJitter = 0.15, randomYaw = false } = {}) {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('Crowd count must be a positive integer.');
  if (!clip?.tracks) throw new TypeError('A clip is required.');
  if (!['grid', 'scatter'].includes(layout)) throw new RangeError(`Unknown crowd layout: ${layout}`);
  if (!Number.isFinite(spacing) || spacing <= 0) throw new RangeError('Crowd spacing must be positive.');
  if (!Number.isFinite(rateJitter) || rateJitter < 0 || rateJitter >= 1) throw new RangeError('rateJitter must be at least 0 and below 1.');
  const nextRandom = createRandomGenerator(seed);
  const columnCount = columns ?? Math.ceil(Math.sqrt(count));
  const positions = layout === 'grid'
    ? gridPositions(count, spacing, columnCount)
    : scatterPositions(count, spacing, size ?? Math.sqrt(count) * spacing * 1.5, nextRandom);
  const instances = positions.map((position, index) => {
    const timeOffset = nextRandom() * clip.duration;
    const playbackRate = 1 + (nextRandom() * 2 - 1) * rateJitter;
    const yawRadians = randomYaw ? nextRandom() * Math.PI * 2 : 0;
    const matrix = mat4.fromRotationTranslation(new Float32Array(16), quat.setAxisAngle(new Float64Array(4), [0, 1, 0], yawRadians), position);
    return Object.freeze({ index, position, yawRadians, timeOffset, playbackRate, matrix });
  });
  const samplers = instances.map(() => compileAnimationSampler(clip));
  function clipTime(index, seconds) {
    const instance = instances[index];
    return instance.timeOffset + seconds * instance.playbackRate;
  }
  return {
    instances: Object.freeze(instances),
    clipTime,
    sample(seconds) {
      return instances.map((instance, index) => {
        const time = clipTime(index, seconds);
        return { instance, time, tracks: samplers[index].sample(time) };
      });
    },
  };
}
