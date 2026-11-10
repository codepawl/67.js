import { mat4, quat, vec3 } from 'gl-matrix';
import { evaluateForceFields, normalizeForceFields } from './force-fields.js';

let rapierPromise;
let rapierEngine;
let loadRapierModule = () => import('@dimforge/rapier3d-compat');
const ZERO = [0, 0, 0];
const IDENTITY = [0, 0, 0, 1];
const MIN_NORMAL_FLOAT32 = 2 ** -126;
const MAX_JOINT_DISTANCE = 1e6;
const MAX_MOTOR_SPEED = 1e4;
const MAX_MOTOR_GAIN = 1e6;
const MAX_MOTOR_FORCE = 1e8;
const MAX_JOINT_ANGLE = Math.fround(Math.PI);
const LIMITS = {
  maxBodies: [256, 4096],
  maxColliders: [1024, 8192],
  maxJoints: [512, 8192],
  maxEvents: [10000, 100000],
  maxFrames: [3601, 1000000],
  maxColliderTriangles: [20000, 200000],
  maxHullPoints: [2048, 16384],
  maxContactEvents: [4096, 100000],
};
// A body counts as resting once it stays under both speeds until the last frame.
const REST_LINEAR_SPEED = 0.02;
const REST_ANGULAR_SPEED = 0.05;
const MAX_GROUP_BITS = 0xffff;

/** Replace how the Rapier module is imported, for hosts that serve it from a URL. */
export function setPhysicsModuleLoader(loader) {
  loadRapierModule = loader;
  rapierPromise = undefined;
  rapierEngine = undefined;
}

/** Load the Rapier WASM engine once. After it resolves, bakePhysicsScene runs synchronously. */
export function loadPhysicsEngine() {
  rapierPromise ??= loadRapierModule().then(async module => {
    const rapier = module.default ?? module;
    await rapier.init();
    rapierEngine = rapier;
    return rapier;
  }, error => {
    rapierPromise = undefined;
    throw error;
  });
  return rapierPromise;
}

export function physicsEngineLoaded() {
  return rapierEngine !== undefined;
}

function fields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`${label}.${key} is unsupported`);
    }
  }
}

function scalar(value, label, min = -Infinity, max = Infinity) {
  const rounded = Math.fround(value);
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(rounded) || value < min || value > max || rounded < min || rounded > max) {
    throw new RangeError(`${label} must be finite Float32 in [${min}, ${max}]`);
  }
  return rounded;
}

function positive(value, label) {
  const result = scalar(value, label, 0);
  if (result === 0) {
    throw new RangeError(`${label} must remain positive in Float32`);
  }
  return result;
}

function normalPositive(value, label) {
  const result = scalar(value, label, MIN_NORMAL_FLOAT32);
  positive(1 / result, `${label} reciprocal`);
  return result;
}

function vectorLength(value, label) {
  const squaredLength = value[0] ** 2 + value[1] ** 2 + value[2] ** 2;
  scalar(squaredLength, `${label} squared norm`, 0);
  return Math.sqrt(squaredLength);
}

function vector(value, size, label, fallback) {
  value ??= fallback;
  if (!value || value.length !== size) {
    throw new TypeError(`${label} must contain ${size} numbers`);
  }
  return Array.from(value, (number, index) => scalar(number, `${label}[${index}]`));
}

function rotation(value, label) {
  const result = vector(value, 4, label, IDENTITY);
  const length = Math.hypot(...result);
  if (!length || Math.abs(length - 1) > 1e-4) {
    throw new RangeError(`${label} must be a unit quaternion`);
  }
  // A half-turn has two equivalent signs; keep its solver representation stable.
  const sign = result[3] === 0 && result.find(number => number !== 0) < 0 ? -1 : 1;
  return result.map(number => number === 0 ? 0 : Math.fround(sign * number / length));
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function namedList(list, label, limit) {
  if (!Array.isArray(list) || list.length > limit) {
    throw new RangeError(`${label} must be an array with at most ${limit} entries`);
  }
  const names = new Set();
  for (const entry of list) {
    if (typeof entry?.name !== 'string' || !entry.name.length || names.has(entry.name)) {
      throw new TypeError(`${label} names must be nonempty and unique`);
    }
    names.add(entry.name);
  }
  return list;
}

function jointLimits(value, type) {
  const bounds = vector(value, 2, 'joint limits');
  const maximum = type === 'revolute' ? MAX_JOINT_ANGLE : MAX_JOINT_DISTANCE;
  for (const bound of bounds) scalar(bound, 'joint limit', -maximum, maximum);
  if (bounds[0] >= bounds[1]) throw new RangeError('joint limits must remain strictly increasing in Float32');
  return bounds;
}

function jointMotor(value, joint) {
  if (value === null) return null;
  fields(value, ['mode', 'target', 'stiffness', 'damping', 'maxForce'], 'motor');
  if (!['position', 'velocity'].includes(value.mode)) throw new TypeError('motor mode must be position or velocity');
  if (value.mode === 'velocity' && value.stiffness !== undefined) throw new TypeError('velocity motors do not accept stiffness');
  const maximum = value.mode === 'velocity' ? MAX_MOTOR_SPEED : joint.type === 'revolute' ? MAX_JOINT_ANGLE : MAX_JOINT_DISTANCE;
  const target = scalar(value.target, 'motor target', -maximum, maximum);
  if (value.target !== 0 && target === 0) throw new RangeError('motor target must not collapse to zero in Float32');
  if (value.mode === 'position' && joint.limits && (target < joint.limits[0] || target > joint.limits[1])) {
    throw new RangeError('motor position target must stay within joint limits');
  }
  const stiffness = value.mode === 'position' ? positive(value.stiffness, 'motor stiffness') : 0;
  if (stiffness > MAX_MOTOR_GAIN) throw new RangeError('motor stiffness exceeds the supported gain bound');
  const damping = scalar(value.damping, 'motor damping', 0, MAX_MOTOR_GAIN);
  if (value.damping !== 0 && damping === 0) throw new RangeError('motor damping must not collapse to zero in Float32');
  if (value.mode === 'velocity' && damping === 0) throw new RangeError('velocity motor damping must remain positive in Float32');
  const maxForce = normalPositive(value.maxForce, 'motor maxForce');
  if (maxForce > MAX_MOTOR_FORCE) throw new RangeError('motor maxForce exceeds the supported force bound');
  return { mode: value.mode, target, stiffness, damping, maxForce };
}

function initialJointCoordinate(joint, bodies) {
  const first = bodies[joint.bodyA];
  const second = bodies[joint.bodyB];
  const axisA = vec3.transformQuat(new Float64Array(3), joint.axis, first.rotation);
  const axisB = vec3.transformQuat(new Float64Array(3), joint.axis, second.rotation);
  if (vec3.distance(axisA, axisB) > 1e-4) throw new RangeError('controlled joint axes must initially align in world space');
  const anchorA = vec3.transformQuat(new Float64Array(3), joint.anchorA, first.rotation);
  const anchorB = vec3.transformQuat(new Float64Array(3), joint.anchorB, second.rotation);
  vec3.add(anchorA, anchorA, first.translation);
  vec3.add(anchorB, anchorB, second.translation);
  const difference = vec3.subtract(new Float64Array(3), anchorB, anchorA);
  const relativeRotation = quat.multiply(new Float64Array(4), quat.conjugate(new Float64Array(4), first.rotation), second.rotation);
  let coordinate;
  if (joint.type === 'prismatic') {
    coordinate = vec3.dot(difference, axisA);
    vec3.scaleAndAdd(difference, difference, axisA, -coordinate);
    if (vec3.length(difference) > 1e-4 || Math.abs(relativeRotation[3]) < 1 - 1e-4) {
      throw new RangeError('prismatic joint anchors must initially align along its axis with matching body orientations');
    }
  } else {
    if (vec3.length(difference) > 1e-4) throw new RangeError('controlled revolute joint anchors must initially coincide');
    coordinate = 2 * Math.atan2(relativeRotation[0] * joint.axis[0] + relativeRotation[1] * joint.axis[1] + relativeRotation[2] * joint.axis[2], relativeRotation[3]);
    if (coordinate > Math.PI) coordinate -= 2 * Math.PI;
    if (coordinate < -Math.PI) coordinate += 2 * Math.PI;
    if (Math.abs(coordinate) === Math.PI) {
      coordinate = joint.limits && joint.limits[1] < Math.PI ? -Math.PI : Math.PI;
    }
  }
  coordinate = scalar(coordinate, 'initial joint coordinate', joint.type === 'revolute' ? -MAX_JOINT_ANGLE : -MAX_JOINT_DISTANCE, joint.type === 'revolute' ? MAX_JOINT_ANGLE : MAX_JOINT_DISTANCE);
  if (joint.limits && (coordinate < joint.limits[0] || coordinate > joint.limits[1])) {
    throw new RangeError('initial joint coordinate must stay within joint limits');
  }
}

function finiteArray(values, label, maximumLength) {
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) {
    throw new TypeError(`${label} must be an array of numbers`);
  }
  if (values.length > maximumLength) {
    throw new RangeError(`${label} has ${values.length} numbers; the limit is ${maximumLength}`);
  }
  return Float32Array.from(values, (number, index) => scalar(number, `${label}[${index}]`));
}

