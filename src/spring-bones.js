// Spring bones: secondary motion for hair, tails, ears, straps and other soft parts. The model is the VRM spring bone
// (stiffness, drag, gravity power and direction, hit radius, sphere and capsule colliders on other bones), so settings
// made in VRoid or Blender's Wiggle Bones carry over. Each bone's tail is a point that follows the animated pose like a
// weight on a spring, keeps the bone's length and stays outside the colliders; the bone then turns to aim at it.
//
// The simulation is a Verlet step at a fixed 1/60 s. It remembers the last time it was asked for, so ask for times in
// increasing order (a render or bake does). A step back in time, or a gap over half a second, restarts the chain from
// the animated pose. The same sequence of times gives the same pose, bit for bit.

import { quat, vec3 } from 'gl-matrix';
import { invalidField } from './field-error.js';
import { bounded, denseArray, knownKeys, valueFrom } from './motion-validation.js';

export const SPRING_STEP_SECONDS = 1 / 60;
export const MAX_SPRING_CHAINS = 16;
export const MAX_SPRING_CHAIN_BONES = 16;
export const MAX_SPRING_BONES = 64;
export const MAX_SPRING_COLLIDERS = 16;
const MAX_CATCH_UP_STEPS = 30;
const STEP_ROUNDING = 1e-3;
const NEAR_ZERO = 1e-9;
const DEFAULT_GRAVITY_DIRECTION = Object.freeze([0, -1, 0]);

const CHAIN_FIELDS = ['bones', 'stiffness', 'dragForce', 'gravityPower', 'gravityDir', 'hitRadius', 'tipLength', 'colliders'];
const COLLIDER_FIELDS = ['id', 'bone', 'type', 'offset', 'radius', 'tail'];

function nodeIdIn(value, nodes, label) {
  if (typeof value !== 'string' || !nodes.has(value)) {
    throw invalidField(label, value, 'a node ID in this recipe, such as "tail1"');
  }
  return value;
}

function normalizeCollider(input, position, movableAndVisible) {
  const label = `motion.springs.colliders[${position}]`;
  knownKeys(input, COLLIDER_FIELDS, label);
  if (typeof input.id !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(input.id)) {
    throw invalidField(`${label}.id`, input.id, 'a name of 1 to 64 letters, digits, dots, dashes or underscores that chains list in colliders, such as "head"');
  }
  const type = input.type ?? 'sphere';
  if (type !== 'sphere' && type !== 'capsule') {
    throw invalidField(`${label}.type`, type, 'sphere or capsule');
  }
  if (type === 'sphere' && input.tail !== undefined) {
    throw invalidField(`${label}.tail`, input.tail, 'a field left out on a sphere, since only a capsule has a second end; set type to capsule or drop tail');
  }
  if (type === 'capsule' && input.tail === undefined) {
    throw invalidField(`${label}.tail`, input.tail, 'the capsule\'s second end as [x, y, z] in the bone\'s own space, such as [0, 0.2, 0]');
  }
  const collider = {
    id: input.id,
    bone: nodeIdIn(input.bone, movableAndVisible, `${label}.bone`),
    type,
    offset: input.offset === undefined ? [0, 0, 0] : valueFrom(input.offset, 3, `${label}.offset`),
    radius: bounded(input.radius ?? 0.05, 0.0001, 100, `${label}.radius`),
  };
  if (type === 'capsule') collider.tail = valueFrom(input.tail, 3, `${label}.tail`);
  return collider;
}

