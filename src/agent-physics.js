import { mat4, vec3 } from 'gl-matrix';
import { invalidField } from './field-error.js';
import { restWorldMatrix, boneTails, boneNodeId } from './rig.js';
import { createRagdoll, ragdollPatches, ragdollReport } from './ragdoll.js';
import { bakePhysicsScene, loadPhysicsEngine, physicsEngineLoaded, setPhysicsModuleLoader } from './physics.js';
import { normalizeForceFields } from './force-fields.js';

export { loadPhysicsEngine, physicsEngineLoaded, setPhysicsModuleLoader };
export { needsPhysics } from './agent-scene-modules.js';

const FRAMES_PER_SECOND = 60;
const MAX_DURATION_SECONDS = 10;
const MAX_BODIES = 64;
const MAX_JOINTS = 64;
const MAX_LAYER = 15;
const MAX_TRIMESH_TRIANGLES = 20000;
const MAX_HULL_POINTS = 2048;
const MAX_SOURCE_VERTICES = 65536;
const MAX_REPORTED_CONTACTS = 64;
const MAX_REPORTED_SENSOR_EVENTS = 128;
const MAX_EVENTS = 128;
const MAX_COMPOUND_SHAPES = 16;
const BODY_TYPES = ['dynamic', 'fixed', 'kinematic'];
const SHAPES = ['box', 'ball', 'capsule', 'cylinder', 'cone', 'convex', 'trimesh', 'compound'];
const COMPOUND_PART_SHAPES = ['box', 'ball', 'capsule', 'cylinder', 'cone'];
const JOINT_TYPES = ['spherical', 'revolute', 'prismatic', 'fixed', 'spring'];
const BODY_FIELDS = ['node', 'type', 'shape', 'shapes', 'mass', 'density', 'friction', 'restitution', 'sensor', 'velocity', 'angularVelocity', 'layer', 'collidesWith'];
const COMPOUND_PART_FIELDS = ['shape', 'translation', 'rotation', 'halfExtents', 'radius', 'halfHeight'];
const JOINT_FIELDS = ['name', 'type', 'bodyA', 'bodyB', 'anchorA', 'anchorB', 'axis', 'limits', 'motor', 'restLength', 'stiffness', 'damping', 'contactsEnabled', 'breakImpulse'];
const MOTOR_FIELDS = ['mode', 'target', 'stiffness', 'damping', 'maxForce'];
const EVENT_FIELDS = ['time', 'tick', 'type', 'body', 'joint', 'impulse', 'torqueImpulse', 'point', 'translation', 'rotation', 'motor'];
const PHYSICS_FIELDS = ['duration', 'gravity', 'bodies', 'joints', 'events', 'fields', 'ragdoll'];
const RAGDOLL_FIELDS = ['armature', 'density', 'friction', 'restitution', 'layer'];

function knownKeys(value, fields, path) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalidField(path, value, 'a plain object, such as {}', TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) {
      throw invalidField(`${path}.${key}`, value[key], `no such field; use one of ${fields.join(', ')}`, TypeError);
    }
  }
}

function finiteNumber(value, path, minimum = -Infinity, maximum = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || value < minimum || value > maximum) {
    const bounded = Number.isFinite(minimum) && Number.isFinite(maximum);
    const range = bounded ? `from ${minimum} to ${maximum}` : 'that fits Float32';
    const example = bounded ? Math.min(Math.max(1, minimum), maximum) : 1;
    throw invalidField(path, value, `a number ${range}, such as ${example}`);
  }
  return value;
}

function numberList(value, size, path) {
  if (!Array.isArray(value) || value.length !== size) {
    throw invalidField(path, value, `an array of ${size} numbers, such as [${Array(size).fill(0).join(', ')}]`, TypeError);
  }
  return value.map((component, index) => finiteNumber(component, `${path}[${index}]`));
}

function nodeIdentifier(value, path) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw invalidField(path, value, 'a node ID of 1 to 128 characters, such as "crate"', TypeError);
  }
  return value;
}

function boundedArray(value, maximum, path) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw invalidField(path, Array.isArray(value) ? `${value.length} entries` : value, `an array of at most ${maximum} entries, such as []`, TypeError);
  }
  return value;
}