function convexHullCollider(collider, limits) {
  if (collider.vertices !== undefined || collider.indices !== undefined || collider.radius !== undefined || collider.halfHeight !== undefined || collider.halfExtents !== undefined) {
    throw new TypeError('convexHull only accepts points');
  }
  if (!collider.points || collider.points.length % 3 !== 0 || collider.points.length < 12) {
    throw new TypeError('convexHull points must hold at least four xyz points');
  }
  const points = finiteArray(collider.points, 'points', limits.maxHullPoints * 3);
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  let largestExtent = 0;
  for (let index = 0; index < points.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], points[index + axis]);
      maximum[axis] = Math.max(maximum[axis], points[index + axis]);
    }
    largestExtent = Math.max(largestExtent, Math.hypot(points[index], points[index + 1], points[index + 2]));
  }
  const size = maximum.map((value, axis) => value - minimum[axis]);
  // The solver derives true mass from the hull; this bounding box only sizes the safety checks.
  return { shape: 'convexHull', points, volume: size[0] * size[1] * size[2], smallestExtent: Math.min(...size) / 2, largestExtent };
}

function trimeshCollider(collider, body, limits, budget) {
  if (body.type === 'dynamic') {
    throw new TypeError('trimesh colliders need a fixed or kinematic body; use convexHull for a dynamic body');
  }
  if (collider.points !== undefined || collider.radius !== undefined || collider.halfHeight !== undefined || collider.halfExtents !== undefined) {
    throw new TypeError('trimesh only accepts vertices and indices');
  }
  if (!collider.vertices || collider.vertices.length % 3 !== 0 || !collider.indices || collider.indices.length % 3 !== 0 || !collider.indices.length) {
    throw new TypeError('trimesh needs xyz vertices and triangle indices');
  }
  // Counts are checked before any typed array is allocated.
  budget.triangles += collider.indices.length / 3;
  if (budget.triangles > limits.maxColliderTriangles) {
    throw new RangeError(`trimesh colliders hold ${budget.triangles} triangles; maxColliderTriangles is ${limits.maxColliderTriangles}`);
  }
  const vertices = finiteArray(collider.vertices, 'vertices', limits.maxColliderTriangles * 3 * 3);
  const vertexCount = vertices.length / 3;
  const indices = Uint32Array.from(collider.indices, (index, position) => integer(index, `indices[${position}]`, 0, vertexCount - 1));
  return { shape: 'trimesh', vertices, indices };
}

function meshCollider(collider, body, limits, budget) {
  if (collider.shape === 'convexHull') return convexHullCollider(collider, limits);
  if (collider.shape === 'trimesh') return trimeshCollider(collider, body, limits, budget);
  if (collider.points !== undefined || collider.vertices !== undefined || collider.indices !== undefined) {
    throw new TypeError(`${collider.shape} does not accept points, vertices or indices`);
  }
  return null;
}