function normalizeChain(input, position, nodes, colliderIds) {
  const label = `motion.springs.chains[${position}]`;
  knownKeys(input, CHAIN_FIELDS, label);
  denseArray(input.bones, MAX_SPRING_CHAIN_BONES, `${label}.bones`);
  if (!input.bones.length) {
    throw invalidField(`${label}.bones`, input.bones, 'one to 16 node IDs from the root of the chain to its tip, such as ["tail1", "tail2", "tail3"]');
  }
  const bones = input.bones.map((id, slot) => nodeIdIn(id, nodes, `${label}.bones[${slot}]`));
  if (new Set(bones).size !== bones.length) {
    throw invalidField(`${label}.bones`, bones, 'each bone once');
  }
  const gravityDir = input.gravityDir === undefined ? [...DEFAULT_GRAVITY_DIRECTION] : valueFrom(input.gravityDir, 3, `${label}.gravityDir`);
  if (Math.hypot(...gravityDir) < 1e-6) {
    throw invalidField(`${label}.gravityDir`, gravityDir, 'a direction that is not zero, such as [0, -1, 0]');
  }
  const colliders = input.colliders === undefined ? [] : denseArray(input.colliders, MAX_SPRING_COLLIDERS, `${label}.colliders`);
  for (const id of colliders) {
    if (typeof id !== 'string' || !colliderIds.has(id)) {
      throw invalidField(`${label}.colliders`, id, `an ID listed in motion.springs.colliders${colliderIds.size ? `, such as "${[...colliderIds][0]}"` : ', which is empty: add a collider first'}`);
    }
  }
  return {
    bones,
    stiffness: bounded(input.stiffness ?? 1, 0, 4, `${label}.stiffness`),
    dragForce: bounded(input.dragForce ?? 0.4, 0, 1, `${label}.dragForce`),
    gravityPower: bounded(input.gravityPower ?? 0, 0, 2, `${label}.gravityPower`),
    gravityDir,
    hitRadius: bounded(input.hitRadius ?? 0.02, 0, 10, `${label}.hitRadius`),
    tipLength: bounded(input.tipLength ?? 0.07, 0.001, 100, `${label}.tipLength`),
    colliders: [...colliders],
  };
}

/**
 * Check and complete a `motion.springs` object: { chains: [{ bones, stiffness, dragForce, gravityPower, gravityDir,
 * hitRadius, tipLength, colliders }], colliders: [{ id, bone, type, offset, radius, tail }] }. `movable` holds the node IDs a
 * chain may rotate, `visible` every node a collider may ride on. Returns plain data with every default filled in.
 */
export function normalizeSpringBones(input, { movable, visible, hierarchy }) {
  knownKeys(input, ['chains', 'colliders'], 'motion.springs');
  denseArray(input.chains, MAX_SPRING_CHAINS, 'motion.springs.chains');
  if (!input.chains.length) {
    throw invalidField('motion.springs.chains', input.chains, 'one to 16 chains, such as [{ "bones": ["tail1", "tail2"], "stiffness": 1 }]');
  }
  const colliderInput = input.colliders === undefined ? [] : denseArray(input.colliders, MAX_SPRING_COLLIDERS, 'motion.springs.colliders');
  const colliders = colliderInput.map((collider, position) => normalizeCollider(collider, position, visible));
  const colliderIds = new Set(colliders.map(collider => collider.id));
  if (colliderIds.size !== colliders.length) {
    throw invalidField('motion.springs.colliders', colliders.map(collider => collider.id), 'a different id on each collider');
  }
  const chains = input.chains.map((chain, position) => normalizeChain(chain, position, movable, colliderIds));
  const boneCount = chains.reduce((total, chain) => total + chain.bones.length, 0);
  if (boneCount > MAX_SPRING_BONES) {
    throw invalidField('motion.springs.chains', boneCount, `at most ${MAX_SPRING_BONES} bones in all chains, so shorten or drop chains`);
  }
  const claimed = new Set();
  const parentOf = new Map(hierarchy.map(node => [node.id, node.parent ?? null]));
  chains.forEach((chain, position) => {
    chain.bones.forEach((bone, slot) => {
      if (claimed.has(bone)) {
        throw invalidField(`motion.springs.chains[${position}].bones[${slot}]`, bone, 'a bone that no other chain uses');
      }
      claimed.add(bone);
      if (slot > 0 && parentOf.get(bone) !== chain.bones[slot - 1]) {
        throw invalidField(`motion.springs.chains[${position}].bones[${slot}]`, bone, `the child of ${chain.bones[slot - 1]}, since a chain lists bones from its root to its tip, each parented to the one before`);
      }
    });
  });
  return { chains, colliders };
}

