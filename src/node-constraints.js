import { mat3, mat4, quat, vec3 } from 'gl-matrix';
import { compileMotionExpression } from './motion-expression.js';
import { bounded, denseArray, knownKeys, valueFrom } from './motion-validation.js';
import { eulerFromQuaternion, quaternionFromEuler } from './rotation-euler.js';

// Node constraints and drivers, evaluated in this order for any time, with no state kept between calls:
//   1. Base pose: the node values after tracks and IK.
//   2. Drivers, in list order. They read the base pose, so one driver never sees another's result.
//   3. Constraints, in list order. Each reads the pose the ones before it left, including its target's constrained pose.
// Seeking to a time therefore gives the same pose as playing up to it. Constraints act on a node's world matrix and
// keep Blender's meaning: Euler angles are XYZ in degrees, copy and limit work per axis, influence blends the matrix
// before and after, and child_of multiplies the owner by the target's matrix and an inverse.

export const MAX_CONSTRAINTS = 32;
export const MAX_DRIVERS = 32;
const AXES = ['x', 'y', 'z'];
const SIGNED_AXES = ['+x', '-x', '+y', '-y', '+z', '-z'];
const TO_RADIANS = Math.PI / 180;
const NEAR_ZERO = 1e-9;
const MAX_COORDINATE = 1e6;
const SPACES = ['world', 'local'];
const MATERIAL_SCALARS = ['emission', 'metallic', 'roughness'];
const MATERIAL_VECTORS = ['color', 'emissiveColor'];

const COMMON_FIELDS = ['type', 'node', 'influence'];
const CONSTRAINT_FIELDS = {
  copy_location: ['target', 'axes', 'invert', 'offset', 'space'],
  copy_rotation: ['target', 'axes', 'invert', 'mix', 'space'],
  copy_scale: ['target', 'axes', 'offset', 'space'],
  limit_location: ['x', 'y', 'z', 'space'],
  limit_rotation: ['x', 'y', 'z', 'space'],
  track_to: ['target', 'trackAxis', 'upAxis', 'worldUp'],
  child_of: ['target', 'inverse'],
  floor: ['target', 'axis', 'offset', 'useRotation'],
  copy_transforms: ['target', 'mix'],
  limit_distance: ['target', 'distance', 'mode'],
  limit_scale: ['x', 'y', 'z', 'space'],
  stretch_to: ['target', 'restLength', 'volume', 'bulge', 'worldUp'],
  locked_track: ['target', 'trackAxis', 'lockAxis'],
  transformation: ['target', 'source', 'destination', 'map', 'fromMin', 'fromMax', 'toMin', 'toMax', 'mix', 'space'],
  action: ['target', 'source', 'axis', 'min', 'max', 'destination', 'keys', 'space'],
  maintain_volume: ['freeAxis', 'volume', 'space'],
  damped_track: ['target', 'trackAxis'],
  pivot: ['target', 'offset'],
  follow_path: ['points', 'closed', 'followCurve', 'forwardAxis', 'upAxis', 'offset', 'duration'],
  clamp_to: ['points', 'mainAxis', 'cyclic'],
  shrinkwrap: ['target', 'mode', 'projectAxis', 'distance'],
  armature: ['targets'],
};
const PROPERTIES = ['translation', 'rotation', 'scale'];
const MAX_ACTION_KEYS = 16;
export const CONSTRAINT_TYPES = Object.freeze(Object.keys(CONSTRAINT_FIELDS));

// ---------------------------------------------------------------------------------------------------------------
// Input

function axisList(value, label) {
  if (value === undefined) return [...AXES];
  denseArray(value, 3, label);
  if (!value.length || value.some(axis => !AXES.includes(axis)) || new Set(value).size !== value.length) {
    throw new RangeError(`${label} must list distinct axes from x, y and z.`);
  }
  return [...value];
}

function oneOf(value, allowed, fallback, label) {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) throw new RangeError(`${label} must be one of ${allowed.join(', ')}.`);
  return value;
}

function axisRanges(input, limit, label) {
  const ranges = {};
  for (const axis of AXES) {
    if (input[axis] === undefined) continue;
    const range = valueFrom(input[axis], 2, `${label} ${axis}`);
    if (range[0] > range[1] || Math.abs(range[0]) > limit || Math.abs(range[1]) > limit) {
      throw new RangeError(`${label} ${axis} must be [min, max] within ${-limit} and ${limit}, min first.`);
    }
    ranges[axis] = range;
  }
  if (!Object.keys(ranges).length) throw new RangeError(`${label} needs an x, y or z range.`);
  return ranges;
}

function influenceFrom(value, nodeIds, label) {
  if (value === undefined) return 1;
  if (typeof value === 'number') return bounded(value, 0, 1, `${label} influence`);
  compileMotionExpression(value, nodeIds, `${label} influence`);
  return structuredClone(value);
}

const ARGUMENT_TYPES = ['copy_transforms', 'limit_distance', 'limit_scale', 'stretch_to', 'locked_track', 'transformation', 'action', 'maintain_volume', 'damped_track', 'pivot', 'follow_path', 'clamp_to', 'shrinkwrap', 'armature'];

// The newer types may carry their own fields in `args`, so the MCP schema stays small; they merge into the flat shape.
function withArguments(input, label) {
  if (!input || input.args === undefined || !ARGUMENT_TYPES.includes(input.type)) return input;
  knownKeys(input.args, ['influence', ...CONSTRAINT_FIELDS[input.type]], `${label} args`);
  const { args, ...rest } = input;
  const clash = Object.keys(args).find(key => Object.hasOwn(rest, key));
  if (clash) throw new RangeError(`${label} gives ${clash} both directly and in args.`);
  return { ...rest, ...args };
}