function prepare(definition, options) {
  fields(definition, ['bodies', 'colliders', 'joints', 'events', 'fields', 'gravity'], 'definition');
  fields(options, ['frameCount', 'timestep', 'solverIterations', 'maxMemoryBytes', ...Object.keys(LIMITS)], 'options');
  const limits = {};
  for (const [key, [fallback, cap]] of Object.entries(LIMITS)) {
    limits[key] = integer(options[key] ?? fallback, key, 1, cap);
  }
  const frameCount = integer(options.frameCount ?? 601, 'frameCount', 1, limits.maxFrames);
  const timestep = positive(options.timestep ?? 1 / 60, 'timestep');
  positive(1 / timestep, 'timestep reciprocal');
  if (timestep > 1) {
    throw new RangeError('timestep must be at most one second');
  }
  const solverIterations = integer(options.solverIterations ?? 8, 'solverIterations', 1, 128);
  const maxMemoryBytes = integer(options.maxMemoryBytes ?? 128 * 1024 * 1024, 'maxMemoryBytes', 1, 2 ** 31 - 1);
  const rawBodies = namedList(definition.bodies, 'bodies', limits.maxBodies);
  if (!rawBodies.length) {
    throw new RangeError('bodies must not be empty');
  }
  const rawColliders = namedList(definition.colliders ?? [], 'colliders', limits.maxColliders);
  const rawJoints = namedList(definition.joints ?? [], 'joints', limits.maxJoints);
  const rawEvents = definition.events ?? [];
  if (!Array.isArray(rawEvents) || rawEvents.length > limits.maxEvents) {
    throw new RangeError('events exceed maxEvents');
  }
  const timelineBytes = rawBodies.length * frameCount * 7 * Float32Array.BYTES_PER_ELEMENT;
  // Solver memory varies with contacts and WASM allocator reuse. This is a reservation estimate, not a heap measurement.
  const solverReserveBytes = 1048576 + rawBodies.length * 16384 + rawColliders.length * 16384 + rawJoints.length * 8192 + rawColliders.length ** 2 * 128;
  const estimatedPeakBytes = timelineBytes + solverReserveBytes;
  if (!Number.isSafeInteger(estimatedPeakBytes) || estimatedPeakBytes > maxMemoryBytes) {
    throw new RangeError(`physics memory plan ${estimatedPeakBytes} exceeds maxMemoryBytes ${maxMemoryBytes}`);
  }
  const bodies = rawBodies.map(body => {
    fields(body, ['name', 'type', 'translation', 'rotation', 'linearVelocity', 'angularVelocity', 'linearDamping', 'angularDamping', 'ccd'], `body ${body.name}`);
    const type = body.type ?? 'dynamic';
    if (!['dynamic', 'fixed', 'kinematic'].includes(type)) {
      throw new TypeError(`body ${body.name} has unsupported type`);
    }
    if (type !== 'dynamic' && (body.linearVelocity || body.angularVelocity || body.linearDamping !== undefined || body.angularDamping !== undefined || body.ccd !== undefined)) {
      throw new TypeError(`body ${body.name} only supports velocity, damping, and CCD when dynamic`);
    }
    if (body.ccd !== undefined && typeof body.ccd !== 'boolean') {
      throw new TypeError('ccd must be boolean');
    }
    return {
      name: body.name,
      type,
      translation: vector(body.translation, 3, 'translation', ZERO),
      rotation: rotation(body.rotation, 'rotation'),
      linearVelocity: vector(body.linearVelocity, 3, 'linearVelocity', ZERO),
      angularVelocity: vector(body.angularVelocity, 3, 'angularVelocity', ZERO),
      linearDamping: scalar(body.linearDamping ?? 0, 'linearDamping', 0),
      angularDamping: scalar(body.angularDamping ?? 0, 'angularDamping', 0),
      ccd: body.ccd ?? false,
    };
  });
  const bodyIndices = new Map(bodies.map((body, index) => [body.name, index]));
  function bodyIndex(name) {
    if (!bodyIndices.has(name)) {
      throw new TypeError(`unknown body ${name}`);
    }
    return bodyIndices.get(name);
  }
  const meshBudget = { triangles: 0 };
  const colliders = rawColliders.map(collider => {
    fields(collider, ['name', 'body', 'shape', 'radius', 'halfHeight', 'halfExtents', 'points', 'vertices', 'indices', 'translation', 'rotation', 'mass', 'density', 'friction', 'restitution', 'sensor', 'groups', 'mask'], `collider ${collider.name}`);
    const body = bodyIndex(collider.body);
    const mesh = meshCollider(collider, bodies[body], limits, meshBudget);
    if (collider.sensor !== undefined && typeof collider.sensor !== 'boolean') {
      throw new TypeError('sensor must be boolean');
    }
    const common = {
      name: collider.name,
      body,
      translation: vector(collider.translation, 3, 'collider translation', ZERO),
      rotation: rotation(collider.rotation, 'collider rotation'),
      friction: scalar(collider.friction ?? 0.5, 'friction', 0),
      restitution: scalar(collider.restitution ?? 0, 'restitution', 0, 1),
      sensor: collider.sensor ?? false,
      groups: integer(collider.groups ?? MAX_GROUP_BITS, 'groups', 0, MAX_GROUP_BITS),
      mask: integer(collider.mask ?? MAX_GROUP_BITS, 'mask', 0, MAX_GROUP_BITS),
    };
    if (mesh?.shape === 'trimesh') {
      return { ...common, ...mesh, effectiveMass: 0, minimumInertia: 0, largestExtent: 0 };
    }
    let radius;
    let halfHeight;
    let halfExtents;
    let volume;
    let smallestExtent;
    if (collider.shape === 'ball') {
      if (collider.halfHeight !== undefined || collider.halfExtents !== undefined) {
        throw new TypeError('ball only accepts radius');
      }
      radius = positive(collider.radius, 'radius');
      volume = 4 * Math.PI * radius ** 3 / 3;
      smallestExtent = radius;
    } else if (collider.shape === 'cuboid') {
      if (collider.radius !== undefined || collider.halfHeight !== undefined) {
        throw new TypeError('cuboid only accepts halfExtents');
      }
      halfExtents = vector(collider.halfExtents, 3, 'halfExtents');
      for (const extent of halfExtents) {
        positive(extent, 'halfExtents');
      }
      volume = 8 * halfExtents[0] * halfExtents[1] * halfExtents[2];
      smallestExtent = Math.min(...halfExtents);
    } else if (collider.shape === 'capsule') {
      if (collider.halfExtents !== undefined) {
        throw new TypeError('capsule only accepts radius and halfHeight');
      }
      radius = positive(collider.radius, 'radius');
      halfHeight = positive(collider.halfHeight, 'halfHeight');
      volume = Math.PI * radius ** 2 * 2 * halfHeight + 4 * Math.PI * radius ** 3 / 3;
      smallestExtent = radius;
    } else if (collider.shape === 'cylinder' || collider.shape === 'cone') {
      if (collider.halfExtents !== undefined) {
        throw new TypeError(`${collider.shape} only accepts radius and halfHeight`);
      }
      radius = positive(collider.radius, 'radius');
      halfHeight = positive(collider.halfHeight, 'halfHeight');
      volume = Math.PI * radius ** 2 * 2 * halfHeight / (collider.shape === 'cone' ? 3 : 1);
      smallestExtent = Math.min(radius, halfHeight);
    } else if (mesh) {
      volume = mesh.volume;
      smallestExtent = mesh.smallestExtent;
    } else {
      throw new TypeError(`unsupported collider shape ${collider.shape}`);
    }
    positive(volume, 'collider volume');
    if (collider.mass !== undefined && collider.density !== undefined) {
      throw new TypeError('collider accepts either mass or density');
    }
    const mass = collider.mass === undefined ? undefined : positive(collider.mass, 'mass');
    const density = mass === undefined ? positive(collider.density ?? 1, 'density') : undefined;
    const effectiveMass = normalPositive(mass ?? volume * density, 'collider effective mass');
    if (mass !== undefined) {
      positive(mass / volume, 'collider effective density');
    }
    const minimumInertia = normalPositive(0.1 * effectiveMass * smallestExtent ** 2, 'collider minimum inertia scale');
    const largestExtent = mesh ? mesh.largestExtent : halfExtents ? Math.max(...halfExtents) : radius + (halfHeight ?? 0);
    positive(effectiveMass * largestExtent ** 2, 'collider maximum inertia scale');
    return {
      ...common,
      shape: collider.shape,
      radius,
      halfHeight,
      halfExtents,
      points: mesh?.points,
      mass,
      density,
      effectiveMass,
      minimumInertia,
      largestExtent,
    };
  });
  const massTotals = Array(bodies.length).fill(0);
  const inertiaTotals = Array(bodies.length).fill(0);
  const minimumInertiaTotals = Array(bodies.length).fill(0);
  const maximumColliderOffsets = Array(bodies.length).fill(0);
  for (const collider of colliders) {
    if (collider.shape === 'trimesh') continue;
    const index = collider.body;
    massTotals[index] = normalPositive(massTotals[index] + collider.effectiveMass, 'compound body mass');
    inertiaTotals[index] = positive(inertiaTotals[index] + collider.effectiveMass * (collider.largestExtent ** 2 + Math.hypot(...collider.translation) ** 2), 'compound body inertia scale');
    minimumInertiaTotals[index] = normalPositive(minimumInertiaTotals[index] + collider.minimumInertia, 'compound body minimum inertia');
    maximumColliderOffsets[index] = Math.max(maximumColliderOffsets[index], Math.hypot(...collider.translation));
    for (const component of collider.translation) {
      scalar(collider.effectiveMass * component, 'collider weighted center');
    }
  }
  for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex++) {
    if (bodies[bodyIndex].type === 'dynamic' && massTotals[bodyIndex] === 0) {
      throw new TypeError(`dynamic body ${bodies[bodyIndex].name} requires a collider with mass`);
    }
  }
  const joints = rawJoints.map(joint => {
    fields(joint, ['name', 'type', 'bodyA', 'bodyB', 'anchorA', 'anchorB', 'axis', 'frameA', 'frameB', 'contactsEnabled', 'limits', 'motor', 'restLength', 'stiffness', 'damping'], `joint ${joint.name}`);
    if (!['spherical', 'revolute', 'prismatic', 'fixed', 'spring'].includes(joint.type)) {
      throw new TypeError('unsupported joint type');
    }
    const bodyA = bodyIndex(joint.bodyA);
    const bodyB = bodyIndex(joint.bodyB);
    if (bodyA === bodyB) {
      throw new TypeError('joint bodies must differ');
    }
    if (joint.contactsEnabled !== undefined && typeof joint.contactsEnabled !== 'boolean') {
      throw new TypeError('contactsEnabled must be boolean');
    }
    const unitJoint = joint.type === 'revolute' || joint.type === 'prismatic';
    if (!unitJoint && joint.axis !== undefined) {
      throw new TypeError('axis requires a revolute or prismatic joint');
    }
    if (!unitJoint && (joint.limits !== undefined || joint.motor !== undefined)) throw new TypeError('limits and motors require a revolute or prismatic joint');
    if (joint.type !== 'fixed' && (joint.frameA !== undefined || joint.frameB !== undefined)) {
      throw new TypeError('joint frames require a fixed joint');
    }
    if (joint.type !== 'spring' && (joint.restLength !== undefined || joint.stiffness !== undefined || joint.damping !== undefined)) {
      throw new TypeError('restLength, stiffness and damping require a spring joint');
    }
    const axis = unitJoint ? vector(joint.axis, 3, 'axis') : undefined;
    if (axis && Math.abs(Math.hypot(...axis) - 1) > 1e-4) {
      throw new RangeError('axis must be a unit vector');
    }
    if (axis) {
      const axisLength = Math.hypot(...axis);
      for (let component = 0; component < 3; component++) {
        axis[component] = Math.fround(axis[component] / axisLength);
      }
    }
    const result = {
      type: joint.type,
      bodyA,
      bodyB,
      anchorA: vector(joint.anchorA, 3, 'anchorA', ZERO),
      anchorB: vector(joint.anchorB, 3, 'anchorB', ZERO),
      axis,
      frameA: rotation(joint.frameA, 'frameA'),
      frameB: rotation(joint.frameB, 'frameB'),
      contactsEnabled: joint.contactsEnabled ?? false,
    };
    if (joint.type === 'spring') {
      result.restLength = scalar(joint.restLength ?? 0, 'restLength', 0, MAX_JOINT_DISTANCE);
      result.stiffness = positive(joint.stiffness, 'stiffness');
      if (result.stiffness > MAX_MOTOR_GAIN) throw new RangeError('spring stiffness exceeds the supported gain bound');
      result.damping = scalar(joint.damping ?? 0, 'damping', 0, MAX_MOTOR_GAIN);
    }
    if (joint.limits !== undefined) result.limits = jointLimits(joint.limits, joint.type);
    if (joint.motor !== undefined) result.motor = jointMotor(joint.motor, result);
    if (joint.type === 'prismatic' || joint.limits !== undefined || joint.motor !== undefined) initialJointCoordinate(result, bodies);
    return result;
  });
  const jointIndices = new Map(rawJoints.map((joint, index) => [joint.name, index]));
  const events = rawEvents.map((event, order) => {
    const tick = integer(event.tick, 'event tick', 0, frameCount - 2);
    const type = event.type ?? 'impulse';
    if (type === 'jointMotor') {
      fields(event, ['tick', 'type', 'joint', 'motor'], `event ${order}`);
      if (!jointIndices.has(event.joint)) throw new TypeError(`unknown joint ${event.joint}`);
      const joint = jointIndices.get(event.joint);
      if (!['revolute', 'prismatic'].includes(joints[joint].type)) throw new TypeError('motor events require a revolute or prismatic joint');
      initialJointCoordinate(joints[joint], bodies);
      return { tick, type, order, joint, motor: jointMotor(event.motor, joints[joint]) };
    }
    fields(event, ['tick', 'body', 'type', 'impulse', 'torqueImpulse', 'point', 'translation', 'rotation'], `event ${order}`);
    const body = bodyIndex(event.body);
    if (type === 'impulse') {
      if (bodies[body].type !== 'dynamic') {
        throw new TypeError('impulses require a dynamic body');
      }
      if (event.translation !== undefined || event.rotation !== undefined || (event.impulse === undefined && event.torqueImpulse === undefined) || (event.point !== undefined && event.impulse === undefined)) {
        throw new TypeError('invalid impulse event fields');
      }
      return {
        tick,
        body,
        type,
        order,
        impulse: event.impulse === undefined ? undefined : vector(event.impulse, 3, 'impulse'),
        torqueImpulse: event.torqueImpulse === undefined ? undefined : vector(event.torqueImpulse, 3, 'torqueImpulse'),
        point: event.point === undefined ? undefined : vector(event.point, 3, 'point'),
      };
    }
    if (type !== 'kinematicPose' || bodies[body].type !== 'kinematic') {
      throw new TypeError('kinematicPose events require a kinematic body');
    }
    if (event.impulse !== undefined || event.torqueImpulse !== undefined || event.point !== undefined || (event.translation === undefined && event.rotation === undefined)) {
      throw new TypeError('invalid kinematicPose event fields');
    }
    return {
      tick,
      body,
      type,
      order,
      translation: event.translation === undefined ? undefined : vector(event.translation, 3, 'event translation'),
      rotation: event.rotation === undefined ? undefined : rotation(event.rotation, 'event rotation'),
    };
  }).sort((firstEvent, secondEvent) => firstEvent.tick - secondEvent.tick || firstEvent.order - secondEvent.order);
  const forceFields = normalizeForceFields(definition.fields ?? [], 'fields');
  const gravity = vector(definition.gravity, 3, 'gravity', [0, -9.81, 0]);
  validateMotionBounds(bodies, events, gravity, forceFields, timestep, frameCount, massTotals, minimumInertiaTotals, maximumColliderOffsets, joints, inertiaTotals);
  const memoryPlan = Object.freeze({
    timelineBytes,
    solverReserveBytes,
    estimatedPeakBytes,
    maxMemoryBytes,
    bodyCount: bodies.length,
    colliderCount: colliders.length,
    jointCount: joints.length,
    eventCount: events.length,
    frameCount,
  });
  return {
    bodies,
    colliders,
    joints,
    events,
    fields: forceFields,
    gravity,
    frameCount,
    timestep,
    solverIterations,
    maxContactEvents: limits.maxContactEvents,
    memoryPlan,
  };
}