/** Node IDs a spring chain needs in the rig: its bones, the first child of its tip and the nodes colliders ride on. */
export function springChainNodeIds(chain, colliders, hierarchy) {
  const tip = chain.bones[chain.bones.length - 1];
  const tipChild = hierarchy.find(node => node.parent === tip);
  const ids = [...chain.bones];
  if (tipChild) ids.push(tipChild.id);
  for (const id of chain.colliders) ids.push(colliders.find(collider => collider.id === id).bone);
  return ids;
}

function restDirectionOfJoint(prepared, index) {
  const offset = prepared.restTranslations[index];
  const direction = vec3.normalize(new Float64Array(3), offset);
  if (vec3.length(offset) < NEAR_ZERO) vec3.set(direction, 0, 1, 0);
  return direction;
}

/** The `create` function of a custom solver for one spring chain: createSkeletonPose({ ik: [{ type: 'custom', create }] }). */
export function springChainSolver(chain, colliders) {
  return function create(prepared, resolveJoint, label) {
    const joints = chain.bones.map(name => resolveJoint(name, label));
    joints.slice(1).forEach((joint, slot) => {
      if (prepared.joints[joint].parent !== joints[slot]) {
        throw new RangeError(`${label}: bone ${chain.bones[slot + 1]} must be the child of ${chain.bones[slot]}; list a spring chain from its root to its tip.`);
      }
    });
    const gravityDirection = vec3.normalize(new Float64Array(3), chain.gravityDir);
    const tailJoints = joints.map((joint, slot) => {
      if (slot < joints.length - 1) return joints[slot + 1];
      const child = prepared.joints.findIndex(candidate => candidate.parent === joint);
      return child;
    });
    // Where each tail sits in its bone's own frame, and how far from the head, at rest.
    const axes = joints.map((joint, slot) => {
      if (tailJoints[slot] >= 0) return vec3.normalize(new Float64Array(3), prepared.restTranslations[tailJoints[slot]]);
      const parentFrame = restDirectionOfJoint(prepared, joint);
      return vec3.transformQuat(new Float64Array(3), parentFrame, quat.invert(new Float64Array(4), prepared.restRotations[joint]));
    });
    const localLengths = joints.map((joint, slot) => (tailJoints[slot] >= 0 ? vec3.length(prepared.restTranslations[tailJoints[slot]]) : null));
    const colliderBones = chain.colliders.map(id => {
      const collider = colliders.find(candidate => candidate.id === id);
      return { ...collider, joint: resolveJoint(collider.bone, label) };
    });

    const tails = joints.map(() => new Float64Array(3));
    const previousTails = joints.map(() => new Float64Array(3));
    const animatedTails = joints.map(() => new Float64Array(3));
    const animatedRotations = joints.map(() => new Float64Array(4));
    const scratch = {
      center: new Float64Array(3), end: new Float64Array(3), axis: new Float64Array(3),
      offset: new Float64Array(3), nearest: new Float64Array(3), next: new Float64Array(3),
      direction: new Float64Array(3), animatedDirection: new Float64Array(3), rotation: new Float64Array(4), turn: new Float64Array(4),
    };
    let lastStep = null;

    function lengthOf(slot, state) {
      return localLengths[slot] === null ? chain.tipLength : localLengths[slot] * state.scales[joints[slot]];
    }

    function readAnimatedTails(state) {
      joints.forEach((joint, slot) => {
        if (tailJoints[slot] >= 0) {
          animatedTails[slot].set(state.positions[tailJoints[slot]]);
          return;
        }
        const direction = vec3.transformQuat(new Float64Array(3), axes[slot], state.rotations[joint]);
        vec3.scaleAndAdd(animatedTails[slot], state.positions[joint], direction, lengthOf(slot, state));
      });
    }

    function pushOutOfColliders(point, head, state) {
      for (const collider of colliderBones) {
        const scale = state.scales[collider.joint];
        const rotation = state.rotations[collider.joint];
        const center = vec3.transformQuat(scratch.center, collider.offset, rotation);
        vec3.scaleAndAdd(center, state.positions[collider.joint], center, scale);
        const radius = collider.radius * scale + chain.hitRadius;
        let nearest = center;
        if (collider.type === 'capsule') {
          const end = vec3.transformQuat(scratch.end, collider.tail, rotation);
          vec3.scaleAndAdd(end, state.positions[collider.joint], end, scale);
          vec3.subtract(scratch.axis, end, center);
          const lengthSquared = vec3.squaredLength(scratch.axis);
          vec3.subtract(scratch.offset, point, center);
          const along = lengthSquared < NEAR_ZERO ? 0 : Math.min(1, Math.max(0, vec3.dot(scratch.offset, scratch.axis) / lengthSquared));
          nearest = vec3.scaleAndAdd(scratch.nearest, center, scratch.axis, along);
        }
        vec3.subtract(scratch.offset, point, nearest);
        const distance = vec3.length(scratch.offset);
        if (distance >= radius) continue;
        if (distance < NEAR_ZERO) {
          vec3.subtract(scratch.offset, point, head);
        }
        vec3.normalize(scratch.offset, scratch.offset);
        vec3.scaleAndAdd(point, nearest, scratch.offset, radius);
      }
    }

    function stepChain(stepSeconds, context, weight) {
      const { state, prepared: rig, update, setWorldRotation, localRotations } = context;
      joints.forEach((joint, slot) => {
        localRotations[joint].set(animatedRotations[slot]);
      });
      update();
      joints.forEach((joint, slot) => {
        const head = state.positions[joint];
        const parent = rig.joints[joint].parent;
        const parentRotation = parent >= 0 ? state.rotations[parent] : rig.rootRotation;
        const animatedWorld = quat.multiply(scratch.rotation, parentRotation, animatedRotations[slot]);
        const animatedDirection = vec3.transformQuat(scratch.animatedDirection, axes[slot], animatedWorld);
        const length = lengthOf(slot, state);
        const next = scratch.next;
        if (stepSeconds > 0) {
          const current = tails[slot];
          const previous = previousTails[slot];
          const inertia = 1 - chain.dragForce;
          for (let axis = 0; axis < 3; axis++) {
            next[axis] = current[axis]
              + (current[axis] - previous[axis]) * inertia
              + animatedDirection[axis] * chain.stiffness * stepSeconds
              + gravityDirection[axis] * chain.gravityPower * stepSeconds;
          }
        } else {
          next.set(tails[slot]);
        }
        const keepLength = point => {
          vec3.subtract(scratch.direction, point, head);
          if (vec3.length(scratch.direction) < NEAR_ZERO) vec3.copy(scratch.direction, animatedDirection);
          vec3.normalize(scratch.direction, scratch.direction);
          vec3.scaleAndAdd(point, head, scratch.direction, length);
        };
        keepLength(next);
        if (colliderBones.length) {
          pushOutOfColliders(next, head, state);
          keepLength(next);
        }
        if (stepSeconds > 0) previousTails[slot].set(tails[slot]);
        tails[slot].set(next);
        vec3.subtract(scratch.direction, next, head);
        vec3.normalize(scratch.direction, scratch.direction);
        const turn = quat.rotationTo(scratch.turn, animatedDirection, scratch.direction);
        const worldRotation = quat.multiply(new Float64Array(4), turn, animatedWorld);
        setWorldRotation(joint, quat.normalize(worldRotation, worldRotation), weight);
      });
    }

    function solve(time, context, weight) {
      const { state, localRotations, update } = context;
      joints.forEach((joint, slot) => animatedRotations[slot].set(localRotations[joint]));
      readAnimatedTails(state);
      // Time counts in whole steps, so frame times that differ by rounding do not change how many steps run.
      const stepIndex = Math.floor(time / SPRING_STEP_SECONDS + STEP_ROUNDING);
      const steps = lastStep === null ? Number.NaN : stepIndex - lastStep;
      const restart = !(steps >= 0 && steps <= MAX_CATCH_UP_STEPS);
      lastStep = stepIndex;
      if (restart) {
        animatedTails.forEach((tail, slot) => {
          tails[slot].set(tail);
          previousTails[slot].set(tail);
        });
        return { reached: true, error: 0, warnings: [], limited: [] };
      }
      if (steps === 0) {
        stepChain(0, context, weight);
      } else {
        for (let step = 0; step < steps; step++) stepChain(SPRING_STEP_SECONDS, context, weight);
      }
      update();
      return { reached: true, error: 0, warnings: [], limited: [] };
    }

    return { joints, solve };
  };
}