function normalizeBody(input, recipeNodes, motionNodeIds, claimedNodes, path) {
  knownKeys(input, BODY_FIELDS, path);
  const nodeId = nodeIdentifier(input.node, `${path}.node`);
  const node = recipeNodes.get(nodeId);
  if (!node) {
    throw invalidField(`${path}.node`, nodeId, `the ID of a recipe node, one of ${[...recipeNodes.keys()].slice(0, 5).join(', ') || 'none yet'}`);
  }
  if (node.geometry === undefined) {
    throw invalidField(`${path}.node`, nodeId, 'a node with a geometry to fit a collider to; set geometry on it or pick another node');
  }
  if (node.parent !== null) {
    throw invalidField(`${path}.node`, nodeId, 'a root node, with no parent; reparent it or move its parent into the body');
  }
  if (claimedNodes.has(nodeId)) {
    throw invalidField(`${path}.node`, nodeId, 'a node with one physics body only; this one already has another');
  }
  if (motionNodeIds.has(nodeId)) {
    throw invalidField(`${path}.node`, nodeId, 'a node without a motion translation or rotation track; pick the track or the body, not both');
  }
  claimedNodes.add(nodeId);
  const type = input.type ?? 'dynamic';
  if (!BODY_TYPES.includes(type)) {
    throw invalidField(`${path}.type`, type, `one of ${BODY_TYPES.join(', ')}`);
  }
  if (input.sensor !== undefined && typeof input.sensor !== 'boolean') {
    throw invalidField(`${path}.sensor`, input.sensor, 'true or false', TypeError);
  }
  const sensor = input.sensor ?? false;
  const shape = input.shape ?? (sensor ? 'box' : type === 'dynamic' ? 'box' : 'trimesh');
  if (!SHAPES.includes(shape)) {
    throw invalidField(`${path}.shape`, shape, `one of ${SHAPES.join(', ')}`);
  }
  if (shape === 'trimesh' && type === 'dynamic') {
    throw invalidField(`${path}.shape`, shape, 'one of convex, box, ball or capsule for a dynamic body; trimesh is for fixed or kinematic bodies');
  }
  if (type !== 'dynamic' && (input.velocity !== undefined || input.angularVelocity !== undefined)) {
    const field = input.velocity !== undefined ? 'velocity' : 'angularVelocity';
    throw invalidField(`${path}.${field}`, input[field], `no velocity since the body is ${type}; only dynamic bodies take one, such as type "dynamic"`, TypeError);
  }
  if (input.mass !== undefined && input.density !== undefined) {
    throw invalidField(`${path}.density`, input.density, 'mass or density, not both; drop one, such as density 1', TypeError);
  }
  const body = { node: nodeId, type, shape };
  if (sensor) body.sensor = true;
  if (input.mass !== undefined) body.mass = finiteNumber(input.mass, `${path}.mass`, 1e-6, 1e9);
  if (input.density !== undefined) body.density = finiteNumber(input.density, `${path}.density`, 1e-6, 1e9);
  if (input.friction !== undefined) body.friction = finiteNumber(input.friction, `${path}.friction`, 0, 100);
  if (input.restitution !== undefined) body.restitution = finiteNumber(input.restitution, `${path}.restitution`, 0, 1);
  if (input.velocity !== undefined) body.velocity = numberList(input.velocity, 3, `${path}.velocity`);
  if (input.angularVelocity !== undefined) body.angularVelocity = numberList(input.angularVelocity, 3, `${path}.angularVelocity`);
  if (input.layer !== undefined) body.layer = Math.trunc(finiteNumber(input.layer, `${path}.layer`, 0, MAX_LAYER));
  if (shape === 'compound') {
    const parts = boundedArray(input.shapes, MAX_COMPOUND_SHAPES, `${path}.shapes`);
    if (!parts.length) {
      throw invalidField(`${path}.shapes`, parts, 'at least one sub-collider when shape is "compound", such as [{ "shape": "box", "halfExtents": [0.5, 0.5, 0.5] }]');
    }
    body.shapes = parts.map((part, index) => normalizeCompoundPart(part, `${path}.shapes[${index}]`));
  } else if (input.shapes !== undefined) {
    throw invalidField(`${path}.shapes`, input.shapes, 'a field left out unless shape is "compound"', TypeError);
  }
  if (input.collidesWith !== undefined) {
    const layers = boundedArray(input.collidesWith, MAX_LAYER + 1, `${path}.collidesWith`);
    body.collidesWith = [...new Set(layers.map((layer, index) => Math.trunc(finiteNumber(layer, `${path}.collidesWith[${index}]`, 0, MAX_LAYER))))].sort((first, second) => first - second);
  }
  return body;
}

function normalizeCompoundPart(input, path) {
  knownKeys(input, COMPOUND_PART_FIELDS, path);
  if (!COMPOUND_PART_SHAPES.includes(input.shape)) {
    throw invalidField(`${path}.shape`, input.shape, `one of ${COMPOUND_PART_SHAPES.join(', ')}`);
  }
  const part = { shape: input.shape };
  if (input.translation !== undefined) part.translation = numberList(input.translation, 3, `${path}.translation`);
  if (input.rotation !== undefined) part.rotation = numberList(input.rotation, 4, `${path}.rotation`);
  if (input.shape === 'box') {
    part.halfExtents = numberList(input.halfExtents, 3, `${path}.halfExtents`).map((extent, index) => finiteNumber(extent, `${path}.halfExtents[${index}]`, 1e-4, 1e6));
  } else if (input.shape === 'ball') {
    part.radius = finiteNumber(input.radius, `${path}.radius`, 1e-4, 1e6);
  } else {
    part.radius = finiteNumber(input.radius, `${path}.radius`, 1e-4, 1e6);
    part.halfHeight = finiteNumber(input.halfHeight, `${path}.halfHeight`, 1e-4, 1e6);
  }
  return part;
}