function validateMotorBounds(bodies, joints, events, timestep, duration, massTotals, minimumInertiaTotals, maximumInertiaTotals, maximumColliderOffsets, linearSpeedBounds, angularSpeedBounds) {
  const components = bodies.map((_, index) => index);
  function component(index) {
    while (components[index] !== index) index = components[index];
    return index;
  }
  for (const joint of joints) components[component(joint.bodyB)] = component(joint.bodyA);
  const peakForces = joints.map(() => 0);
  function motorBound(jointIndex, motor) {
    if (!motor) return;
    const joint = joints[jointIndex];
    if (bodies[joint.bodyA].type !== 'dynamic' && bodies[joint.bodyB].type !== 'dynamic') throw new TypeError('active motors need at least one directly attached dynamic body');
    normalPositive(motor.maxForce ** 2, 'motor force squared norm');
    normalPositive((motor.maxForce * timestep) ** 2, 'motor step impulse squared norm');
    if (motor.stiffness) normalPositive((motor.stiffness * timestep ** 2) ** 2, 'motor timestep stiffness squared');
    if (motor.damping) normalPositive((motor.damping * timestep) ** 2, 'motor timestep damping squared');
    if (motor.target !== 0) {
      normalPositive(motor.target ** 2, 'motor target squared norm');
      const gain = motor.mode === 'position' ? motor.stiffness : motor.damping;
      const commandedForce = Math.min(Math.abs(gain * motor.target), motor.maxForce);
      normalPositive((commandedForce * timestep) ** 2, 'motor commanded impulse squared norm');
    }
    peakForces[jointIndex] = Math.max(peakForces[jointIndex], motor.maxForce);
  }
  for (let index = 0; index < joints.length; index++) motorBound(index, joints[index].motor);
  for (const event of events) {
    if (event.type === 'jointMotor') motorBound(event.joint, event.motor);
  }
  const forceTotals = bodies.map(() => 0);
  const torqueTotals = bodies.map(() => 0);
  const leverArms = bodies.map(() => 0);
  for (let index = 0; index < bodies.length; index++) leverArms[component(index)] += maximumColliderOffsets[index];
  for (let index = 0; index < joints.length; index++) {
    const joint = joints[index];
    const root = component(joint.bodyA);
    leverArms[root] += Math.hypot(...joint.anchorA) + Math.hypot(...joint.anchorB);
    if (joint.type === 'prismatic') forceTotals[root] += peakForces[index];
    else torqueTotals[root] += peakForces[index];
  }
  for (let index = 0; index < bodies.length; index++) {
    if (bodies[index].type !== 'dynamic') continue;
    const root = component(index);
    const force = forceTotals[root];
    const torque = torqueTotals[root] + force * leverArms[root];
    if (!force && !torque) continue;
    scalar(force ** 2, 'combined motor force squared norm', 0);
    scalar(torque ** 2, 'combined motor torque squared norm', 0);
    if (force) normalPositive((force / massTotals[index]) ** 2, 'motor linear acceleration squared norm');
    if (torque) normalPositive((torque / maximumInertiaTotals[index]) ** 2, 'motor angular acceleration squared norm');
    const angularAcceleration = torque / minimumInertiaTotals[index];
    const linearAcceleration = force / massTotals[index] + angularAcceleration * leverArms[root];
    angularSpeedBounds[index] += angularAcceleration * duration;
    linearSpeedBounds[index] += linearAcceleration * duration;
    scalar(angularSpeedBounds[index] ** 2, 'motor-induced angular velocity squared norm', 0);
    scalar(linearSpeedBounds[index] ** 2, 'motor-induced linear velocity squared norm', 0);
    scalar((Math.hypot(...bodies[index].translation) + linearSpeedBounds[index] * duration) ** 2, 'motor-induced position squared norm', 0);
  }
}

