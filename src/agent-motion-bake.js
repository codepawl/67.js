import { quat } from 'gl-matrix';
import { invalidField } from './field-error.js';
import { bounded, knownKeys } from './motion-validation.js';

// The bake-motion operation: sample the live local transform of chosen nodes (tracks, IK, constraints, drivers and
// physics all included), write it back as keyframe tracks and drop the live sources, so the motion plays from keys alone.

export const BAKE_LIMITS = Object.freeze({ maxNodes: 32, maxSamples: 512, maxKeysPerTrack: 64, defaultStep: 1 / 30, minimumStep: 1 / 120 });
const DEFAULT_TOLERANCE = Object.freeze({ position: 0.001, angle: 0.1 });
const MAX_MOTION_DURATION = 30;
const BAKED_PROPERTIES = ['translation', 'rotation', 'scale'];
const REST_VALUES = { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
// Float noise below this is no movement: a node the bake leaves where it was gets no track.
const STEADY_EPSILON = 1e-6;
const RADIANS_PER_DEGREE = Math.PI / 180;

function roundTime(seconds) {
  return Math.round(seconds * 1e6) / 1e6;
}

function normalizedTolerance(input) {
  if (input === undefined) return null;
  knownKeys(input, ['position', 'angle', 'scale'], 'tolerance');
  const position = bounded(input.position ?? DEFAULT_TOLERANCE.position, 0, 10, 'tolerance.position');
  const angleDegrees = bounded(input.angle ?? DEFAULT_TOLERANCE.angle, 0, 45, 'tolerance.angle');
  const scale = bounded(input.scale ?? position, 0, 10, 'tolerance.scale');
  return { translation: position, rotation: angleDegrees * RADIANS_PER_DEGREE, scale };
}

function normalizedNodeIds(input, candidate) {
  const known = new Map(candidate.nodes.map(node => [node.id, node]));
  const example = JSON.stringify([candidate.nodes.find(node => !node.assetPart)?.id ?? 'crate']);
  if (!Array.isArray(input) || input.length < 1 || input.length > BAKE_LIMITS.maxNodes) {
    throw invalidField('nodes', Array.isArray(input) ? `${input.length} IDs` : input, `a list of 1 to ${BAKE_LIMITS.maxNodes} node IDs, such as ${example}`, Array.isArray(input) ? RangeError : TypeError);
  }
  input.forEach((id, position) => {
    const node = known.get(id);
    if (!node || node.assetPart) {
      throw invalidField(`nodes[${position}]`, id, `the ID of a node you placed, such as ${example}; scene_inspect lists them`);
    }
    if (input.indexOf(id) !== position) {
      throw invalidField(`nodes[${position}]`, id, 'each node ID once');
    }
  });
  return input;
}

/** Validate a bake-motion operation against the scene. `source` describes what the committed scene can sample. */
function normalizedBake(operation, candidate, source) {
  knownKeys(operation, ['type', 'nodes', 'start', 'end', 'step', 'tolerance'], 'operation');
  const ids = normalizedNodeIds(operation.nodes, candidate);
  if (!source.animated) {
    throw invalidField('nodes', ids, 'a scene that already moves: add motion or physics first, since there is nothing to sample yet');
  }
  const naturalEnd = Math.max(source.motionDuration, source.physicsDuration);
  const start = bounded(operation.start ?? 0, 0, MAX_MOTION_DURATION, 'start');
  const end = roundTime(bounded(operation.end ?? Math.min(naturalEnd, MAX_MOTION_DURATION), 0, MAX_MOTION_DURATION, 'end'));
  if (end <= start) {
    throw invalidField('end', end, `a time after start ${start}, up to ${MAX_MOTION_DURATION} seconds, such as ${roundTime(start + 1)}`);
  }
  const step = bounded(operation.step ?? BAKE_LIMITS.defaultStep, BAKE_LIMITS.minimumStep, 1, 'step');
  const sampleCount = Math.ceil((end - start) / step - 1e-9) + 1;
  if (sampleCount > BAKE_LIMITS.maxSamples) {
    throw invalidField('step', step, `a step that gives at most ${BAKE_LIMITS.maxSamples} samples over ${roundTime(end - start)} seconds, so at least ${roundTime((end - start) / (BAKE_LIMITS.maxSamples - 1))}, or a shorter start to end range`);
  }
  return { ids, start, end, step, sampleCount, tolerance: normalizedTolerance(operation.tolerance), toleranceInput: operation.tolerance };
}

function sampleTimes({ start, end, step, sampleCount }) {
  return Array.from({ length: sampleCount }, (_, index) => (index === sampleCount - 1 ? end : roundTime(start + index * step)));
}

/** Per node and property, the values at every sample time. Quaternions keep one sign so interpolation takes the short way. */
function sampledValues(options, source) {
  const times = sampleTimes(options);
  const series = new Map(options.ids.map(id => [id, { translation: [], rotation: [], scale: [] }]));
  for (const time of times) {
    const transforms = source.sampleLocalTransforms(time, options.ids);
    for (const id of options.ids) {
      const transform = transforms.get(id);
      const target = series.get(id);
      for (const property of BAKED_PROPERTIES) {
        const value = Array.from(transform[property]);
        const previous = target[property].at(-1);
        if (property === 'rotation' && previous && quat.dot(previous, value) < 0) {
          value.forEach((component, index) => { value[index] = -component; });
        }
        target[property].push(value);
      }
    }
  }
  return { times, series };
}

function distance(first, second) {
  return Math.hypot(...first.map((component, index) => component - second[index]));
}

function rotationAngle(first, second) {
  return 2 * Math.acos(Math.min(1, Math.abs(quat.dot(first, second))));
}

function difference(property, first, second) {
  return property === 'rotation' ? rotationAngle(first, second) : distance(first, second);
}

function interpolated(property, first, second, progress) {
  if (property === 'rotation') return Array.from(quat.slerp(new Float64Array(4), first, second, progress));
  return first.map((component, index) => component + (second[index] - component) * progress);
}

/** Ramer-Douglas-Peucker over time: keep the sample the kept neighbours miss most until none misses by more than the tolerance. */
function keptIndices(property, times, values, tolerance) {
  const kept = new Set([0, values.length - 1]);
  const pending = [[0, values.length - 1]];
  while (pending.length) {
    const [first, last] = pending.pop();
    let worstIndex = -1;
    let worstError = tolerance;
    for (let index = first + 1; index < last; index++) {
      const progress = (times[index] - times[first]) / (times[last] - times[first]);
      const error = difference(property, interpolated(property, values[first], values[last], progress), values[index]);
      if (error > worstError) {
        worstError = error;
        worstIndex = index;
      }
    }
    if (worstIndex >= 0) {
      kept.add(worstIndex);
      pending.push([first, worstIndex], [worstIndex, last]);
    }
  }
  return [...kept].sort((left, right) => left - right);
}

/** The keyframes of one property, or null when it stays at the node's rest value. */
function keyframesFor(property, times, values, restValue, tolerance) {
  const limit = Math.max(tolerance?.[property] ?? 0, STEADY_EPSILON);
  const steady = values.every(value => difference(property, value, values[0]) <= limit);
  if (steady) {
    return difference(property, values[0], restValue) <= limit ? null : [{ time: times[0], value: values[0] }];
  }
  const indices = tolerance ? keptIndices(property, times, values, limit) : values.map((_, index) => index);
  return indices.map(index => ({ time: times[index], value: values[index] }));
}

function bakedTracks(options, series, times, candidate) {
  const nodes = new Map(candidate.nodes.map(node => [node.id, node]));
  const tracks = [];
  for (const id of options.ids) {
    for (const property of BAKED_PROPERTIES) {
      const restValue = nodes.get(id)[property] ?? REST_VALUES[property];
      const keyframes = keyframesFor(property, times, series.get(id)[property], restValue, options.tolerance);
      if (!keyframes) continue;
      if (keyframes.length > BAKE_LIMITS.maxKeysPerTrack) {
        const advice = options.tolerance ? 'a larger tolerance' : 'a tolerance such as { "position": 0.005, "angle": 0.5 }';
        throw invalidField('tolerance', options.toleranceInput ?? null, `${advice}, or a larger step, since a track holds at most ${BAKE_LIMITS.maxKeysPerTrack} keys and ${id} ${property} needs ${keyframes.length}`);
      }
      tracks.push({ kind: 'node', id, property, interpolation: 'LINEAR', keyframes });
    }
  }
  return tracks;
}

function solverJoints(solver, nodes) {
  if (solver.type === 'two-bone') return [solver.root, solver.middle, solver.end];
  if (solver.type === 'aim') return solver.joints;
  if (solver.chain) return solver.chain;
  const path = [];
  for (let id = solver.end; id !== null && id !== undefined; id = nodes.get(id)?.parent) {
    path.push(id);
    if (id === solver.root) break;
  }
  return path;
}

function physicsNodeIds(physics, candidate) {
  const ids = (physics.bodies ?? []).map(body => body.node);
  if (physics.ragdoll) {
    ids.push(...candidate.nodes.filter(node => node.armature === physics.ragdoll.armature && node.id !== node.armature).map(node => node.id));
  }
  return ids;
}

/** A solver or a physics world moves its nodes together, so a bake that takes some of them must take all. */
function requireWholeGroup(group, kind, remedy, ids) {
  const missing = group.filter(id => !ids.has(id));
  if (missing.length) {
    throw invalidField('nodes', [...ids], `every node the ${kind} moves, so also ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' and more' : ''}; ${remedy}`);
  }
}

/** Remove what drove the baked nodes, so the keys are not applied on top of the live source. */
function dropLiveSources(candidate, idList) {
  const ids = new Set(idList);
  const nodes = new Map(candidate.nodes.map(node => [node.id, node]));
  const { motion, physics } = candidate;
  if (physics) {
    const group = physicsNodeIds(physics, candidate);
    if (group.some(id => ids.has(id))) {
      requireWholeGroup(group, 'physics world', 'bodies collide, so they bake together', ids);
      delete candidate.physics;
    }
  }
  if (!motion) return;
  const solvers = (motion.ik ?? []).filter(solver => {
    const joints = solverJoints(solver, nodes);
    if (!joints.some(id => ids.has(id))) return true;
    requireWholeGroup(joints, `${solver.type} IK solver`, 'its joints bake together', ids);
    return false;
  });
  const remaining = {
    ik: solvers,
    constraints: (motion.constraints ?? []).filter(constraint => !ids.has(constraint.node)),
    drivers: (motion.drivers ?? []).filter(driver => !(driver.target.kind === 'node' && ids.has(driver.target.id))),
  };
  for (const [field, list] of Object.entries(remaining)) {
    if (list.length) motion[field] = list;
    else delete motion[field];
  }
}

function motionHasContent(motion) {
  return Boolean(motion.tracks.length || motion.layers?.length || motion.ik?.length || motion.constraints?.length || motion.drivers?.length || motion.drive);
}

/**
 * Apply one bake-motion operation to a candidate recipe. `source` gives { animated, motionDuration, physicsDuration,
 * sampleLocalTransforms(time, ids) } for the committed scene. Returns { tracks, keyframes } counts for the report.
 */
export function bakeMotion(candidate, operation, source) {
  const options = normalizedBake(operation, candidate, source);
  if (candidate.motion?.loop && options.end > candidate.motion.duration) {
    throw invalidField('end', options.end, `at most the looping motion duration ${candidate.motion.duration}, since a longer bake would change the loop; set the motion loop to false first`);
  }
  dropLiveSources(candidate, options.ids);
  const { times, series } = sampledValues(options, source);
  const tracks = bakedTracks(options, series, times, candidate);
  const baked = new Set(options.ids);
  const motion = candidate.motion ?? { duration: Math.max(options.end, 0.1), loop: false, tracks: [] };
  motion.duration = Math.max(motion.duration, options.end);
  motion.tracks = [
    ...motion.tracks.filter(track => !(track.kind === 'node' && baked.has(track.id) && BAKED_PROPERTIES.includes(track.property))),
    ...tracks,
  ];
  if (motionHasContent(motion)) candidate.motion = motion;
  else delete candidate.motion;
  return { tracks: tracks.length, keyframes: tracks.reduce((total, track) => total + track.keyframes.length, 0) };
}