function normalizeMotor(input, path) {
  if (input === null) return null;
  knownKeys(input, MOTOR_FIELDS, path);
  if (!['position', 'velocity'].includes(input.mode)) {
    throw invalidField(`${path}.mode`, input.mode, 'one of position, velocity');
  }
  const motor = {
    mode: input.mode,
    target: finiteNumber(input.target, `${path}.target`, -1e4, 1e4),
    damping: finiteNumber(input.damping ?? (input.mode === 'velocity' ? 10 : 0), `${path}.damping`, 0, 1e6),
    maxForce: finiteNumber(input.maxForce ?? 1e4, `${path}.maxForce`, 1e-6, 1e8),
  };
  if (input.mode === 'position') {
    motor.stiffness = finiteNumber(input.stiffness ?? 100, `${path}.stiffness`, 1e-6, 1e6);
  } else if (input.stiffness !== undefined) {
    throw invalidField(`${path}.stiffness`, input.stiffness, 'a field left out for velocity motors', TypeError);
  }
  return motor;
}

function normalizeJoint(input, bodyNodeIds, jointNames, path) {
  knownKeys(input, JOINT_FIELDS, path);
  if (!JOINT_TYPES.includes(input.type)) {
    throw invalidField(`${path}.type`, input.type, `one of ${JOINT_TYPES.join(', ')}`);
  }
  for (const field of ['bodyA', 'bodyB']) {
    if (!bodyNodeIds.has(input[field])) {
      throw invalidField(`${path}.${field}`, input[field], `the node of a physics body, one of ${[...bodyNodeIds].slice(0, 5).join(', ') || 'none yet'}`);
    }
  }
  const joint = { type: input.type, bodyA: input.bodyA, bodyB: input.bodyB };
  if (input.name !== undefined) {
    const name = nodeIdentifier(input.name, `${path}.name`);
    if (jointNames.has(name)) {
      throw invalidField(`${path}.name`, name, 'a unique joint name');
    }
    jointNames.add(name);
    joint.name = name;
  }
  for (const field of ['anchorA', 'anchorB', 'axis']) {
    if (input[field] !== undefined) joint[field] = numberList(input[field], 3, `${path}.${field}`);
  }
  if (input.contactsEnabled !== undefined) {
    if (typeof input.contactsEnabled !== 'boolean') {
      throw invalidField(`${path}.contactsEnabled`, input.contactsEnabled, 'true or false', TypeError);
    }
    joint.contactsEnabled = input.contactsEnabled;
  }
  if (input.breakImpulse !== undefined) {
    if (input.type !== 'fixed') {
      throw invalidField(`${path}.breakImpulse`, input.breakImpulse, 'a field left out unless joint type is "fixed"', TypeError);
    }
    joint.breakImpulse = finiteNumber(input.breakImpulse, `${path}.breakImpulse`, 1e-6, 1e9);
  }
  if (input.limits !== undefined) joint.limits = numberList(input.limits, 2, `${path}.limits`);
  if (input.motor !== undefined) joint.motor = normalizeMotor(input.motor, `${path}.motor`);
  if (input.type === 'spring') {
    joint.restLength = finiteNumber(input.restLength ?? 0, `${path}.restLength`, 0, 1e6);
    joint.stiffness = finiteNumber(input.stiffness, `${path}.stiffness`, 1e-6, 1e6);
    if (input.damping !== undefined) joint.damping = finiteNumber(input.damping, `${path}.damping`, 0, 1e6);
  } else if (input.restLength !== undefined || input.stiffness !== undefined || input.damping !== undefined) {
    throw invalidField(`${path}.stiffness`, input.stiffness ?? input.restLength ?? input.damping, 'a field left out unless joint type is "spring"', TypeError);
  }
  return joint;
}