function validateMotionBounds(bodies, events, gravity, forceFields, timestep, frameCount, massTotals, minimumInertiaTotals, maximumColliderOffsets, joints, maximumInertiaTotals) {
  const duration = (frameCount - 1) * timestep;
  const fieldMagnitude = forceFields.reduce((total, field) => total + (field.type === 'drag' ? 0 : Math.abs(field.strength)), 0);
  const gravityMagnitude = vectorLength(gravity, 'gravity') + fieldMagnitude;
  const linearSpeedBounds = bodies.map(body => {
    const initialSpeed = vectorLength(body.linearVelocity, 'linearVelocity');
    const speedBound = initialSpeed + (body.type === 'dynamic' ? gravityMagnitude * duration : 0);
    scalar(speedBound ** 2, 'accumulated linear velocity squared norm', 0);
    return speedBound;
  });
  const angularSpeedBounds = bodies.map(body => vectorLength(body.angularVelocity, 'angularVelocity'));

  // Ignore damping and contact resistance to bound all declared impulses conservatively.
  for (const event of events) {
    if (event.type !== 'impulse') {
      continue;
    }
    if (event.impulse) {
      const impulseMagnitude = vectorLength(event.impulse, 'impulse');
      linearSpeedBounds[event.body] += impulseMagnitude / massTotals[event.body];
      scalar(linearSpeedBounds[event.body] ** 2, 'accumulated linear velocity squared norm', 0);
    }
    if (event.torqueImpulse) {
      const torqueMagnitude = vectorLength(event.torqueImpulse, 'torqueImpulse');
      angularSpeedBounds[event.body] += torqueMagnitude / minimumInertiaTotals[event.body];
      scalar(angularSpeedBounds[event.body] ** 2, 'accumulated angular velocity squared norm', 0);
    }
  }

  validateMotorBounds(bodies, joints, events, timestep, duration, massTotals, minimumInertiaTotals, maximumInertiaTotals, maximumColliderOffsets, linearSpeedBounds, angularSpeedBounds);

  const kinematicTranslations = bodies.map(body => body.translation.slice());
  const kinematicTickBaseTranslations = bodies.map(body => body.translation.slice());
  const kinematicTicks = Array(bodies.length).fill(-1);
  for (const event of events) {
    const body = bodies[event.body];
    if (event.type === 'kinematicPose') {
      if (event.translation) {
        // Same-tick targets share the last integrated pose, and gaps hold that pose.
        if (kinematicTicks[event.body] !== event.tick) {
          kinematicTickBaseTranslations[event.body] = kinematicTranslations[event.body];
        }
        const previousTranslation = kinematicTickBaseTranslations[event.body];
        const targetVelocity = event.translation.map((component, axis) => (component - previousTranslation[axis]) / timestep);
        vectorLength(targetVelocity, 'kinematic target velocity');
        kinematicTranslations[event.body] = event.translation;
        kinematicTicks[event.body] = event.tick;
      }
      if (event.rotation) {
        scalar((Math.PI / timestep) ** 2, 'kinematic angular velocity squared norm', 0);
      }
      continue;
    }
    if (event.impulse && event.point) {
      const impulseMagnitude = vectorLength(event.impulse, 'impulse');
      const maximumTravel = linearSpeedBounds[event.body] * duration;
      const leverArm = Math.hypot(...event.point) + Math.hypot(...body.translation) + maximumTravel + maximumColliderOffsets[event.body];
      const torqueBound = impulseMagnitude * leverArm;
      scalar(torqueBound ** 2, 'off-center torque impulse squared norm', 0);
      angularSpeedBounds[event.body] += torqueBound / minimumInertiaTotals[event.body];
      scalar(angularSpeedBounds[event.body] ** 2, 'accumulated angular velocity squared norm', 0);
    }
  }
}