function normalizeConstraint(rawInput, position, movableIds, visibleIds) {
  const label = `Motion constraint ${position}`;
  const input = withArguments(rawInput, label);
  if (!input || !Object.hasOwn(CONSTRAINT_FIELDS, input.type)) {
    throw new RangeError(`${label} type must be one of ${CONSTRAINT_TYPES.join(', ')}.`);
  }
  knownKeys(input, [...COMMON_FIELDS, ...CONSTRAINT_FIELDS[input.type]], label);
  if (!movableIds.has(input.node)) throw new RangeError(`${label} node must be a node ID in this recipe; got ${JSON.stringify(input.node)}.`);
  const result = { type: input.type, node: input.node, influence: influenceFrom(input.influence, visibleIds, label) };
  if (CONSTRAINT_FIELDS[input.type].includes('target') && (input.type !== 'pivot' || input.target !== undefined)) {
    if (!visibleIds.has(input.target)) throw new RangeError(`${label} target must be a node ID in this recipe; got ${JSON.stringify(input.target)}.`);
    if (input.target === input.node) throw new RangeError(`${label} target cannot be the constrained node itself.`);
    result.target = input.target;
  }
  if (CONSTRAINT_FIELDS[input.type].includes('space')) result.space = oneOf(input.space, SPACES, 'world', `${label} space`);
  switch (input.type) {
    case 'copy_location':
    case 'copy_rotation':
    case 'copy_scale':
      result.axes = axisList(input.axes, `${label} axes`);
      if (input.invert !== undefined) {
        if (input.type === 'copy_scale') throw new TypeError(`${label} does not take invert.`);
        result.invert = axisList(input.invert, `${label} invert`);
      }
      if (input.offset !== undefined) {
        if (typeof input.offset !== 'boolean' || input.type === 'copy_rotation') throw new TypeError(`${label} offset must be a boolean on copy_location and copy_scale.`);
        result.offset = input.offset;
      }
      if (input.type === 'copy_rotation') result.mix = oneOf(input.mix, ['replace', 'add'], 'replace', `${label} mix`);
      break;
    case 'limit_location':
      Object.assign(result, axisRanges(input, MAX_COORDINATE, label));
      break;
    case 'limit_rotation':
      Object.assign(result, axisRanges(input, 180, label));
      break;
    case 'track_to': {
      result.trackAxis = oneOf(input.trackAxis, SIGNED_AXES, '-z', `${label} trackAxis`);
      result.upAxis = oneOf(input.upAxis, AXES, 'y', `${label} upAxis`);
      if (result.trackAxis.slice(1) === result.upAxis) throw new RangeError(`${label} trackAxis and upAxis must be different axes.`);
      result.worldUp = input.worldUp === undefined ? [0, 1, 0] : valueFrom(input.worldUp, 3, `${label} worldUp`);
      if (vec3.length(result.worldUp) < NEAR_ZERO) throw new RangeError(`${label} worldUp cannot be zero.`);
      break;
    }
    case 'child_of':
      result.inverse = oneOf(input.inverse, ['rest', 'none'], 'rest', `${label} inverse`);
      break;
    case 'floor':
      result.axis = oneOf(input.axis, SIGNED_AXES, '+y', `${label} axis`);
      result.offset = input.offset === undefined ? 0 : bounded(input.offset, -MAX_COORDINATE, MAX_COORDINATE, `${label} offset`);
      if (input.useRotation !== undefined) {
        if (typeof input.useRotation !== 'boolean') throw new TypeError(`${label} useRotation must be a boolean.`);
        result.useRotation = input.useRotation;
      }
      break;
    default:
      normalizeExtraConstraint(input, result, label, visibleIds);
  }
  return result;
}

function curvePathPoints(points, label) {
  denseArray(points, 64, `${label} points`);
  if (points.length < 2) throw new RangeError(`${label} points needs at least 2 points.`);
  return points.map((point, index) => valueFrom(point, 3, `${label} points[${index}]`));
}