function normalizeEvent(input, duration, bodyTypes, jointNames, path) {
  knownKeys(input, EVENT_FIELDS, path);
  const type = input.type ?? 'impulse';
  if (!['impulse', 'kinematicPose', 'jointMotor'].includes(type)) {
    throw invalidField(`${path}.type`, type, 'one of impulse, kinematicPose, jointMotor');
  }
  const maxTick = Math.max(0, Math.round(duration * FRAMES_PER_SECOND) - 1);
  let tick;
  if (input.tick !== undefined) {
    tick = Math.trunc(finiteNumber(input.tick, `${path}.tick`, 0, maxTick));
  } else {
    const time = finiteNumber(input.time ?? 0, `${path}.time`, 0, duration);
    tick = Math.min(maxTick, Math.max(0, Math.round(time * FRAMES_PER_SECOND)));
  }
  if (type === 'jointMotor') {
    if (!jointNames.has(input.joint)) {
      throw invalidField(`${path}.joint`, input.joint, `the name of a physics joint, one of ${[...jointNames].slice(0, 5).join(', ') || 'none yet'}`);
    }
    return { tick, type, joint: input.joint, motor: normalizeMotor(input.motor, `${path}.motor`) };
  }
  if (!bodyTypes.has(input.body)) {
    throw invalidField(`${path}.body`, input.body, `the node of a physics body, one of ${[...bodyTypes.keys()].slice(0, 5).join(', ') || 'none yet'}`);
  }
  const event = { tick, type, body: input.body };
  if (type === 'impulse') {
    if (bodyTypes.get(input.body) !== 'dynamic') {
      throw invalidField(`${path}.body`, input.body, 'a dynamic body for an impulse event');
    }
    if (input.impulse === undefined && input.torqueImpulse === undefined) {
      throw invalidField(`${path}.impulse`, undefined, 'impulse or torqueImpulse on an impulse event, such as [0, 5, 0]');
    }
    if (input.impulse !== undefined) event.impulse = numberList(input.impulse, 3, `${path}.impulse`);
    if (input.torqueImpulse !== undefined) event.torqueImpulse = numberList(input.torqueImpulse, 3, `${path}.torqueImpulse`);
    if (input.point !== undefined) event.point = numberList(input.point, 3, `${path}.point`);
    return event;
  }
  if (bodyTypes.get(input.body) !== 'kinematic') {
    throw invalidField(`${path}.body`, input.body, 'a kinematic body for a kinematicPose event');
  }
  if (input.translation === undefined && input.rotation === undefined) {
    throw invalidField(`${path}.translation`, undefined, 'translation or rotation on a kinematicPose event, such as [1, 0, 0]');
  }
  if (input.translation !== undefined) event.translation = numberList(input.translation, 3, `${path}.translation`);
  if (input.rotation !== undefined) event.rotation = numberList(input.rotation, 4, `${path}.rotation`);
  return event;
}

function normalizeRagdoll(input, recipe, motionNodeIds) {
  knownKeys(input, RAGDOLL_FIELDS, 'physics.ragdoll');
  const armature = (recipe.armatures ?? []).find(candidate => candidate.id === input.armature);
  if (!armature) {
    const known = (recipe.armatures ?? []).slice(0, 5).map(candidate => candidate.id).join(', ') || 'none yet; add one to the recipe armatures';
    throw invalidField('physics.ragdoll.armature', input.armature, `the ID of a recipe armature, one of ${known}`);
  }
  const ragdoll = { armature: armature.id };
  if (input.density !== undefined) ragdoll.density = finiteNumber(input.density, 'physics.ragdoll.density', 1e-6, 1e9);
  if (input.friction !== undefined) ragdoll.friction = finiteNumber(input.friction, 'physics.ragdoll.friction', 0, 100);
  if (input.restitution !== undefined) ragdoll.restitution = finiteNumber(input.restitution, 'physics.ragdoll.restitution', 0, 1);
  if (input.layer !== undefined) ragdoll.layer = Math.trunc(finiteNumber(input.layer, 'physics.ragdoll.layer', 0, MAX_LAYER));
  for (const bone of armature.bones) {
    if (motionNodeIds.has(boneNodeId(armature, bone.name))) {
      throw invalidField('physics.ragdoll.armature', armature.id, `an armature whose bones have no motion translation or rotation track, but ${bone.name} has one; pick the track or the ragdoll`);
    }
  }
  ragdollForRecipe(ragdoll, recipe);
  return ragdoll;
}

/** The ragdoll of an armature, placed from the recipe's rest pose. Throws on a bone without length or too many bones. */
function ragdollForRecipe(ragdoll, recipe) {
  const armature = recipe.armatures.find(candidate => candidate.id === ragdoll.armature);
  const nodesById = new Map(recipe.nodes.map(node => [node.id, node]));
  const armatureWorld = restWorldMatrix(armature.id, nodesById);
  const tails = boneTails(armature);
  const bones = armature.bones.map((bone, index) => {
    const id = boneNodeId(armature, bone.name);
    return {
      id, parentId: bone.parent === null ? null : boneNodeId(armature, bone.parent),
      worldMatrix: restWorldMatrix(id, nodesById), parentWorldMatrix: restWorldMatrix(nodesById.get(id).parent, nodesById),
      tail: Array.from(vec3.transformMat4(vec3.create(), tails[index], armatureWorld)),
    };
  });
  const { armature: armatureId, ...options } = ragdoll;
  return createRagdoll(bones, options);
}