/** Validate and estimate memory without loading or allocating the Rapier WASM world. */
export function planPhysicsScene(definition, options = {}) {
  return prepare(definition, options).memoryPlan;
}

const xyz = array => ({ x: array[0], y: array[1], z: array[2] });
const xyzw = array => ({ ...xyz(array), w: array[3] });

function applyJointMotor(rapier, joint, motor) {
  joint.configureMotorModel(rapier.MotorModel.ForceBased);
  joint.setMotorMaxForce(motor?.maxForce ?? 0);
  if (!motor) joint.configureMotor(0, 0, 0, 0);
  else if (motor.mode === 'position') joint.configureMotorPosition(motor.target, motor.stiffness, motor.damping);
  else joint.configureMotorVelocity(motor.target, motor.damping);
  joint.body1().wakeUp();
  joint.body2().wakeUp();
}

/** Bake a named rigid-body graph with Rapier, then release its solver world. */
export async function createPhysicsScene(definition, options = {}) {
  const preparedScene = prepare(definition, options);
  await loadPhysicsEngine();
  return bakePrepared(preparedScene);
}

/** Synchronous bake for hosts that already awaited loadPhysicsEngine. */
export function bakePhysicsScene(definition, options = {}) {
  if (!rapierEngine) {
    throw new Error('Physics engine is not loaded. Await loadPhysicsEngine() first.');
  }
  return bakePrepared(prepare(definition, options));
}

function colliderDescriptor(rapier, collider) {
  let descriptor;
  if (collider.shape === 'ball') {
    descriptor = rapier.ColliderDesc.ball(collider.radius);
  } else if (collider.shape === 'cuboid') {
    descriptor = rapier.ColliderDesc.cuboid(...collider.halfExtents);
  } else if (collider.shape === 'capsule') {
    descriptor = rapier.ColliderDesc.capsule(collider.halfHeight, collider.radius);
  } else if (collider.shape === 'cylinder') {
    descriptor = rapier.ColliderDesc.cylinder(collider.halfHeight, collider.radius);
  } else if (collider.shape === 'cone') {
    descriptor = rapier.ColliderDesc.cone(collider.halfHeight, collider.radius);
  } else if (collider.shape === 'convexHull') {
    descriptor = rapier.ColliderDesc.convexHull(collider.points);
    if (!descriptor) {
      throw new RangeError('convexHull points are degenerate: they must span a volume');
    }
  } else {
    descriptor = rapier.ColliderDesc.trimesh(collider.vertices, collider.indices);
  }
  descriptor.setTranslation(...collider.translation);
  descriptor.setRotation(xyzw(collider.rotation));
  descriptor.setFriction(collider.friction);
  descriptor.setRestitution(collider.restitution);
  descriptor.setSensor(collider.sensor);
  descriptor.setCollisionGroups(((collider.groups << 16) | collider.mask) >>> 0);
  descriptor.setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS);
  if (collider.shape !== 'trimesh') {
    if (collider.mass === undefined) {
      descriptor.setDensity(collider.density);
    } else {
      descriptor.setMass(collider.mass);
    }
  }
  return descriptor;
}

/** Build the Rapier world for a prepared scene. Shared by the recorded bake and the live runtime. Frees itself on failure. */
export function createRapierWorld(rapier, preparedScene) {
  const world = new rapier.World(xyz(preparedScene.gravity));
  const colliderIndices = new Map();
  try {
    world.timestep = preparedScene.timestep;
    world.numSolverIterations = preparedScene.solverIterations;
    const bodies = preparedScene.bodies.map(body => {
      let descriptor;
      if (body.type === 'dynamic') {
        descriptor = rapier.RigidBodyDesc.dynamic();
      } else if (body.type === 'fixed') {
        descriptor = rapier.RigidBodyDesc.fixed();
      } else {
        descriptor = rapier.RigidBodyDesc.kinematicPositionBased();
      }
      descriptor.setTranslation(...body.translation);
      descriptor.setRotation(xyzw(body.rotation));
      if (body.type === 'dynamic') {
        descriptor.setLinvel(...body.linearVelocity);
        descriptor.setAngvel(xyz(body.angularVelocity));
        descriptor.setLinearDamping(body.linearDamping);
        descriptor.setAngularDamping(body.angularDamping);
        descriptor.setCcdEnabled(body.ccd);
      }
      return world.createRigidBody(descriptor);
    });
    preparedScene.colliders.forEach((collider, colliderIndex) => {
      const created = world.createCollider(colliderDescriptor(rapier, collider), bodies[collider.body]);
      colliderIndices.set(created.handle, colliderIndex);
    });
    const joints = preparedScene.joints.map(joint => {
      const anchorA = xyz(joint.anchorA);
      const anchorB = xyz(joint.anchorB);
      let descriptor;
      if (joint.type === 'spherical') {
        descriptor = rapier.JointData.spherical(anchorA, anchorB);
      } else if (joint.type === 'revolute') {
        descriptor = rapier.JointData.revolute(anchorA, anchorB, xyz(joint.axis));
      } else if (joint.type === 'prismatic') {
        descriptor = rapier.JointData.prismatic(anchorA, anchorB, xyz(joint.axis));
      } else if (joint.type === 'spring') {
        descriptor = rapier.JointData.spring(joint.restLength, joint.stiffness, joint.damping, anchorA, anchorB);
      } else {
        descriptor = rapier.JointData.fixed(anchorA, xyzw(joint.frameA), anchorB, xyzw(joint.frameB));
      }
      const created = world.createImpulseJoint(descriptor, bodies[joint.bodyA], bodies[joint.bodyB], true);
      created.setContactsEnabled(joint.contactsEnabled);
      if (joint.limits) created.setLimits(...joint.limits);
      if (joint.motor !== undefined) applyJointMotor(rapier, created, joint.motor);
      return created;
    });
    return { world, bodies, joints, colliderIndices };
  } catch (error) {
    world.free();
    throw error;
  }
}