function normalizeExtraConstraint(input, result, label, visibleIds) {
  switch (input.type) {
    case 'copy_transforms':
      result.mix = oneOf(input.mix, ['replace', 'before', 'after'], 'replace', `${label} mix`);
      break;
    case 'limit_distance':
      result.distance = bounded(input.distance, 0, MAX_COORDINATE, `${label} distance`);
      result.mode = oneOf(input.mode, ['inside', 'outside', 'surface'], 'inside', `${label} mode`);
      break;
    case 'limit_scale':
      Object.assign(result, axisRanges(input, MAX_COORDINATE, label));
      for (const axis of AXES) {
        if (result[axis] && !(result[axis][0] > 0)) throw new RangeError(`${label} ${axis} minimum must be above 0.`);
      }
      break;
    case 'stretch_to':
      result.restLength = input.restLength === undefined ? 0 : bounded(input.restLength, 0, MAX_COORDINATE, `${label} restLength`);
      result.volume = oneOf(input.volume, ['xz', 'x', 'z', 'none'], 'xz', `${label} volume`);
      result.bulge = input.bulge === undefined ? 1 : bounded(input.bulge, 0, 4, `${label} bulge`);
      result.worldUp = input.worldUp === undefined ? [0, 1, 0] : valueFrom(input.worldUp, 3, `${label} worldUp`);
      if (vec3.length(result.worldUp) < NEAR_ZERO) throw new RangeError(`${label} worldUp cannot be zero.`);
      break;
    case 'locked_track':
      result.trackAxis = oneOf(input.trackAxis, SIGNED_AXES, '+y', `${label} trackAxis`);
      result.lockAxis = oneOf(input.lockAxis, AXES, 'z', `${label} lockAxis`);
      if (result.trackAxis.slice(1) === result.lockAxis) throw new RangeError(`${label} trackAxis and lockAxis must be different axes.`);
      break;
    case 'transformation':
      result.source = oneOf(input.source, PROPERTIES, 'translation', `${label} source`);
      result.destination = oneOf(input.destination, PROPERTIES, 'translation', `${label} destination`);
      result.map = input.map === undefined ? [...AXES] : denseArray(input.map, 3, `${label} map`);
      if (result.map.length !== 3 || result.map.some(axis => !AXES.includes(axis))) throw new RangeError(`${label} map needs three axes from x, y and z, one per destination axis.`);
      for (const [field, fallback] of [['fromMin', 0], ['fromMax', 1], ['toMin', 0], ['toMax', 1]]) {
        result[field] = input[field] === undefined ? [fallback, fallback, fallback] : valueFrom(input[field], 3, `${label} ${field}`);
      }
      if (result.fromMin.some((value, index) => value === result.fromMax[index])) throw new RangeError(`${label} fromMax must differ from fromMin on every axis.`);
      result.mix = oneOf(input.mix, ['replace', 'add', 'multiply'], 'replace', `${label} mix`);
      if (result.mix === 'multiply' && result.destination !== 'scale') throw new RangeError(`${label} mix multiply is only for scale destination.`);
      break;
    case 'maintain_volume':
      result.freeAxis = oneOf(input.freeAxis, AXES, 'y', `${label} freeAxis`);
      result.volume = input.volume === undefined ? 1 : bounded(input.volume, 0.001, 1000, `${label} volume`);
      break;
    case 'damped_track':
      result.trackAxis = oneOf(input.trackAxis, SIGNED_AXES, '+y', `${label} trackAxis`);
      break;
    case 'pivot':
      result.offset = input.offset === undefined ? [0, 0, 0] : valueFrom(input.offset, 3, `${label} offset`);
      break;
    case 'follow_path':
      result.points = curvePathPoints(input.points, label);
      if (input.closed !== undefined && typeof input.closed !== 'boolean') throw new TypeError(`${label} closed must be a boolean.`);
      if (input.followCurve !== undefined && typeof input.followCurve !== 'boolean') throw new TypeError(`${label} followCurve must be a boolean.`);
      result.closed = input.closed ?? false;
      result.followCurve = input.followCurve ?? false;
      result.forwardAxis = oneOf(input.forwardAxis, SIGNED_AXES, '-z', `${label} forwardAxis`);
      result.upAxis = oneOf(input.upAxis, AXES, 'y', `${label} upAxis`);
      if (result.forwardAxis.slice(1) === result.upAxis) throw new RangeError(`${label} forwardAxis and upAxis must be different axes.`);
      result.offset = input.offset === undefined ? 0 : bounded(input.offset, -MAX_COORDINATE, MAX_COORDINATE, `${label} offset`);
      result.duration = input.duration === undefined ? 1 : bounded(input.duration, 0.001, MAX_COORDINATE, `${label} duration`);
      break;
    case 'clamp_to':
      result.points = curvePathPoints(input.points, label);
      result.mainAxis = oneOf(input.mainAxis, ['auto', ...AXES], 'auto', `${label} mainAxis`);
      if (input.cyclic !== undefined && typeof input.cyclic !== 'boolean') throw new TypeError(`${label} cyclic must be a boolean.`);
      result.cyclic = input.cyclic ?? false;
      break;
    case 'shrinkwrap':
      result.mode = oneOf(input.mode, ['nearest', 'project', 'surface'], 'nearest', `${label} mode`);
      result.projectAxis = oneOf(input.projectAxis, SIGNED_AXES, '-y', `${label} projectAxis`);
      result.distance = input.distance === undefined ? 0 : bounded(input.distance, -MAX_COORDINATE, MAX_COORDINATE, `${label} distance`);
      break;
    case 'armature':
      denseArray(input.targets, 8, `${label} targets`);
      if (!input.targets.length) throw new RangeError(`${label} targets needs at least 1 target.`);
      result.targets = input.targets.map((entry, index) => {
        knownKeys(entry, ['target', 'weight'], `${label} targets[${index}]`);
        if (!visibleIds.has(entry.target)) throw new RangeError(`${label} targets[${index}] target must be a node ID in this recipe; got ${JSON.stringify(entry.target)}.`);
        if (entry.target === input.node) throw new RangeError(`${label} target cannot be the constrained node itself.`);
        return { target: entry.target, weight: entry.weight === undefined ? 1 : bounded(entry.weight, 0, 1, `${label} targets[${index}] weight`) };
      });
      break;
    default:
      normalizeActionConstraint(input, result, label);
  }
}

function normalizeActionConstraint(input, result, label) {
  result.source = oneOf(input.source, PROPERTIES, 'translation', `${label} source`);
  result.destination = oneOf(input.destination, PROPERTIES, 'translation', `${label} destination`);
  result.axis = oneOf(input.axis, AXES, 'x', `${label} axis`);
  result.min = bounded(input.min, -MAX_COORDINATE, MAX_COORDINATE, `${label} min`);
  result.max = bounded(input.max, -MAX_COORDINATE, MAX_COORDINATE, `${label} max`);
  if (!(result.min < result.max)) throw new RangeError(`${label} min must be below max.`);
  denseArray(input.keys, MAX_ACTION_KEYS, `${label} keys`);
  if (input.keys.length < 2) throw new RangeError(`${label} keys needs at least 2 keys.`);
  result.keys = input.keys.map((key, index) => {
    knownKeys(key, ['at', 'value'], `${label} key ${index}`);
    return { at: bounded(key.at, 0, 1, `${label} key ${index} at`), value: valueFrom(key.value, 3, `${label} key ${index} value`) };
  });
  if (result.keys.some((key, index) => index && key.at <= result.keys[index - 1].at)) throw new RangeError(`${label} keys must have rising at values.`);
}

/** Validate a constraint list against the node IDs a motion may move and the ones it may read. Returns plain data. */
export function normalizeConstraints(input, movableIds, visibleIds) {
  denseArray(input, MAX_CONSTRAINTS, 'Motion constraints');
  return input.map((constraint, position) => normalizeConstraint(constraint, position, movableIds, visibleIds));
}

function normalizeDriver(input, position, movableIds, materialIds, visibleIds) {
  const label = `Motion driver ${position}`;
  knownKeys(input, ['target', 'expression'], label);
  knownKeys(input.target, ['kind', 'id', 'property', 'component'], `${label} target`);
  const { kind, id, property, component } = input.target;
  if (component !== undefined && !AXES.includes(component)) throw new RangeError(`${label} component must be x, y or z.`);
  if (kind === 'node') {
    if (!movableIds.has(id)) throw new RangeError(`${label} node must be a node ID in this recipe; got ${JSON.stringify(id)}.`);
    if (!['translation', 'rotation', 'scale'].includes(property)) throw new RangeError(`${label} property must be translation, rotation or scale.`);
    if (component === undefined) throw new RangeError(`${label} needs a component: x, y or z. Rotation is Euler XYZ in degrees.`);
  } else if (kind === 'material') {
    if (!materialIds.has(id)) throw new RangeError(`${label} material was not found: ${JSON.stringify(id)}.`);
    const isVector = MATERIAL_VECTORS.includes(property);
    if (!isVector && !MATERIAL_SCALARS.includes(property)) throw new RangeError(`${label} property must be one of ${[...MATERIAL_VECTORS, ...MATERIAL_SCALARS].join(', ')}.`);
    if (isVector !== (component !== undefined)) throw new RangeError(`${label}: color properties need a component (x, y, z for red, green, blue); the others take none.`);
  } else {
    throw new RangeError(`${label} target kind must be node or material.`);
  }
  compileMotionExpression(input.expression, visibleIds, `${label} expression`);
  return { target: { kind, id, property, ...(component === undefined ? {} : { component }) }, expression: structuredClone(input.expression) };
}