/** Validate a recipe physics section against its nodes. Returns the plain, bounded form stored in the recipe. */
export function normalizeAgentPhysics(input, recipe) {
  if (input === null || input === undefined) {
    return null;
  }
  knownKeys(input, PHYSICS_FIELDS, 'physics');
  const duration = finiteNumber(input.duration, 'physics.duration', 0.1, MAX_DURATION_SECONDS);
  const recipeNodes = new Map(recipe.nodes.map(node => [node.id, node]));
  const motionNodeIds = new Set((recipe.motion?.tracks ?? [])
    .filter(track => track.kind === 'node' && (track.property === 'translation' || track.property === 'rotation'))
    .map(track => track.id));
  const claimedNodes = new Set();
  const bodies = boundedArray(input.bodies ?? [], MAX_BODIES, 'physics.bodies').map((body, index) => normalizeBody(body, recipeNodes, motionNodeIds, claimedNodes, `physics.bodies[${index}]`));
  if (!bodies.length && input.ragdoll === undefined) {
    throw invalidField('physics.bodies', [], 'at least one body, such as [{ "node": "crate" }]; use physics null to clear it');
  }
  const result = { duration, bodies };
  if (input.ragdoll !== undefined) result.ragdoll = normalizeRagdoll(input.ragdoll, recipe, motionNodeIds);
  if (input.gravity !== undefined) result.gravity = numberList(input.gravity, 3, 'physics.gravity');
  const jointNames = new Set();
  if (input.joints !== undefined) {
    result.joints = boundedArray(input.joints, MAX_JOINTS, 'physics.joints').map((joint, index) => {
      const normalized = normalizeJoint(joint, claimedNodes, jointNames, `physics.joints[${index}]`);
      jointNames.add(normalized.name ?? `joint-${index}`);
      return normalized;
    });
  }
  if (input.events !== undefined) {
    const bodyTypes = new Map(bodies.map(body => [body.node, body.type]));
    result.events = boundedArray(input.events, MAX_EVENTS, 'physics.events').map((event, index) => normalizeEvent(event, duration, bodyTypes, jointNames, `physics.events[${index}]`));
  }
  if (input.fields !== undefined) {
    result.fields = normalizeForceFields(input.fields, 'physics.fields');
  }
  return result;
}

function scaledBounds(positions, scale) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const coordinate = positions[index + axis] * scale[axis];
      minimum[axis] = Math.min(minimum[axis], coordinate);
      maximum[axis] = Math.max(maximum[axis], coordinate);
    }
  }
  const center = minimum.map((value, axis) => (value + maximum[axis]) / 2);
  const halfExtents = minimum.map((value, axis) => Math.max((maximum[axis] - value) / 2, 1e-4));
  return { center, halfExtents };
}

function convexPoints(positions, scale, nodeId) {
  if (positions.length / 3 > MAX_SOURCE_VERTICES) {
    throw invalidField(`nodes[${nodeId}].geometry`, `${positions.length / 3} vertices`, `at most ${MAX_SOURCE_VERTICES} vertices for a convex collider; use shape box or a coarser geometry, such as shape "box"`);
  }
  const distinct = new Map();
  for (let index = 0; index < positions.length; index += 3) {
    const point = [positions[index] * scale[0], positions[index + 1] * scale[1], positions[index + 2] * scale[2]];
    distinct.set(point.map(component => component.toFixed(5)).join(','), point);
    if (distinct.size > MAX_HULL_POINTS) {
      throw invalidField(`nodes[${nodeId}].geometry`, `more than ${MAX_HULL_POINTS} distinct vertices`, `at most ${MAX_HULL_POINTS} distinct vertices for a convex collider; use shape box or a coarser geometry, such as shape "box"`);
    }
  }
  return [...distinct.values()].flat();
}

function trimeshArrays(geometry, scale, nodeId) {
  const triangleCount = geometry.indices.length / 3;
  if (triangleCount > MAX_TRIMESH_TRIANGLES) {
    throw invalidField(`nodes[${nodeId}].geometry`, `${triangleCount} triangles`, `at most ${MAX_TRIMESH_TRIANGLES} triangles for a trimesh collider; use a coarser geometry or shape box, such as shape "box"`);
  }
  const vertices = [];
  for (let index = 0; index < geometry.positions.length; index += 3) {
    vertices.push(geometry.positions[index] * scale[0], geometry.positions[index + 1] * scale[1], geometry.positions[index + 2] * scale[2]);
  }
  return { vertices, indices: Array.from(geometry.indices) };
}

function colliderFromGeometry(body, node, geometry) {
  const { center, halfExtents } = scaledBounds(geometry.positions, node.scale);
  if (body.shape === 'box') {
    return { shape: 'cuboid', halfExtents, translation: center };
  }
  if (body.shape === 'ball') {
    return { shape: 'ball', radius: Math.max(...halfExtents), translation: center };
  }
  if (body.shape === 'capsule') {
    const radius = Math.max(halfExtents[0], halfExtents[2]);
    return { shape: 'capsule', radius, halfHeight: Math.max(halfExtents[1] - radius, radius * 0.01), translation: center };
  }
  if (body.shape === 'cylinder' || body.shape === 'cone') {
    const radius = Math.max(halfExtents[0], halfExtents[2]);
    return { shape: body.shape, radius, halfHeight: halfExtents[1], translation: center };
  }
  if (body.shape === 'convex') {
    return { shape: 'convexHull', points: convexPoints(geometry.positions, node.scale, node.id) };
  }
  return { shape: 'trimesh', ...trimeshArrays(geometry, node.scale, node.id) };
}