/** Push every dynamic body by the force fields at `fieldTime`, as one impulse over a step. */
export function applyForceFieldImpulses(preparedScene, bodies, fieldTime) {
  const fieldAccel = [0, 0, 0];
  for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex++) {
    if (preparedScene.bodies[bodyIndex].type !== 'dynamic') continue;
    const body = bodies[bodyIndex];
    const pos = body.translation();
    const vel = body.linvel();
    evaluateForceFields(preparedScene.fields, [pos.x, pos.y, pos.z], [vel.x, vel.y, vel.z], fieldTime, fieldAccel);
    const scale = body.mass() * preparedScene.timestep;
    if (fieldAccel[0] || fieldAccel[1] || fieldAccel[2]) {
      body.applyImpulse({ x: fieldAccel[0] * scale, y: fieldAccel[1] * scale, z: fieldAccel[2] * scale }, true);
    }
  }
}

function bakePrepared(preparedScene) {
  const rapier = rapierEngine;
  const { world, bodies, joints, colliderIndices } = createRapierWorld(rapier, preparedScene);
  const eventQueue = new rapier.EventQueue(true);
  const contactEvents = [];
  const lastMovingFrames = new Int32Array(preparedScene.bodies.length).fill(-1);
  let contactEventsTruncated = false;
  let timeline;
  try {
    timeline = new Float32Array(preparedScene.memoryPlan.timelineBytes / 4);
    let eventIndex = 0;
    for (let frame = 0; frame < preparedScene.frameCount; frame++) {
      if (frame > 0) {
        while (eventIndex < preparedScene.events.length && preparedScene.events[eventIndex].tick === frame - 1) {
          const event = preparedScene.events[eventIndex];
          eventIndex++;
          if (event.type === 'jointMotor') {
            applyJointMotor(rapier, joints[event.joint], event.motor);
            continue;
          }
          const body = bodies[event.body];
          if (event.type === 'kinematicPose') {
            if (event.translation) {
              body.setNextKinematicTranslation(xyz(event.translation));
            }
            if (event.rotation) {
              body.setNextKinematicRotation(xyzw(event.rotation));
            }
          } else {
            if (event.impulse) {
              if (event.point) {
                body.applyImpulseAtPoint(xyz(event.impulse), xyz(event.point), true);
              } else {
                body.applyImpulse(xyz(event.impulse), true);
              }
            }
            if (event.torqueImpulse) {
              body.applyTorqueImpulse(xyz(event.torqueImpulse), true);
            }
          }
        }
        if (preparedScene.fields.length) applyForceFieldImpulses(preparedScene, bodies, (frame - 1) * preparedScene.timestep);
        world.step(eventQueue);
        eventQueue.drainCollisionEvents((firstHandle, secondHandle, started) => {
          if (contactEvents.length >= preparedScene.maxContactEvents) {
            contactEventsTruncated = true;
            return;
          }
          const first = colliderIndices.get(firstHandle);
          const second = colliderIndices.get(secondHandle);
          const sensor = preparedScene.colliders[first].sensor || preparedScene.colliders[second].sensor;
          contactEvents.push(Object.freeze({ frame, kind: sensor ? 'sensor' : 'contact', started, colliderA: first, colliderB: second }));
        });
      }
      for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex++) {
        const linearVelocity = bodies[bodyIndex].linvel();
        const angularVelocity = bodies[bodyIndex].angvel();
        scalar(linearVelocity.x ** 2 + linearVelocity.y ** 2 + linearVelocity.z ** 2, 'solver linear velocity squared norm', 0);
        scalar(angularVelocity.x ** 2 + angularVelocity.y ** 2 + angularVelocity.z ** 2, 'solver angular velocity squared norm', 0);
        if (Math.hypot(linearVelocity.x, linearVelocity.y, linearVelocity.z) > REST_LINEAR_SPEED || Math.hypot(angularVelocity.x, angularVelocity.y, angularVelocity.z) > REST_ANGULAR_SPEED) {
          lastMovingFrames[bodyIndex] = frame;
        }
        const position = bodies[bodyIndex].translation();
        const bodyRotation = bodies[bodyIndex].rotation();
        const offset = (frame * bodies.length + bodyIndex) * 7;
        timeline[offset] = position.x;
        timeline[offset + 1] = position.y;
        timeline[offset + 2] = position.z;
        timeline[offset + 3] = bodyRotation.x;
        timeline[offset + 4] = bodyRotation.y;
        timeline[offset + 5] = bodyRotation.z;
        timeline[offset + 6] = bodyRotation.w;
        for (let component = 0; component < 7; component++) {
          if (!Number.isFinite(timeline[offset + component])) {
            throw new RangeError(`solver produced nonfinite pose at frame ${frame}, body ${preparedScene.bodies[bodyIndex].name}`);
          }
        }
        const quaternionLength = Math.hypot(bodyRotation.x, bodyRotation.y, bodyRotation.z, bodyRotation.w);
        if (!quaternionLength || Math.abs(quaternionLength - 1) > 1e-3) {
          throw new RangeError('solver produced invalid quaternion');
        }
      }
    }
  } finally {
    eventQueue.free();
    world.free();
  }
  return recordedScene(preparedScene, timeline, { contactEvents, contactEventsTruncated, lastMovingFrames });
}