export function normalizeDrivers(input, movableIds, materialIds, visibleIds) {
  denseArray(input, MAX_DRIVERS, 'Motion drivers');
  const seen = new Set();
  return input.map((driver, position) => {
    const normalized = normalizeDriver(driver, position, movableIds, materialIds, visibleIds);
    const identity = JSON.stringify(Object.values(normalized.target));
    if (seen.has(identity)) throw new RangeError(`Motion driver ${position} drives the same property as an earlier driver.`);
    seen.add(identity);
    return normalized;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Matrices and frames. A frame is { translation, rotation, scale }.

// gl-matrix's getRotation divides the wrong entries by the scale, so non-uniform scale gives a wrong rotation.
function rotationOfMatrix(matrix, scale) {
  const axes = [0, 4, 8].map((start, column) => Array.from(matrix.slice(start, start + 3), component => component / (scale[column] || 1)));
  return quat.normalize(new Float64Array(4), quat.fromMat3(new Float64Array(4), axes.flat()));
}

function decompose(matrix) {
  const scale = mat4.getScaling(new Float64Array(3), matrix);
  return { translation: mat4.getTranslation(new Float64Array(3), matrix), rotation: rotationOfMatrix(matrix, scale), scale };
}

function compose(frame) {
  return mat4.fromRotationTranslationScale(new Float64Array(16), frame.rotation, frame.translation, frame.scale);
}

function copyFrame(frame) {
  return { translation: Float64Array.from(frame.translation), rotation: Float64Array.from(frame.rotation), scale: Float64Array.from(frame.scale) };
}

/** Blend two world matrices the way Blender blends a constraint's influence: location, rotation and scale separately. */
function blendMatrices(before, after, influence) {
  if (influence >= 1) return after;
  const from = decompose(before);
  const to = decompose(after);
  return compose({
    translation: vec3.lerp(new Float64Array(3), from.translation, to.translation, influence),
    rotation: quat.slerp(new Float64Array(4), from.rotation, to.rotation, influence),
    scale: vec3.lerp(new Float64Array(3), from.scale, to.scale, influence),
  });
}

function signOf(axis) {
  return axis.startsWith('-') ? -1 : 1;
}

function axisIndex(axis) {
  return AXES.indexOf(axis.replace(/^[+-]/, ''));
}

// ---------------------------------------------------------------------------------------------------------------
// Constraint operators on frames (copy and limit) and on matrices (track_to, child_of, floor).

function copyLocation(owner, target, constraint) {
  for (const axis of constraint.axes) {
    const index = axisIndex(axis);
    const sign = constraint.invert?.includes(axis) ? -1 : 1;
    owner.translation[index] = (constraint.offset ? owner.translation[index] : 0) + sign * target.translation[index];
  }
}

function copyRotation(owner, target, constraint) {
  const angles = eulerFromQuaternion(owner.rotation);
  const wanted = eulerFromQuaternion(target.rotation);
  for (const axis of constraint.axes) {
    const index = axisIndex(axis);
    const sign = constraint.invert?.includes(axis) ? -1 : 1;
    angles[index] = (constraint.mix === 'add' ? angles[index] : 0) + sign * wanted[index];
  }
  quaternionFromEuler(owner.rotation, angles[0], angles[1], angles[2]);
}

function copyScale(owner, target, constraint) {
  for (const axis of constraint.axes) {
    const index = axisIndex(axis);
    owner.scale[index] = (constraint.offset ? owner.scale[index] : 1) * target.scale[index];
  }
}

function limitLocation(owner, target, constraint) {
  for (const axis of AXES) {
    if (!constraint[axis]) continue;
    const index = axisIndex(axis);
    owner.translation[index] = Math.min(constraint[axis][1], Math.max(constraint[axis][0], owner.translation[index]));
  }
}

function limitRotation(owner, target, constraint) {
  const angles = eulerFromQuaternion(owner.rotation);
  for (const axis of AXES) {
    if (!constraint[axis]) continue;
    const index = axisIndex(axis);
    angles[index] = Math.min(constraint[axis][1] * TO_RADIANS, Math.max(constraint[axis][0] * TO_RADIANS, angles[index]));
  }
  quaternionFromEuler(owner.rotation, angles[0], angles[1], angles[2]);
}

function limitScale(owner, target, constraint) {
  for (const axis of AXES) {
    if (!constraint[axis]) continue;
    const index = axisIndex(axis);
    owner.scale[index] = Math.min(constraint[axis][1], Math.max(constraint[axis][0], owner.scale[index]));
  }
}

/** A frame's translation, scale or Euler rotation (degrees) as three numbers. */
function channelOf(frame, property) {
  return property === 'rotation' ? eulerFromQuaternion(frame.rotation).map(radians => radians / TO_RADIANS) : Array.from(frame[property]);
}

function writeChannel(frame, property, values) {
  if (property === 'rotation') {
    const [x, y, z] = values.map(degrees => degrees * TO_RADIANS);
    quaternionFromEuler(frame.rotation, x, y, z);
  } else {
    frame[property].set(values);
  }
}

function transformation(owner, target, constraint) {
  const source = channelOf(target, constraint.source);
  const result = channelOf(owner, constraint.destination);
  constraint.map.forEach((sourceAxis, index) => {
    const from = axisIndex(sourceAxis);
    const fraction = (source[from] - constraint.fromMin[from]) / (constraint.fromMax[from] - constraint.fromMin[from]);
    const clamped = Math.min(1, Math.max(0, fraction));
    const mapped = constraint.toMin[index] + clamped * (constraint.toMax[index] - constraint.toMin[index]);
    if (constraint.mix === 'add') result[index] += mapped;
    else if (constraint.mix === 'multiply') result[index] *= mapped;
    else result[index] = mapped;
  });
  writeChannel(owner, constraint.destination, result);
}

function maintainVolume(owner, target, constraint) {
  const freeIndex = axisIndex(constraint.freeAxis);
  const freeScale = Math.max(NEAR_ZERO, owner.scale[freeIndex]);
  const sideScale = Math.sqrt(constraint.volume / freeScale);
  for (let index = 0; index < 3; index++) {
    if (index !== freeIndex) owner.scale[index] *= sideScale;
  }
}

/** The owner's channel follows a keyed curve, read where the target's channel sits between min and max. */
function action(owner, target, constraint) {
  const value = channelOf(target, constraint.source)[axisIndex(constraint.axis)];
  const at = Math.min(1, Math.max(0, (value - constraint.min) / (constraint.max - constraint.min)));
  const { keys } = constraint;
  const found = keys.findIndex(key => key.at >= at);
  const next = found < 0 ? keys.length - 1 : Math.max(1, found);
  const previous = keys[next - 1];
  const following = keys[next];
  const fraction = Math.min(1, Math.max(0, (at - previous.at) / (following.at - previous.at)));
  writeChannel(owner, constraint.destination, previous.value.map((from, index) => from + fraction * (following.value[index] - from)));
}

const FRAME_CONSTRAINTS = {
  copy_location: copyLocation, copy_rotation: copyRotation, copy_scale: copyScale,
  limit_location: limitLocation, limit_rotation: limitRotation, limit_scale: limitScale,
  transformation, action, maintain_volume: maintainVolume,
};

function perpendicularTo(direction) {
  const reference = Math.abs(direction[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  return vec3.normalize(new Float64Array(3), vec3.cross(new Float64Array(3), direction, reference));
}

/** Turn the owner so its track axis points at the target and its up axis leans toward worldUp. Position and scale stay. */
function trackTo(ownerWorld, targetWorld, constraint) {
  const frame = decompose(ownerWorld);
  const forward = vec3.subtract(new Float64Array(3), mat4.getTranslation(new Float64Array(3), targetWorld), frame.translation);
  if (vec3.length(forward) < NEAR_ZERO) return ownerWorld;
  vec3.normalize(forward, forward);
  const worldUp = vec3.normalize(new Float64Array(3), constraint.worldUp);
  const up = vec3.scaleAndAdd(new Float64Array(3), worldUp, forward, -vec3.dot(worldUp, forward));
  if (vec3.length(up) < 1e-6) vec3.copy(up, perpendicularTo(forward));
  vec3.normalize(up, up);
  const trackIndex = axisIndex(constraint.trackAxis);
  const upIndex = AXES.indexOf(constraint.upAxis);
  const columns = [null, null, null];
  columns[trackIndex] = vec3.scale(new Float64Array(3), forward, signOf(constraint.trackAxis));
  columns[upIndex] = up;
  const thirdIndex = 3 - trackIndex - upIndex;
  columns[thirdIndex] = vec3.cross(new Float64Array(3), columns[(thirdIndex + 1) % 3], columns[(thirdIndex + 2) % 3]);
  frame.rotation = quat.normalize(new Float64Array(4), quat.fromMat3(new Float64Array(4), columns.flatMap(column => Array.from(column))));
  return compose(frame);
}

function limitDistance(ownerWorld, targetWorld, constraint) {
  const center = mat4.getTranslation(new Float64Array(3), targetWorld);
  const offset = vec3.subtract(new Float64Array(3), mat4.getTranslation(new Float64Array(3), ownerWorld), center);
  const distance = vec3.length(offset);
  const outside = constraint.mode === 'outside';
  const inside = constraint.mode === 'inside';
  if (distance < NEAR_ZERO || (inside && distance <= constraint.distance) || (outside && distance >= constraint.distance)) return ownerWorld;
  const moved = mat4.clone(ownerWorld);
  vec3.scaleAndAdd(offset, center, offset, constraint.distance / distance);
  moved.set(offset, 12);
  return moved;
}

/** Aim the track axis at the target as far as turning about the owner's own lock axis allows. */
function lockedTrack(ownerWorld, targetWorld, constraint) {
  const frame = decompose(ownerWorld);
  const rotation = mat3.fromQuat(new Float64Array(9), frame.rotation);
  const columnOf = axis => Array.from(rotation.slice(axisIndex(axis) * 3, axisIndex(axis) * 3 + 3));
  const lock = columnOf(constraint.lockAxis);
  const track = columnOf(constraint.trackAxis).map(component => component * signOf(constraint.trackAxis));
  const wanted = vec3.subtract(new Float64Array(3), mat4.getTranslation(new Float64Array(3), targetWorld), frame.translation);
  vec3.scaleAndAdd(wanted, wanted, lock, -vec3.dot(wanted, lock));
  if (vec3.length(wanted) < NEAR_ZERO) return ownerWorld;
  vec3.normalize(wanted, wanted);
  const angle = Math.atan2(vec3.dot(lock, vec3.cross(new Float64Array(3), track, wanted)), vec3.dot(track, wanted));
  const turn = quat.setAxisAngle(new Float64Array(4), lock, angle);
  frame.rotation = quat.normalize(new Float64Array(4), quat.multiply(new Float64Array(4), turn, frame.rotation));
  return compose(frame);
}

/** Aim +y at the target and stretch it to the distance; x and z swell or thin to keep volume as `volume` says. */
function stretchTo(ownerWorld, targetWorld, constraint, restLength) {
  const aimed = trackTo(ownerWorld, targetWorld, { trackAxis: '+y', upAxis: 'z', worldUp: constraint.worldUp });
  const distance = vec3.distance(mat4.getTranslation(new Float64Array(3), ownerWorld), mat4.getTranslation(new Float64Array(3), targetWorld));
  if (aimed === ownerWorld || !(restLength > 0)) return aimed;
  const frame = decompose(aimed);
  const ratio = distance / restLength;
  const swell = ratio ** -constraint.bulge;
  const side = constraint.volume === 'xz' ? Math.sqrt(swell) : swell;
  frame.scale[1] *= ratio;
  if (constraint.volume !== 'none' && constraint.volume !== 'z') frame.scale[0] *= side;
  if (constraint.volume !== 'none' && constraint.volume !== 'x') frame.scale[2] *= side;
  return compose(frame);
}

function floorConstraint(ownerWorld, targetWorld, constraint) {
  const normal = new Float64Array(3);
  normal[axisIndex(constraint.axis)] = signOf(constraint.axis);
  if (constraint.useRotation) {
    vec3.transformQuat(normal, normal, decompose(targetWorld).rotation);
    vec3.normalize(normal, normal);
  }
  const position = mat4.getTranslation(new Float64Array(3), ownerWorld);
  const planePoint = mat4.getTranslation(new Float64Array(3), targetWorld);
  const height = vec3.dot(vec3.subtract(new Float64Array(3), position, planePoint), normal);
  if (height >= constraint.offset) return ownerWorld;
  const lifted = mat4.clone(ownerWorld);
  const raise = constraint.offset - height;
  for (let index = 0; index < 3; index++) lifted[12 + index] += normal[index] * raise;
  return lifted;
}

/** Rotate the owner by the shortest arc that aligns its trackAxis with the vector to the target. */
function dampedTrack(ownerWorld, targetWorld, constraint) {
  const frame = decompose(ownerWorld);
  const wanted = vec3.subtract(new Float64Array(3), mat4.getTranslation(new Float64Array(3), targetWorld), frame.translation);
  if (vec3.length(wanted) < NEAR_ZERO) return ownerWorld;
  vec3.normalize(wanted, wanted);
  const localAxis = new Float64Array(3);
  localAxis[axisIndex(constraint.trackAxis)] = signOf(constraint.trackAxis);
  const currentAxis = vec3.transformQuat(new Float64Array(3), localAxis, frame.rotation);
  vec3.normalize(currentAxis, currentAxis);
  const turn = quat.rotationTo(new Float64Array(4), currentAxis, wanted);
  frame.rotation = quat.normalize(new Float64Array(4), quat.multiply(new Float64Array(4), turn, frame.rotation));
  return compose(frame);
}

/** Orbit the owner's translation around a pivot point (target + offset, or rest translation + offset) by its rotation. */
function pivotConstraint(ownerWorld, targetWorld, restOwnerWorld, constraint) {
  const frame = decompose(ownerWorld);
  const restFrame = decompose(restOwnerWorld);
  const base = targetWorld ? mat4.getTranslation(new Float64Array(3), targetWorld) : restFrame.translation;
  const pivotPoint = vec3.add(new Float64Array(3), base, constraint.offset);
  const arm = vec3.subtract(new Float64Array(3), frame.translation, pivotPoint);
  vec3.transformQuat(arm, arm, frame.rotation);
  vec3.add(frame.translation, pivotPoint, arm);
  return compose(frame);
}

function sampleCatmullRom(points, closed, parameter) {
  const count = points.length;
  const segments = closed ? count : count - 1;
  const wrapped = closed ? ((parameter % 1) + 1) % 1 : Math.min(1, Math.max(0, parameter));
  const scaled = wrapped * segments;
  const segment = Math.min(segments - 1, Math.floor(scaled));
  const localT = scaled - segment;
  const pick = index => {
    if (closed) return points[((index % count) + count) % count];
    if (index < 0) return points[0].map((v, i) => 2 * v - points[1][i]);
    if (index >= count) return points[count - 1].map((v, i) => 2 * v - points[count - 2][i]);
    return points[index];
  };
  const p0 = pick(segment - 1);
  const p1 = pick(segment);
  const p2 = pick(segment + 1);
  const p3 = pick(segment + 2);
  const t2 = localT * localT;
  const t3 = t2 * localT;
  const position = new Float64Array(3);
  const tangent = new Float64Array(3);
  for (let axis = 0; axis < 3; axis++) {
    position[axis] = 0.5 * ((2 * p1[axis]) + (-p0[axis] + p2[axis]) * localT + (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * t2 + (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * t3);
    tangent[axis] = 0.5 * ((-p0[axis] + p2[axis]) + 2 * (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * localT + 3 * (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * t2);
  }
  return { position, tangent };
}

function followPathConstraint(ownerWorld, constraint, time) {
  const parameter = (time / constraint.duration) + constraint.offset;
  const { position, tangent } = sampleCatmullRom(constraint.points, constraint.closed, parameter);
  const moved = mat4.clone(ownerWorld);
  moved.set(position, 12);
  if (!constraint.followCurve || vec3.length(tangent) < NEAR_ZERO) return moved;
  const targetPoint = vec3.add(new Float64Array(3), position, tangent);
  const targetMatrix = mat4.fromTranslation(new Float64Array(16), targetPoint);
  return trackTo(moved, targetMatrix, { trackAxis: constraint.forwardAxis, upAxis: constraint.upAxis, worldUp: [0, 1, 0] });
}

function clampToConstraint(ownerWorld, constraint) {
  const points = constraint.points;
  let axis = axisIndex(constraint.mainAxis);
  if (constraint.mainAxis === 'auto') {
    const spans = [0, 1, 2].map(index => {
      const coords = points.map(point => point[index]);
      return Math.max(...coords) - Math.min(...coords);
    });
    axis = spans.indexOf(Math.max(...spans));
  }
  const coords = points.map(point => point[axis]);
  const minCoord = Math.min(...coords);
  const maxCoord = Math.max(...coords);
  const ownerPos = mat4.getTranslation(new Float64Array(3), ownerWorld);
  const span = Math.max(NEAR_ZERO, maxCoord - minCoord);
  let fraction = (ownerPos[axis] - minCoord) / span;
  fraction = constraint.cyclic ? ((fraction % 1) + 1) % 1 : Math.min(1, Math.max(0, fraction));
  const { position } = sampleCatmullRom(points, constraint.cyclic, fraction);
  const moved = mat4.clone(ownerWorld);
  moved.set(position, 12);
  return moved;
}

function shrinkwrapConstraint(ownerWorld, targetWorld, constraint) {
  const ownerPos = mat4.getTranslation(new Float64Array(3), ownerWorld);
  const targetFrame = decompose(targetWorld);
  const moved = mat4.clone(ownerWorld);
  if (constraint.mode === 'project') {
    const dir = new Float64Array(3);
    dir[axisIndex(constraint.projectAxis)] = signOf(constraint.projectAxis);
    const axis = axisIndex(constraint.projectAxis);
    const sign = signOf(constraint.projectAxis);
    const surfaceCoord = targetFrame.translation[axis] - sign * (targetFrame.scale[axis] * 0.5 + constraint.distance);
    ownerPos[axis] = surfaceCoord;
    moved.set(ownerPos, 12);
    return moved;
  }
  const offset = vec3.subtract(new Float64Array(3), ownerPos, targetFrame.translation);
  const radius = Math.max(...targetFrame.scale) * 0.5 + constraint.distance;
  const dist = vec3.length(offset);
  if (dist < NEAR_ZERO) {
    moved[13] = targetFrame.translation[1] + radius;
    return moved;
  }
  vec3.scaleAndAdd(ownerPos, targetFrame.translation, offset, radius / dist);
  moved.set(ownerPos, 12);
  return moved;
}

function armatureConstraint(ownerWorld, worlds, restWorlds, indexById, constraint) {
  let totalWeight = 0;
  const translations = new Float64Array(3);
  const scales = new Float64Array(3);
  const accumRotation = new Float64Array(4);
  let firstQuat = null;
  for (const entry of constraint.targets) {
    if (entry.weight <= 0) continue;
    const targetIdx = indexById.get(entry.target);
    const inverse = mat4.invert(new Float64Array(16), restWorlds[targetIdx]);
    const delta = mat4.multiply(new Float64Array(16), worlds[targetIdx], inverse);
    const transformed = decompose(mat4.multiply(new Float64Array(16), delta, ownerWorld));
    totalWeight += entry.weight;
    vec3.scaleAndAdd(translations, translations, transformed.translation, entry.weight);
    vec3.scaleAndAdd(scales, scales, transformed.scale, entry.weight);
    const q = transformed.rotation;
    if (!firstQuat) firstQuat = q;
    const sign = quat.dot(firstQuat, q) < 0 ? -entry.weight : entry.weight;
    for (let i = 0; i < 4; i++) accumRotation[i] += q[i] * sign;
  }
  if (totalWeight <= NEAR_ZERO) return ownerWorld;
  vec3.scale(translations, translations, 1 / totalWeight);
  vec3.scale(scales, scales, 1 / totalWeight);
  quat.normalize(accumRotation, accumRotation);
  return compose({ translation: translations, rotation: accumRotation, scale: scales });
}

// ---------------------------------------------------------------------------------------------------------------
// Evaluation

function topologicalOrder(hierarchy, indexById) {
  const order = [];
  const visited = new Uint8Array(hierarchy.length);
  const visit = index => {
    if (visited[index]) return;
    visited[index] = 1;
    const parent = hierarchy[index].parent;
    if (parent !== undefined && parent !== null) visit(indexById.get(parent));
    order.push(index);
  };
  hierarchy.forEach((node, index) => visit(index));
  return order;
}

function restFrame(node) {
  return {
    translation: Float64Array.from(node.translation ?? [0, 0, 0]),
    rotation: Float64Array.from(node.rotation ?? [0, 0, 0, 1]),
    scale: Float64Array.from(node.scale ?? [1, 1, 1]),
  };
}

function wantsEvaluation(constraints, drivers) {
  return Boolean(constraints?.length || drivers?.length);
}

/**
 * Build an evaluator over { hierarchy, rootMatrix, constraints, drivers, materials }. `hierarchy` lists every node as
 * { id, parent, translation, rotation, scale }. `evaluate(time, bases)` takes the base pose as a Map of node ID to
 * { translation, rotation, scale } (missing parts use the rest pose) and returns the final local frames of every node
 * a driver or constraint writes, plus driven material values. The base arrays are not changed.
 */
export function createNodeConstraintEvaluator({ hierarchy, rootMatrix, constraints = [], drivers = [], materials = [] }) {
  if (!wantsEvaluation(constraints, drivers)) return null;
  const indexById = new Map(hierarchy.map((node, index) => [node.id, index]));
  const order = topologicalOrder(hierarchy, indexById);
  const parentIndices = hierarchy.map(node => (node.parent === undefined || node.parent === null ? -1 : indexById.get(node.parent)));
  const rootWorld = rootMatrix ? mat4.clone(rootMatrix) : mat4.create();
  const nodeIds = new Set(indexById.keys());
  const materialBaselines = new Map(materials.map(material => [material.id, material]));
  const compiledDrivers = drivers.map(driver => ({ ...driver, compiled: compileMotionExpression(driver.expression, nodeIds, 'Motion driver expression') }));
  const compiledConstraints = constraints.map(constraint => ({
    ...constraint,
    compiledInfluence: typeof constraint.influence === 'number' ? null : compileMotionExpression(constraint.influence, nodeIds, 'Motion constraint influence'),
  }));

  function computeWorlds(locals) {
    const worlds = new Array(hierarchy.length);
    for (const index of order) {
      const parentWorld = parentIndices[index] >= 0 ? worlds[parentIndices[index]] : rootWorld;
      worlds[index] = mat4.multiply(new Float64Array(16), parentWorld, compose(locals[index]));
    }
    return worlds;
  }

  const restLocals = hierarchy.map(restFrame);
  const restWorlds = computeWorlds(restLocals);

  function readFrom(locals, worlds) {
    return (id, property, component, space) => {
      const index = indexById.get(id);
      const frame = space === 'world' ? decompose(worlds[index]) : locals[index];
      if (property === 'rotation') return eulerFromQuaternion(frame.rotation)[component] / TO_RADIANS;
      return frame[property][component];
    };
  }

  function applyDriver(driver, locals, context, touchedMaterials) {
    const value = driver.compiled.evaluate(context);
    const { kind, id, property, component } = driver.target;
    const index = AXES.indexOf(component);
    if (kind === 'material') {
      if (index < 0) {
        touchedMaterials.set(id, { ...touchedMaterials.get(id), [property]: value });
        return;
      }
      const current = touchedMaterials.get(id)?.[property] ?? Array.from(materialBaselines.get(id)?.[property] ?? [0.5, 0.5, 0.5]);
      current[index] = value;
      touchedMaterials.set(id, { ...touchedMaterials.get(id), [property]: current });
      return;
    }
    const frame = locals[indexById.get(id)];
    if (property === 'rotation') {
      const angles = eulerFromQuaternion(frame.rotation);
      angles[index] = value * TO_RADIANS;
      quaternionFromEuler(frame.rotation, angles[0], angles[1], angles[2]);
      return;
    }
    if (property === 'scale' && !(Math.fround(value) > 0)) throw new RangeError(`Motion driver made the scale of ${id} not positive (${value}).`);
    frame[property][index] = value;
  }

  function applyConstraint(constraint, locals, context) {
    const worlds = computeWorlds(locals);
    const ownerIndex = indexById.get(constraint.node);
    const parentWorld = parentIndices[ownerIndex] >= 0 ? worlds[parentIndices[ownerIndex]] : rootWorld;
    const ownerWorld = worlds[ownerIndex];
    const targetIndex = constraint.target === undefined ? -1 : indexById.get(constraint.target);
    const influence = constraint.compiledInfluence ? Math.min(1, Math.max(0, constraint.compiledInfluence.evaluate(context))) : constraint.influence;
    let result;
    if (FRAME_CONSTRAINTS[constraint.type]) {
      const inLocalSpace = constraint.space === 'local';
      const owner = inLocalSpace ? copyFrame(locals[ownerIndex]) : decompose(ownerWorld);
      const target = targetIndex < 0 ? null : (inLocalSpace ? locals[targetIndex] : decompose(worlds[targetIndex]));
      FRAME_CONSTRAINTS[constraint.type](owner, target, constraint);
      result = inLocalSpace ? mat4.multiply(new Float64Array(16), parentWorld, compose(owner)) : compose(owner);
    } else if (constraint.type === 'track_to') {
      result = trackTo(ownerWorld, worlds[targetIndex], constraint);
    } else if (constraint.type === 'floor') {
      result = floorConstraint(ownerWorld, worlds[targetIndex], constraint);
    } else if (constraint.type === 'copy_transforms') {
      if (constraint.mix === 'before') result = mat4.multiply(new Float64Array(16), ownerWorld, worlds[targetIndex]);
      else if (constraint.mix === 'after') result = mat4.multiply(new Float64Array(16), worlds[targetIndex], ownerWorld);
      else result = worlds[targetIndex];
    } else if (constraint.type === 'limit_distance') {
      result = limitDistance(ownerWorld, worlds[targetIndex], constraint);
    } else if (constraint.type === 'locked_track') {
      result = lockedTrack(ownerWorld, worlds[targetIndex], constraint);
    } else if (constraint.type === 'stretch_to') {
      const restLength = constraint.restLength || vec3.distance(mat4.getTranslation(new Float64Array(3), restWorlds[ownerIndex]), mat4.getTranslation(new Float64Array(3), restWorlds[targetIndex]));
      result = stretchTo(ownerWorld, worlds[targetIndex], constraint, restLength);
    } else if (constraint.type === 'damped_track') {
      result = dampedTrack(ownerWorld, worlds[targetIndex], constraint);
    } else if (constraint.type === 'pivot') {
      result = pivotConstraint(ownerWorld, targetIndex >= 0 ? worlds[targetIndex] : null, restWorlds[ownerIndex], constraint);
    } else if (constraint.type === 'follow_path') {
      result = followPathConstraint(ownerWorld, constraint, context.time);
    } else if (constraint.type === 'clamp_to') {
      result = clampToConstraint(ownerWorld, constraint);
    } else if (constraint.type === 'shrinkwrap') {
      result = shrinkwrapConstraint(ownerWorld, worlds[targetIndex], constraint);
    } else if (constraint.type === 'armature') {
      result = armatureConstraint(ownerWorld, worlds, restWorlds, indexById, constraint);
    } else {
      const inverse = constraint.inverse === 'rest' ? mat4.invert(new Float64Array(16), restWorlds[targetIndex]) : mat4.create();
      const parent = mat4.multiply(new Float64Array(16), worlds[targetIndex], inverse);
      result = mat4.multiply(new Float64Array(16), parent, ownerWorld);
    }
    const blended = blendMatrices(ownerWorld, result, influence);
    const local = mat4.multiply(new Float64Array(16), mat4.invert(new Float64Array(16), parentWorld), blended);
    locals[ownerIndex] = decompose(local);
  }

  return Object.freeze({
    evaluate(time, bases = new Map()) {
      const baseLocals = hierarchy.map((node, index) => {
        const base = bases.get(node.id);
        const frame = copyFrame(restLocals[index]);
        if (base?.translation) frame.translation.set(base.translation);
        if (base?.rotation) frame.rotation.set(base.rotation);
        if (base?.scale) frame.scale.set(base.scale);
        return frame;
      });
      const context = { time, read: readFrom(baseLocals, computeWorlds(baseLocals)) };
      const locals = baseLocals.map(copyFrame);
      const touchedMaterials = new Map();
      for (const driver of compiledDrivers) applyDriver(driver, locals, context, touchedMaterials);
      for (const constraint of compiledConstraints) applyConstraint(constraint, locals, context);
      const written = new Set([...compiledDrivers.filter(driver => driver.target.kind === 'node').map(driver => driver.target.id), ...compiledConstraints.map(constraint => constraint.node)]);
      const nodes = new Map([...written].map(id => [id, locals[indexById.get(id)]]));
      for (const [id, frame] of nodes) {
        if (![...frame.translation, ...frame.rotation, ...frame.scale].every(Number.isFinite)) throw new RangeError(`Motion constraints produced an invalid pose for node ${id}.`);
        if (frame.scale.some(component => !(Math.fround(component) > 0))) throw new RangeError(`Motion constraints made the scale of node ${id} not positive.`);
      }
      return { nodes, materials: touchedMaterials };
    },
  });
}