function layerBits(layers) {
  return layers.reduce((bits, layer) => bits | (1 << layer), 0);
}

function physicsDefinition(physics, recipe, geometries, ragdoll) {
  const nodes = new Map(recipe.nodes.map(node => [node.id, node]));
  const definition = { bodies: [], colliders: [], joints: [] };
  if (physics.gravity) definition.gravity = physics.gravity;
  for (const body of physics.bodies) {
    const node = nodes.get(body.node);
    definition.bodies.push({
      name: node.id, type: body.type, translation: node.translation, rotation: node.rotation,
      ...(body.velocity ? { linearVelocity: body.velocity } : {}),
      ...(body.angularVelocity ? { angularVelocity: body.angularVelocity } : {}),
    });
    const commonCollider = {
      body: node.id,
      ...(body.sensor ? { sensor: true } : {}),
      ...(body.friction !== undefined ? { friction: body.friction } : {}),
      ...(body.restitution !== undefined ? { restitution: body.restitution } : {}),
      groups: 1 << (body.layer ?? 0),
      mask: body.collidesWith ? layerBits(body.collidesWith) : 0xffff,
    };
    if (body.shape === 'compound') {
      body.shapes.forEach((part, partIndex) => {
        const mappedShape = part.shape === 'box' ? 'cuboid' : part.shape;
        const collider = {
          name: partIndex === 0 ? node.id : `${node.id}#${partIndex}`,
          ...commonCollider,
          ...part,
          shape: mappedShape,
        };
        if (body.mass !== undefined) collider.mass = body.mass / body.shapes.length;
        else collider.density = body.density ?? 1;
        definition.colliders.push(collider);
      });
    } else {
      const collider = {
        name: node.id,
        ...commonCollider,
        ...colliderFromGeometry(body, node, geometries.get(node.geometry)),
      };
      if (collider.shape !== 'trimesh') {
        if (body.mass !== undefined) collider.mass = body.mass;
        else collider.density = body.density ?? 1;
      }
      definition.colliders.push(collider);
    }
  }
  if (ragdoll) {
    definition.bodies.push(...ragdoll.definition.bodies);
    definition.colliders.push(...ragdoll.definition.colliders);
    definition.joints.push(...ragdoll.definition.joints);
  }
  (physics.joints ?? []).forEach((joint, index) => definition.joints.push({ name: joint.name ?? `joint-${index}`, ...joint }));
  if (physics.events) definition.events = physics.events;
  if (physics.fields) definition.fields = physics.fields;
  return definition;
}

const roundedTime = (frame, timestep) => Number((frame * timestep).toFixed(3));
const roundedVector = values => Array.from(values, value => Number(value.toFixed(4)));

function contactReport(scene, physics) {
  const sensorNodes = new Set(physics.bodies.filter(body => body.sensor).map(body => body.node));
  const pairs = new Map();
  const sensorEvents = [];
  for (const event of scene.contactEvents) {
    const first = scene.colliderNames[event.colliderA];
    const second = scene.colliderNames[event.colliderB];
    if (event.kind === 'sensor') {
      if (sensorEvents.length < MAX_REPORTED_SENSOR_EVENTS) {
        const sensor = sensorNodes.has(first) ? first : second;
        sensorEvents.push({ sensor, other: sensor === first ? second : first, kind: event.started ? 'enter' : 'leave', time: roundedTime(event.frame, scene.timestep) });
      }
      continue;
    }
    const key = [first, second].sort().join('|');
    const pair = pairs.get(key) ?? { a: first < second ? first : second, b: first < second ? second : first, firstTime: roundedTime(event.frame, scene.timestep), touching: 0, count: 0 };
    pair.touching += event.started ? 1 : -1;
    pair.count += event.started ? 1 : 0;
    pairs.set(key, pair);
  }
  const contacts = [...pairs.values()].slice(0, MAX_REPORTED_CONTACTS)
    .map(({ a, b, firstTime, touching, count }) => ({ a, b, firstTime, count, touchingAtEnd: touching > 0 }));
  return { contacts, sensorEvents };
}

function bodyReport(scene, physics) {
  const lastPose = scene.sample(scene.duration);
  const previousPose = scene.sample(Math.max(0, scene.duration - scene.timestep));
  return physics.bodies.map(body => {
    const offset = scene.bodyIndex(body.node) * 7;
    const finalPosition = Array.from(lastPose.subarray(offset, offset + 3));
    const finalSpeed = Math.hypot(...finalPosition.map((value, axis) => value - previousPose[offset + axis])) / scene.timestep;
    const restFrame = scene.restFrames[scene.bodyIndex(body.node)];
    return {
      node: body.node, type: body.type, shape: body.shape,
      finalPosition: roundedVector(finalPosition), finalSpeed: Number(finalSpeed.toFixed(4)),
      ...(body.type === 'dynamic' ? { restsAtTime: restFrame < 0 ? null : roundedTime(restFrame, scene.timestep) } : {}),
    };
  });
}