function recordedScene(preparedScene, timeline, recording) {
  const bodyNames = Object.freeze(preparedScene.bodies.map(body => body.name));
  const indices = new Map(bodyNames.map((name, index) => [name, index]));
  const poseStride = bodyNames.length * 7;
  const duration = (preparedScene.frameCount - 1) * preparedScene.timestep;
  function ensureAlive() {
    if (!timeline) {
      throw new Error('physics scene is disposed');
    }
  }
  function bodyIndex(name) {
    ensureAlive();
    if (!indices.has(name)) {
      throw new TypeError(`unknown body ${name}`);
    }
    return indices.get(name);
  }
  function sample(time, output) {
    ensureAlive();
    if (typeof time !== 'number' || !Number.isFinite(time)) {
      throw new RangeError('sample time must be finite');
    }
    output ??= new Float32Array(poseStride);
    if (!(output instanceof Float32Array) || output.length !== poseStride) {
      throw new TypeError(`sample output must be Float32Array(${poseStride})`);
    }
    let frame = Math.max(0, Math.min(duration, time)) / preparedScene.timestep;
    const nearestFrame = Math.round(frame);
    if (Math.abs(frame - nearestFrame) <= Number.EPSILON * Math.max(1, frame) * 4) {
      frame = nearestFrame;
    }
    const leftFrame = Math.min(preparedScene.frameCount - 1, Math.floor(frame));
    const rightFrame = Math.min(preparedScene.frameCount - 1, leftFrame + 1);
    const interpolation = frame - leftFrame;
    for (let bodyIndex = 0; bodyIndex < bodyNames.length; bodyIndex++) {
      const outputOffset = bodyIndex * 7;
      const leftOffset = leftFrame * poseStride + outputOffset;
      const rightOffset = rightFrame * poseStride + outputOffset;
      for (let axis = 0; axis < 3; axis++) {
        output[outputOffset + axis] = timeline[leftOffset + axis] * (1 - interpolation) + timeline[rightOffset + axis] * interpolation;
      }
      if (interpolation === 0 || leftFrame === rightFrame) {
        for (let component = 3; component < 7; component++) {
          output[outputOffset + component] = timeline[leftOffset + component];
        }
        continue;
      }
      let quaternionDot = 0;
      for (let component = 3; component < 7; component++) {
        quaternionDot += timeline[leftOffset + component] * timeline[rightOffset + component];
      }
      const quaternionSign = quaternionDot < 0 ? -1 : 1;
      quaternionDot = Math.min(1, Math.abs(quaternionDot));
      let leftWeight = 1 - interpolation;
      let rightWeight = interpolation;
      if (quaternionDot < 0.9995) {
        const angle = Math.acos(quaternionDot);
        const angleSine = Math.sin(angle);
        leftWeight = Math.sin((1 - interpolation) * angle) / angleSine;
        rightWeight = Math.sin(interpolation * angle) / angleSine;
      }
      let quaternionLengthSquared = 0;
      for (let component = 3; component < 7; component++) {
        const interpolatedComponent = leftWeight * timeline[leftOffset + component] + quaternionSign * rightWeight * timeline[rightOffset + component];
        output[outputOffset + component] = interpolatedComponent;
        quaternionLengthSquared += interpolatedComponent ** 2;
      }
      const quaternionLength = Math.sqrt(quaternionLengthSquared);
      for (let component = 3; component < 7; component++) {
        output[outputOffset + component] /= quaternionLength;
      }
    }
    return output;
  }
  function bindParts(bindings) {
    ensureAlive();
    if (!Array.isArray(bindings) || bindings.length > preparedScene.memoryPlan.bodyCount * 16) {
      throw new RangeError('bindings must be a bounded array');
    }
    const matrices = new Set();
    const matricesByBuffer = new Map();
    const retainedBindings = bindings.map(binding => {
      fields(binding, ['body', 'part'], 'binding');
      const index = bodyIndex(binding.body);
      const matrix = binding.part?.matrix;
      if (!(matrix instanceof Float32Array) || matrix.length !== 16 || matrices.has(matrix)) {
        throw new TypeError('each binding requires a distinct retained Float32 part.matrix');
      }
      matrices.add(matrix);
      let bufferMatrices = matricesByBuffer.get(matrix.buffer);
      if (!bufferMatrices) {
        bufferMatrices = [];
        matricesByBuffer.set(matrix.buffer, bufferMatrices);
      }
      bufferMatrices.push(matrix);
      for (const value of matrix) {
        scalar(value, 'binding matrix');
      }
      if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) {
        throw new TypeError('binding matrix must be affine');
      }
      const scale = [Math.hypot(matrix[0], matrix[1], matrix[2]), Math.hypot(matrix[4], matrix[5], matrix[6]), Math.hypot(matrix[8], matrix[9], matrix[10])];
      for (const size of scale) {
        positive(size, 'binding scale');
      }
      for (const [firstAxis, secondAxis] of [[0, 1], [0, 2], [1, 2]]) {
        const axisDot = matrix[firstAxis * 4] * matrix[secondAxis * 4] + matrix[firstAxis * 4 + 1] * matrix[secondAxis * 4 + 1] + matrix[firstAxis * 4 + 2] * matrix[secondAxis * 4 + 2];
        if (Math.abs(axisDot / scale[firstAxis] / scale[secondAxis]) > 1e-5) {
          throw new TypeError('binding matrix shear is unsupported');
        }
      }
      if (mat4.determinant(matrix) < 0) {
        scale[0] *= -1;
      }
      return {
        part: binding.part,
        matrix,
        index,
        scale,
        position: new Float32Array(3),
        rotation: quat.create(),
        scratchMatrix: mat4.create(),
      };
    });
    for (const bufferMatrices of matricesByBuffer.values()) {
      bufferMatrices.sort((firstMatrix, secondMatrix) => firstMatrix.byteOffset - secondMatrix.byteOffset);
      for (let matrixIndex = 1; matrixIndex < bufferMatrices.length; matrixIndex++) {
        const previousMatrix = bufferMatrices[matrixIndex - 1];
        const currentMatrix = bufferMatrices[matrixIndex];
        if (previousMatrix.byteOffset + previousMatrix.byteLength > currentMatrix.byteOffset) {
          throw new TypeError('binding matrix views must not overlap');
        }
      }
    }
    const sampledPose = new Float32Array(poseStride);
    return Object.freeze({
      apply(time) {
        ensureAlive();
        for (let bindingIndex = 0; bindingIndex < retainedBindings.length; bindingIndex++) {
          if (retainedBindings[bindingIndex].part.matrix !== retainedBindings[bindingIndex].matrix) {
            throw new Error('binding part.matrix identity changed');
          }
        }
        sample(time, sampledPose);
        for (let bindingIndex = 0; bindingIndex < retainedBindings.length; bindingIndex++) {
          const binding = retainedBindings[bindingIndex];
          const offset = binding.index * 7;
          for (let axis = 0; axis < 3; axis++) {
            binding.position[axis] = sampledPose[offset + axis];
          }
          for (let component = 0; component < 4; component++) {
            binding.rotation[component] = sampledPose[offset + component + 3];
          }
          mat4.fromRotationTranslationScale(binding.scratchMatrix, binding.rotation, binding.position, binding.scale);
          for (let component = 0; component < 16; component++) {
            if (!Number.isFinite(binding.scratchMatrix[component])) {
              throw new RangeError('binding transform exceeds Float32 range');
            }
          }
        }
        for (let bindingIndex = 0; bindingIndex < retainedBindings.length; bindingIndex++) {
          retainedBindings[bindingIndex].matrix.set(retainedBindings[bindingIndex].scratchMatrix);
        }
        return bindings;
      },
    });
  }
  return Object.freeze({
    bodyNames,
    frameCount: preparedScene.frameCount,
    timestep: preparedScene.timestep,
    duration,
    memoryPlan: preparedScene.memoryPlan,
    bodyIndex,
    sample,
    bindParts,
    colliderNames: Object.freeze(preparedScene.colliders.map(collider => preparedScene.bodies[collider.body].name)),
    /** Contact and sensor start or stop events in step order, with collider indices into colliderNames. */
    contactEvents: Object.freeze(recording.contactEvents),
    contactEventsTruncated: recording.contactEventsTruncated,
    /** Per body: the frame at which it came to rest and stayed there, or -1 while it still moves at the end. */
    restFrames: Object.freeze(Array.from(recording.lastMovingFrames, frame => frame < preparedScene.frameCount - 1 ? frame + 1 : -1)),
    dispose() {
      timeline = null;
    },
    get disposed() {
      return timeline === null;
    },
  });
}

/** Validate a definition for the live runtime. There is no timeline, so the frame count is 1 and tick events are not accepted. */
export function prepareLivePhysics(definition, options = {}) {
  if (definition && definition.events !== undefined && definition.events.length) {
    throw new TypeError('a live physics definition takes no events; call applyImpulse, setKinematicPose or setLinearVelocity on the system instead');
  }
  const prepared = prepare({ ...definition, events: [] }, { ...options, frameCount: 1 });
  return prepared;
}

/** The loaded Rapier module, or throws when loadPhysicsEngine has not resolved. */
export function requireRapier() {
  if (!rapierEngine) throw new Error('Physics engine is not loaded. Await loadPhysicsEngine() first.');
  return rapierEngine;
}