/** Identity of a bake: the section, the nodes it moves and the geometry under them. A ragdoll also reads the rig. */
export function physicsBakeKey(recipe, geometryRecords) {
  const bodyNodes = recipe.nodes.filter(node => recipe.physics.bodies.some(body => body.node === node.id));
  const rig = recipe.physics.ragdoll ? [recipe.nodes, recipe.armatures] : null;
  return JSON.stringify([recipe.physics, bodyNodes, bodyNodes.map(node => geometryRecords.get(node.geometry).signature), rig]);
}

/**
 * Bake the physics section with Rapier. The solver must already be loaded (see loadPhysicsEngine).
 * The result is a pure function of time: `sample(t)` returns node patches and a seek never replays the solver.
 */
export function bakeAgentPhysics(physics, recipe, geometries) {
  const ragdoll = physics.ragdoll ? ragdollForRecipe(physics.ragdoll, recipe) : null;
  const definition = physicsDefinition(physics, recipe, geometries, ragdoll);
  const frameCount = Math.round(physics.duration * FRAMES_PER_SECOND) + 1;
  const scene = bakePhysicsScene(definition, { frameCount, timestep: 1 / FRAMES_PER_SECOND, maxColliderTriangles: MAX_TRIMESH_TRIANGLES, maxHullPoints: MAX_HULL_POINTS });
  const patches = new Map(physics.bodies.map(body => [body.node, { translation: new Float64Array(3), rotation: new Float64Array(4) }]));
  const ragdollTable = ragdoll ? ragdollPatches(ragdoll) : new Map();
  for (const [nodeId, patch] of ragdollTable) patches.set(nodeId, patch);
  const pose = new Float32Array(scene.bodyNames.length * 7);
  const readBodyPose = nodeId => {
    const offset = scene.bodyIndex(nodeId) * 7;
    return { translation: pose.subarray(offset, offset + 3), rotation: pose.subarray(offset + 3, offset + 7) };
  };
  let reportCache = null;
  return Object.freeze({
    duration: physics.duration,
    sample(time) {
      scene.sample(time, pose);
      ragdoll?.writePatches(readBodyPose, ragdollTable);
      for (const [nodeId, patch] of patches) {
        if (ragdollTable.has(nodeId)) continue;
        const offset = scene.bodyIndex(nodeId) * 7;
        patch.translation.set(pose.subarray(offset, offset + 3));
        patch.rotation.set(pose.subarray(offset + 3, offset + 7));
      }
      return patches;
    },
    /** Contacts, sensor events and resting state, as numbers an agent can read without a picture. */
    report() {
      reportCache ??= {
        duration: physics.duration, frames: scene.frameCount, gravity: physics.gravity ?? [0, -9.81, 0],
        bodies: bodyReport(scene, physics), ...contactReport(scene, physics),
        eventsTruncated: scene.contactEventsTruncated,
        ...(scene.jointBreaks.length ? { jointBreaks: scene.jointBreaks.slice(0, MAX_REPORTED_CONTACTS).map(({ frame, joint, impulse }) => ({ joint, time: roundedTime(frame, scene.timestep), impulse: Number(impulse.toFixed(3)) })) } : {}),
        ...(ragdoll ? { ragdoll: ragdollReport(ragdoll, scene) } : {}),
      };
      return structuredClone(reportCache);
    },
  });
}

const ASSET_PHYSICS_FIELDS = ['duration', 'gravity', 'floor', 'ragdoll'];
const FLOOR_HALF_EXTENT = 200;
const FLOOR_HALF_THICKNESS = 0.5;

/** Validate the physics of an imported asset: a ragdoll of its joints falling onto a floor at a world height. */
export function normalizeAssetPhysics(input) {
  knownKeys(input, ASSET_PHYSICS_FIELDS, 'physics');
  const physics = { duration: finiteNumber(input.duration, 'physics.duration', 0.1, MAX_DURATION_SECONDS) };
  if (input.gravity !== undefined) physics.gravity = numberList(input.gravity, 3, 'physics.gravity');
  if (input.floor !== undefined) physics.floor = finiteNumber(input.floor, 'physics.floor', -1e6, 1e6);
  if (input.ragdoll === undefined) {
    throw invalidField('physics.ragdoll', input.ragdoll, 'a ragdoll section, such as {}; it is what moves the asset joints', TypeError);
  }
  knownKeys(input.ragdoll, RAGDOLL_FIELDS.filter(field => field !== 'armature'), 'physics.ragdoll');
  const ragdoll = {};
  for (const [field, minimum, maximum] of [['density', 1e-6, 1e9], ['friction', 0, 100], ['restitution', 0, 1]]) {
    if (input.ragdoll[field] !== undefined) ragdoll[field] = finiteNumber(input.ragdoll[field], `physics.ragdoll.${field}`, minimum, maximum);
  }
  if (input.ragdoll.layer !== undefined) ragdoll.layer = Math.trunc(finiteNumber(input.ragdoll.layer, 'physics.ragdoll.layer', 0, MAX_LAYER));
  return { ...physics, ragdoll };
}

function worldMatrixOfNode(node, nodesById, localMatrices, worldMatrices, rootMatrix) {
  if (worldMatrices.has(node.id)) return worldMatrices.get(node.id);
  const parentMatrix = node.parent === null ? rootMatrix : worldMatrixOfNode(nodesById.get(node.parent), nodesById, localMatrices, worldMatrices, rootMatrix);
  const world = mat4.multiply(mat4.create(), parentMatrix, localMatrices.get(node.id));
  worldMatrices.set(node.id, world);
  return world;
}

function nearestJointAncestor(node, nodesById) {
  let current = node.parent === null ? undefined : nodesById.get(node.parent);
  while (current && !current.joint) current = current.parent === null ? undefined : nodesById.get(current.parent);
  return current?.id ?? null;
}

function assetRagdollBones(nodes, nodePoses, rootMatrix) {
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const localMatrices = new Map(nodePoses.map(pose => [pose.id, mat4.fromRotationTranslationScale(mat4.create(), pose.rotation, pose.translation, pose.scale)]));
  const worldMatrices = new Map();
  const joints = nodes.filter(node => node.joint);
  const lockedJoint = joints.find(node => !node.editable);
  if (lockedJoint) {
    throw invalidField('physics.ragdoll', lockedJoint.id, 'an asset whose joints can all be edited, but this one is mirrored or sheared so a ragdoll cannot drive it; remove the ragdoll or use another asset');
  }
  const depthOf = node => (node.parent === null ? 0 : 1 + depthOf(nodesById.get(node.parent)));
  const ordered = joints.map(node => ({ node, depth: depthOf(node) })).sort((first, second) => first.depth - second.depth).map(entry => entry.node);
  const worlds = new Map(ordered.map(node => [node.id, worldMatrixOfNode(node, nodesById, localMatrices, worldMatrices, rootMatrix)]));
  const skeleton = { bones: ordered.map(node => ({
    name: node.id, parent: nearestJointAncestor(node, nodesById), head: Array.from(mat4.getTranslation(vec3.create(), worlds.get(node.id))),
  })) };
  const tails = boneTails(skeleton);
  return ordered.map((node, index) => ({
    id: node.id, parentId: skeleton.bones[index].parent, worldMatrix: worlds.get(node.id), tail: tails[index],
    parentWorldMatrix: node.parent === null ? rootMatrix : worldMatrixOfNode(nodesById.get(node.parent), nodesById, localMatrices, worldMatrices, rootMatrix),
  }));
}

/**
 * Bake a ragdoll of an imported asset's joints, starting from the pose the asset has now (clip and overrides) and falling
 * onto a floor at world height `physics.floor`. `nodes` are the asset's source nodes, `nodePoses` their local poses and
 * `rootMatrix` the asset root. The sampler returns local translation and rotation per joint, a pure function of time.
 */
export function bakeAssetRagdoll(physics, nodes, nodePoses, rootMatrix) {
  const ragdoll = createRagdoll(assetRagdollBones(nodes, nodePoses, rootMatrix), physics.ragdoll);
  const floorHeight = physics.floor ?? 0;
  const definition = {
    bodies: [{ name: 'ragdoll-floor', type: 'fixed', translation: [0, floorHeight - FLOOR_HALF_THICKNESS, 0] }, ...ragdoll.definition.bodies],
    colliders: [
      { name: 'ragdoll-floor', body: 'ragdoll-floor', shape: 'cuboid', halfExtents: [FLOOR_HALF_EXTENT, FLOOR_HALF_THICKNESS, FLOOR_HALF_EXTENT] },
      ...ragdoll.definition.colliders,
    ],
    joints: ragdoll.definition.joints,
    ...(physics.gravity ? { gravity: physics.gravity } : {}),
  };
  const frameCount = Math.round(physics.duration * FRAMES_PER_SECOND) + 1;
  const scene = bakePhysicsScene(definition, { frameCount, timestep: 1 / FRAMES_PER_SECOND, maxColliderTriangles: MAX_TRIMESH_TRIANGLES, maxHullPoints: MAX_HULL_POINTS });
  const patches = ragdollPatches(ragdoll);
  const pose = new Float32Array(scene.bodyNames.length * 7);
  const readBodyPose = nodeId => {
    const offset = scene.bodyIndex(nodeId) * 7;
    return { translation: pose.subarray(offset, offset + 3), rotation: pose.subarray(offset + 3, offset + 7) };
  };
  return Object.freeze({
    duration: physics.duration,
    sample(time) {
      scene.sample(time, pose);
      ragdoll.writePatches(readBodyPose, patches);
      return patches;
    },
    report() {
      return { duration: physics.duration, frames: scene.frameCount, gravity: physics.gravity ?? [0, -9.81, 0], ragdoll: ragdollReport(ragdoll, scene) };
    },
  });
}
