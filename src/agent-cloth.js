import { mat4, vec3 } from 'gl-matrix';
import { runKernel } from './kernel-offload.js';
import { bakeClothWithFields } from './cloth-fields.js';
import { normalizeForceFields } from './force-fields.js';
import { BEND_MODELS } from './cloth-bending.js';
import { bakeCloth, sampleClothFrames, weldVertices, CLOTH_LIMITS } from './cloth.js';
import { recomputeNormals } from './geometry-normals.js';
import { invalidField } from './field-error.js';
import { bakingContext, boundedArray, finiteNumber, knownKeys, rootNodeWithGeometry, vectorOfThree } from './agent-recipe-checks.js';
import { boneNodeId, boneTails, restWorldMatrix } from './rig.js';
// Matches the ragdoll's bone capsule radius (src/ragdoll.js), without loading the ragdoll for one number.
const RADIUS_OF_LENGTH = 0.2;

const FRAMES_PER_SECOND = 60;
const MAX_DURATION_SECONDS = 10;
const MAX_SHEETS = 8;
const MAX_COLLIDERS = 16;
// Moving balls and capsules, counting every bone capsule a fitted armature expands to.
const MAX_MOVING_COLLIDERS = 64;
const MIN_MOVING_RADIUS = 0.001;
const MAX_MOVING_RADIUS = 10;
const OFFSET_LIMIT = 100;
const MIN_BONE_LENGTH = 1e-4;
const PIN_EDGES = ['top', 'bottom', 'left', 'right', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
const COLLIDER_SHAPES = ['ball', 'box'];
const MOVING_SHAPES = ['ball', 'capsule'];
const CLOTH_FIELDS = ['duration', 'gravity', 'wind', 'fields', 'sheets', 'colliders'];
const SHEET_FIELDS = ['node', 'pin', 'pinGroup', 'pinTo', 'stiffnessGroup', 'softBody', 'selfCollision', 'stiffness', 'bend', 'bendModel', 'bendYield', 'bendSet', 'density', 'damping', 'friction', 'thickness'];
const PIN_TO_FIELDS = ['node', 'weight'];
const SOFT_BODY_FIELDS = ['shape', 'pressure', 'bounce'];
// A stiffness group never goes fully limp: a zero weight would let its particles drift off.
const MIN_GROUP_STIFFNESS = 0.05;
const FIXED_COLLIDER_FIELDS = ['node', 'shape'];
// A ball or capsule that rides on a node: the capsule runs from `attach` (plus offset) to `to` (plus toOffset).
const MOVING_COLLIDER_FIELDS = ['attach', 'shape', 'radius', 'offset', 'to', 'toOffset'];
// One capsule per bone of an armature, radius a fraction of the bone length as the ragdoll fits it.
const FITTED_COLLIDER_FIELDS = ['armature', 'radiusFraction', 'exclude'];
const PIN_TOLERANCE = 1e-4;
// A vertex of the pin group is held when its weight is at least this much.
const PIN_GROUP_THRESHOLD = 0.5;
const GROUP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const NO_PATCHES = new Map();

function normalizeSheet(input, context, path) {
  knownKeys(input, SHEET_FIELDS, path);
  rootNodeWithGeometry(input.node, context.recipeNodes, context.claimedNodes, context.motionNodeIds, context.physicsNodeIds, `${path}.node`);
  const sheet = { node: input.node };
  if (input.pin !== undefined) {
    const edges = boundedArray(input.pin, PIN_EDGES.length, `${path}.pin`);
    edges.forEach((edge, index) => {
      if (!PIN_EDGES.includes(edge)) {
        throw invalidField(`${path}.pin[${index}]`, edge, `one of ${PIN_EDGES.join(', ')}`);
      }
    });
    sheet.pin = [...new Set(edges)];
  }
  if (input.pinGroup !== undefined) {
    if (typeof input.pinGroup !== 'string' || !GROUP_NAME_PATTERN.test(input.pinGroup)) {
      throw invalidField(`${path}.pinGroup`, input.pinGroup, 'the name of a vertex group on the sheet mesh, such as "hem"');
    }
    sheet.pinGroup = input.pinGroup;
  }
  if (input.stiffnessGroup !== undefined) {
    if (typeof input.stiffnessGroup !== 'string' || !GROUP_NAME_PATTERN.test(input.stiffnessGroup)) {
      throw invalidField(`${path}.stiffnessGroup`, input.stiffnessGroup, 'the name of a vertex group on the sheet mesh whose weights scale stiffness, such as "sleeve"');
    }
    sheet.stiffnessGroup = input.stiffnessGroup;
  }
  if (input.softBody !== undefined) {
    knownKeys(input.softBody, SOFT_BODY_FIELDS, `${path}.softBody`);
    sheet.softBody = {};
    if (input.softBody.shape !== undefined) sheet.softBody.shape = finiteNumber(input.softBody.shape, `${path}.softBody.shape`, 0, 1);
    if (input.softBody.pressure !== undefined) sheet.softBody.pressure = finiteNumber(input.softBody.pressure, `${path}.softBody.pressure`, 0, 3);
    if (input.softBody.bounce !== undefined) sheet.softBody.bounce = finiteNumber(input.softBody.bounce, `${path}.softBody.bounce`, 0, 1);
  }
  if (input.selfCollision !== undefined) {
    if (typeof input.selfCollision !== 'boolean') {
      throw invalidField(`${path}.selfCollision`, input.selfCollision, 'true or false; the radius follows the mesh edge length');
    }
    sheet.selfCollision = input.selfCollision;
  }
  if (input.pinTo !== undefined) {
    knownKeys(input.pinTo, PIN_TO_FIELDS, `${path}.pinTo`);
    if (!sheet.pin?.length && !sheet.pinGroup) {
      throw invalidField(`${path}.pinTo`, input.pinTo, 'a sheet that also sets pin (such as ["top"]) or pinGroup, because pinTo moves the pinned vertices');
    }
    const target = existingNode(input.pinTo.node, context, `${path}.pinTo.node`);
    if (target === input.node) {
      throw invalidField(`${path}.pinTo.node`, target, 'a node other than the sheet itself, such as a pole or a hand');
    }
    sheet.pinTo = { node: target, weight: input.pinTo.weight === undefined ? 1 : finiteNumber(input.pinTo.weight, `${path}.pinTo.weight`, 0.01, 1) };
  }
  if (input.bendModel !== undefined) {
    if (!BEND_MODELS.includes(input.bendModel)) throw invalidField(`${path}.bendModel`, input.bendModel, `one of ${BEND_MODELS.join(', ')}`);
    sheet.bendModel = input.bendModel;
  }
  if (input.bendYield !== undefined && (input.bendModel ?? 'distance') !== 'dihedral') {
    throw invalidField(`${path}.bendYield`, input.bendYield, "used with bendModel 'dihedral' only; set bendModel to 'dihedral' or drop bendYield");
  }
  const ranges = { stiffness: [0.01, 1], bend: [0, 1], density: [0.01, 10], damping: [0, 100], friction: [0, 1], thickness: [0, 0.5], bendYield: [0, Math.PI], bendSet: [0, 1] };
  for (const [field, [minimum, maximum]] of Object.entries(ranges)) {
    if (input[field] !== undefined) sheet[field] = finiteNumber(input[field], `${path}.${field}`, minimum, maximum);
  }
  return sheet;
}

function existingNode(nodeId, context, path) {
  if (typeof nodeId !== 'string' || !context.recipeNodes.has(nodeId)) {
    throw invalidField(path, nodeId, 'the ID of a node in the recipe, such as "pole"');
  }
  return nodeId;
}

function normalizeMovingCollider(input, context, path) {
  knownKeys(input, MOVING_COLLIDER_FIELDS, path);
  const shape = input.shape ?? 'ball';
  if (!MOVING_SHAPES.includes(shape)) {
    throw invalidField(`${path}.shape`, shape, `one of ${MOVING_SHAPES.join(', ')}`);
  }
  if (shape === 'capsule' && input.to === undefined) {
    throw invalidField(`${path}.to`, input.to, 'the ID of the node the capsule other end rides on, such as "hand"');
  }
  if (shape === 'ball' && input.to !== undefined) {
    throw invalidField(`${path}.to`, input.to, 'nothing for a ball; drop it or set shape to "capsule"');
  }
  const collider = {
    attach: existingNode(input.attach, context, `${path}.attach`), shape,
    radius: finiteNumber(input.radius, `${path}.radius`, MIN_MOVING_RADIUS, MAX_MOVING_RADIUS),
  };
  if (input.offset !== undefined) collider.offset = vectorOfThree(input.offset, `${path}.offset`, OFFSET_LIMIT);
  if (shape === 'capsule') {
    collider.to = existingNode(input.to, context, `${path}.to`);
    if (input.toOffset !== undefined) collider.toOffset = vectorOfThree(input.toOffset, `${path}.toOffset`, OFFSET_LIMIT);
  } else if (input.toOffset !== undefined) {
    throw invalidField(`${path}.toOffset`, input.toOffset, 'nothing for a ball; drop it or set shape to "capsule"');
  }
  return collider;
}

function normalizeFittedCollider(input, recipe, path) {
  knownKeys(input, FITTED_COLLIDER_FIELDS, path);
  const armature = (recipe.armatures ?? []).find(candidate => candidate.id === input.armature);
  if (!armature) {
    throw invalidField(`${path}.armature`, input.armature, 'the ID of an armature in the recipe armatures, such as "rig"');
  }
  const collider = { armature: armature.id };
  if (input.radiusFraction !== undefined) collider.radiusFraction = finiteNumber(input.radiusFraction, `${path}.radiusFraction`, 0.02, 0.5);
  if (input.exclude !== undefined) {
    const names = new Set(armature.bones.map(bone => bone.name));
    collider.exclude = [...new Set(boundedArray(input.exclude, MAX_MOVING_COLLIDERS, `${path}.exclude`))];
    for (const name of collider.exclude) {
      if (!names.has(name)) throw invalidField(`${path}.exclude`, name, `a bone name of ${armature.id}, such as "${armature.bones[0]?.name ?? 'spine'}"`);
    }
  }
  return collider;
}

function normalizeCollider(input, context, recipe, path) {
  if (input !== null && typeof input === 'object' && Object.hasOwn(input, 'attach')) {
    return normalizeMovingCollider(input, context, path);
  }
  if (input !== null && typeof input === 'object' && Object.hasOwn(input, 'armature')) {
    return normalizeFittedCollider(input, recipe, path);
  }
  knownKeys(input, FIXED_COLLIDER_FIELDS, path);
  rootNodeWithGeometry(input.node, context.recipeNodes, context.claimedNodes, context.motionNodeIds, context.physicsNodeIds, `${path}.node`);
  const shape = input.shape ?? 'box';
  if (!COLLIDER_SHAPES.includes(shape)) {
    throw invalidField(`${path}.shape`, shape, `one of ${COLLIDER_SHAPES.join(', ')}`);
  }
  return { node: input.node, shape };
}

/** Validate a recipe cloth section against its nodes. Returns the plain, bounded form stored in the recipe. */
export function normalizeAgentCloth(input, recipe) {
  if (input === null || input === undefined) {
    return null;
  }
  knownKeys(input, CLOTH_FIELDS, 'cloth');
  const context = bakingContext(recipe);
  const result = { duration: finiteNumber(input.duration, 'cloth.duration', 0.1, MAX_DURATION_SECONDS) };
  result.sheets = boundedArray(input.sheets, MAX_SHEETS, 'cloth.sheets').map((sheet, index) => normalizeSheet(sheet, context, `cloth.sheets[${index}]`));
  if (!result.sheets.length) {
    throw invalidField('cloth.sheets', result.sheets, 'at least one sheet, such as [{ "node": "banner", "pin": ["top"] }]; use cloth: null to clear it');
  }
  if (input.gravity !== undefined) result.gravity = vectorOfThree(input.gravity, 'cloth.gravity', 1000);
  if (input.wind !== undefined) result.wind = vectorOfThree(input.wind, 'cloth.wind', 100);
  if (input.fields !== undefined) result.fields = normalizeForceFields(input.fields, 'Cloth force field');
  if (input.colliders !== undefined) {
    const entries = boundedArray(input.colliders, MAX_COLLIDERS + MAX_MOVING_COLLIDERS, 'cloth.colliders');
    boundedArray(entries.filter(entry => !Object.hasOwn(entry ?? {}, 'attach') && !Object.hasOwn(entry ?? {}, 'armature')), MAX_COLLIDERS, 'cloth.colliders');
    result.colliders = entries.map((collider, index) => normalizeCollider(collider, context, recipe, `cloth.colliders[${index}]`));
    const movingCount = movingColliderSpecs(result, recipe).length;
    if (movingCount > MAX_MOVING_COLLIDERS) {
      throw invalidField('cloth.colliders', `${movingCount} moving colliders`, `at most ${MAX_MOVING_COLLIDERS} balls and capsules, counting one per armature bone; exclude bones or drop colliders`);
    }
  }
  return result;
}

function localBounds(positions) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], positions[index + axis]);
      maximum[axis] = Math.max(maximum[axis], positions[index + axis]);
    }
  }
  return { minimum, maximum };
}

function nodeMatrix(node) {
  return mat4.fromRotationTranslationScale(mat4.create(), node.rotation, node.translation, node.scale);
}

function colliderFor(collider, node, geometry) {
  const matrix = nodeMatrix(node);
  const { minimum, maximum } = localBounds(geometry.positions);
  const localCenter = minimum.map((value, axis) => (value + maximum[axis]) / 2);
  const halfExtents = minimum.map((value, axis) => Math.max(((maximum[axis] - value) / 2) * Math.abs(node.scale[axis]), 1e-4));
  const center = [
    matrix[0] * localCenter[0] + matrix[4] * localCenter[1] + matrix[8] * localCenter[2] + matrix[12],
    matrix[1] * localCenter[0] + matrix[5] * localCenter[1] + matrix[9] * localCenter[2] + matrix[13],
    matrix[2] * localCenter[0] + matrix[6] * localCenter[1] + matrix[10] * localCenter[2] + matrix[14],
  ];
  if (collider.shape === 'ball') {
    return { kind: 'ball', center, radius: Math.max(...halfExtents) };
  }
  const axes = [0, 1, 2].map(column => {
    const axis = [matrix[column * 4], matrix[column * 4 + 1], matrix[column * 4 + 2]];
    const length = Math.hypot(...axis);
    return axis.map(component => component / length);
  });
  return { kind: 'box', center, axes, halfExtents };
}

// The weights of the sheet's pin group per render vertex, or null without one. A name the mesh lacks is an error that lists the groups it has.
function groupWeights(sheet, geometry, field) {
  const name = sheet[field];
  if (!name) return null;
  const weights = geometry.vertexGroups?.[name];
  if (!weights) {
    const known = Object.keys(geometry.vertexGroups ?? {});
    throw invalidField(`cloth.sheets[].${field}`, name, `a vertex group of node ${sheet.node} (known groups: ${known.join(', ') || 'none'}); make one with a vertex_group mesh edit`);
  }
  return weights;
}

const pinGroupWeights = (sheet, geometry) => groupWeights(sheet, geometry, 'pinGroup');

// One 0.05 to 1 stiffness weight per particle from the sheet's stiffness group, or undefined without one.
function stiffnessWeights(sheet, geometry, representatives) {
  const weights = groupWeights(sheet, geometry, 'stiffnessGroup');
  if (!weights) return undefined;
  return Float64Array.from(representatives, vertex => Math.max(weights[vertex], MIN_GROUP_STIFFNESS));
}

// Particles on the requested edges of the sheet's local bounds, so 'top' is the row of highest local y, plus the particles
// whose vertex weighs at least half in the pin group.
function pinnedParticles(localPositions, representatives, pin, groupWeights = null) {
  if (!pin?.length && !groupWeights) return [];
  const particlePositions = representatives.map(vertex => localPositions.subarray(vertex * 3, vertex * 3 + 3));
  const { minimum, maximum } = localBounds(particlePositions.reduce((all, point) => [...all, ...point], []));
  const tolerance = PIN_TOLERANCE * Math.max(maximum[0] - minimum[0], maximum[1] - minimum[1], 1e-6);
  const at = (point, axis, extreme) => Math.abs(point[axis] - (extreme === 'min' ? minimum[axis] : maximum[axis])) <= tolerance;
  const tests = {
    top: point => at(point, 1, 'max'), bottom: point => at(point, 1, 'min'),
    left: point => at(point, 0, 'min'), right: point => at(point, 0, 'max'),
    topLeft: point => at(point, 1, 'max') && at(point, 0, 'min'), topRight: point => at(point, 1, 'max') && at(point, 0, 'max'),
    bottomLeft: point => at(point, 1, 'min') && at(point, 0, 'min'), bottomRight: point => at(point, 1, 'min') && at(point, 0, 'max'),
  };
  const pinned = [];
  particlePositions.forEach((point, particle) => {
    const onPinnedEdge = pin?.some(edge => tests[edge](point));
    const inPinGroup = groupWeights !== null && groupWeights[representatives[particle]] >= PIN_GROUP_THRESHOLD;
    if (onPinnedEdge || inPinGroup) pinned.push(particle);
  });
  return pinned;
}

/**
 * Balls and capsules that ride on nodes, as plain specs: a ball is { node, offset, radius }, a capsule runs from
 * { startNode, startOffset } to { endNode, endOffset }. A fitted armature expands to one capsule per bone, from its head to
 * its tail, with the radius the ragdoll would give that bone. Offsets are in the owning node's own space.
 */
export function movingColliderSpecs(cloth, recipe) {
  const nodesById = new Map(recipe.nodes.map(node => [node.id, node]));
  const specs = [];
  for (const collider of cloth.colliders ?? []) {
    if (collider.attach !== undefined) {
      const zero = [0, 0, 0];
      specs.push(collider.shape === 'ball'
        ? { kind: 'ball', node: collider.attach, offset: collider.offset ?? zero, radius: collider.radius }
        : { kind: 'capsule', startNode: collider.attach, startOffset: collider.offset ?? zero, endNode: collider.to, endOffset: collider.toOffset ?? zero, radius: collider.radius });
    } else if (collider.armature !== undefined) {
      specs.push(...armatureCapsuleSpecs(collider, recipe, nodesById));
    }
  }
  return specs;
}

function armatureCapsuleSpecs(collider, recipe, nodesById) {
  const armature = recipe.armatures.find(candidate => candidate.id === collider.armature);
  const armatureWorld = restWorldMatrix(armature.id, nodesById);
  const tails = boneTails(armature);
  const excluded = new Set(collider.exclude ?? []);
  const specs = [];
  armature.bones.forEach((bone, index) => {
    if (excluded.has(bone.name)) return;
    const boneId = boneNodeId(armature, bone.name);
    const boneWorld = restWorldMatrix(boneId, nodesById);
    const head = vec3.transformMat4(vec3.create(), [0, 0, 0], boneWorld);
    const tail = vec3.transformMat4(vec3.create(), tails[index], armatureWorld);
    const length = vec3.distance(head, tail);
    if (length < MIN_BONE_LENGTH) return;
    const tailInBone = vec3.transformMat4(vec3.create(), tail, mat4.invert(mat4.create(), boneWorld));
    specs.push({
      kind: 'capsule', startNode: boneId, startOffset: [0, 0, 0], endNode: boneId, endOffset: Array.from(tailInBone),
      radius: length * (collider.radiusFraction ?? RADIUS_OF_LENGTH),
    });
  });
  return specs;
}

// World matrices of recipe nodes at a time: the recipe's local transforms with the motion tracks laid over them.
function createNodePoses(recipe, motionSampler) {
  const nodesById = new Map(recipe.nodes.map(node => [node.id, node]));
  return function worldMatricesAt(time) {
    const patches = motionSampler ? motionSampler.sample(time).nodes : NO_PATCHES;
    const worlds = new Map();
    const worldOf = nodeId => {
      let world = worlds.get(nodeId);
      if (!world) {
        const node = nodesById.get(nodeId);
        const patch = patches.get(nodeId);
        world = mat4.fromRotationTranslationScale(mat4.create(), patch?.rotation ?? node.rotation, patch?.translation ?? node.translation, patch?.scale ?? node.scale);
        if (node.parent !== null) mat4.multiply(world, worldOf(node.parent), world);
        worlds.set(nodeId, world);
      }
      return world;
    };
    return worldOf;
  };
}

// Time of each solver substep after the first frame, so the same frame always meets the same colliders and anchors.
function substepTimes(frameCount) {
  const times = [];
  for (let frame = 1; frame < frameCount; frame++) {
    for (let substep = 1; substep <= CLOTH_LIMITS.substeps; substep++) {
      times.push((frame - 1 + substep / CLOTH_LIMITS.substeps) / FRAMES_PER_SECOND);
    }
  }
  return times;
}

// Every moving collider at every substep as a capsule (a ball has both ends at its centre): start, end, radius.
function sampleColliderTrack(specs, worldMatricesAt, times) {
  const track = new Float64Array(times.length * specs.length * 7);
  const point = vec3.create();
  const place = (index, worldOf, nodeId, offset) => {
    vec3.transformMat4(point, offset, worldOf(nodeId));
    track.set(point, index);
  };
  times.forEach((time, step) => {
    const worldOf = worldMatricesAt(time);
    specs.forEach((spec, collider) => {
      const base = (step * specs.length + collider) * 7;
      const ball = spec.kind === 'ball';
      place(base, worldOf, ball ? spec.node : spec.startNode, ball ? spec.offset : spec.startOffset);
      place(base + 3, worldOf, ball ? spec.node : spec.endNode, ball ? spec.offset : spec.endOffset);
      track[base + 6] = spec.radius;
    });
  });
  return track;
}

// Where the pinned particles go at every substep: their rest offset in the node's space carried by the node's pose.
function sampleAnchorTrack(pinTo, particles, worldPositions, worldMatricesAt, times) {
  const toNode = mat4.invert(mat4.create(), worldMatricesAt(0)(pinTo.node));
  const offsets = particles.map(particle => vec3.transformMat4(vec3.create(), worldPositions.subarray(particle * 3, particle * 3 + 3), toNode));
  const track = new Float64Array(times.length * particles.length * 3);
  const target = vec3.create();
  times.forEach((time, step) => {
    const matrix = worldMatricesAt(time)(pinTo.node);
    offsets.forEach((offset, anchor) => {
      vec3.transformMat4(target, offset, matrix);
      track.set(target, (step * particles.length + anchor) * 3);
    });
  });
  return track;
}

function createMovingBodies(sheet, pinned, worldPositions, movingSetup, frameCount) {
  const { specs, worldMatricesAt } = movingSetup;
  const times = substepTimes(frameCount);
  movingSetup.colliderTrack ??= sampleColliderTrack(specs, worldMatricesAt, times);
  const anchorParticles = Uint32Array.from(sheet.pinTo ? pinned : []);
  return {
    anchorParticles,
    anchorWeights: new Float64Array(anchorParticles.length).fill(sheet.pinTo?.weight ?? 1),
    anchorTrack: sheet.pinTo ? sampleAnchorTrack(sheet.pinTo, pinned, worldPositions, worldMatricesAt, times) : new Float64Array(0),
    colliderCount: specs.length,
    colliderTrack: movingSetup.colliderTrack,
  };
}

function bakeSheet(sheet, cloth, node, geometry, colliders, frameCount, movingSetup) {
  const welded = weldVertices(geometry.positions, geometry.indices);
  const matrix = nodeMatrix(node);
  const worldPositions = new Float64Array(welded.representatives.length * 3);
  welded.representatives.forEach((vertex, particle) => {
    const source = geometry.positions.subarray(vertex * 3, vertex * 3 + 3);
    const world = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      world[axis] = matrix[axis] * source[0] + matrix[4 + axis] * source[1] + matrix[8 + axis] * source[2] + matrix[12 + axis];
    }
    worldPositions.set(world, particle * 3);
  });
  const pinned = pinnedParticles(geometry.positions, welded.representatives, sheet.pin, pinGroupWeights(sheet, geometry));
  const needsMoving = Boolean(movingSetup && (sheet.pinTo || movingSetup.specs.length));
  const moving = needsMoving ? createMovingBodies(sheet, pinned, worldPositions, movingSetup, frameCount) : null;
  const recording = Object.freeze({ ...runKernel('cloth', [worldPositions, welded.triangles, {
    pinned: sheet.pinTo ? [] : pinned, moving,
    stiffnessWeights: stiffnessWeights(sheet, geometry, welded.representatives), softBody: sheet.softBody, selfCollision: sheet.selfCollision,
    gravity: cloth.gravity, wind: cloth.wind, fields: cloth.fields, stiffness: sheet.stiffness, bend: sheet.bend, bendModel: sheet.bendModel,
    bendYield: sheet.bendYield, bendSet: sheet.bendSet,
    density: sheet.density, damping: sheet.damping, friction: sheet.friction, thickness: sheet.thickness,
    colliders, frameCount, framesPerSecond: FRAMES_PER_SECOND,
  }], bakeClothWithFields) });
  return { recording, welded, inverse: mat4.invert(mat4.create(), matrix), geometry, particleScratch: new Float32Array(recording.particleCount * 3), live: liveGeometry(geometry) };
}

// One geometry per sheet whose arrays every seek rewrites, so a renderer keeps the same part and only uploads new values.
const liveGeometries = new WeakSet();

function liveGeometry(geometry) {
  const live = Object.freeze({ ...geometry, positions: Float32Array.from(geometry.positions), normals: Float32Array.from(geometry.normals) });
  liveGeometries.add(live);
  return live;
}

/** True for a sheet geometry that every cloth sample rewrites in place; a renderer uploads its positions and normals after a seek. */
export function isLiveClothGeometry(geometry) {
  return liveGeometries.has(geometry);
}

function sampleLiveGeometry(baked, time) {
  const { recording, welded, inverse, geometry, particleScratch, live } = baked;
  sampleClothFrames(recording, time, particleScratch);
  const positions = live.positions;
  for (let vertex = 0; vertex < welded.particleOfVertex.length; vertex++) {
    const source = welded.particleOfVertex[vertex] * 3;
    for (let axis = 0; axis < 3; axis++) {
      positions[vertex * 3 + axis] = inverse[axis] * particleScratch[source] + inverse[4 + axis] * particleScratch[source + 1] + inverse[8 + axis] * particleScratch[source + 2] + inverse[12 + axis];
    }
  }
  live.normals.set(recomputeNormals(geometry, positions));
  return live;
}

function sheetReport(baked, node, sheet) {
  const { recording, welded, geometry } = baked;
  const last = new Float32Array(recording.particleCount * 3);
  sampleClothFrames(recording, Infinity, last);
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < last.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], last[index + axis]);
      maximum[axis] = Math.max(maximum[axis], last[index + axis]);
    }
  }
  const round = values => values.map(value => Number(value.toFixed(4)));
  return {
    node: node.id, particles: recording.particleCount, triangles: welded.triangles.length / 3, vertices: geometry.positions.length / 3,
    pinned: pinnedParticles(geometry.positions, welded.representatives, sheet.pin, pinGroupWeights(sheet, geometry)).length,
    finalBoundsMin: round(minimum), finalBoundsMax: round(maximum),
  };
}

/**
 * Bake the cloth section. The result is a pure function of time: `sample(t)` returns the deformed geometry of each
 * sheet node (null at time zero, where the sheet is at rest), and a seek never runs the solver again. The geometry of a
 * sheet is one object whose positions and normals are rewritten by every sample.
 */
export function bakeAgentCloth(cloth, recipe, geometries, motionSampler = null) {
  const nodes = new Map(recipe.nodes.map(node => [node.id, node]));
  const frameCount = Math.round(cloth.duration * FRAMES_PER_SECOND) + 1;
  const specs = movingColliderSpecs(cloth, recipe);
  const usesMotion = specs.length > 0 || cloth.sheets.some(sheet => sheet.pinTo);
  const movingSetup = usesMotion ? { specs, worldMatricesAt: createNodePoses(recipe, motionSampler) } : null;
  const colliders = (cloth.colliders ?? []).filter(collider => collider.node !== undefined).map(collider => colliderFor(collider, nodes.get(collider.node), geometries.get(nodes.get(collider.node).geometry)));
  const baked = new Map(cloth.sheets.map(sheet => {
    const node = nodes.get(sheet.node);
    return [sheet.node, bakeSheet(sheet, cloth, node, geometries.get(node.geometry), colliders, frameCount, movingSetup)];
  }));
  let reportCache = null;
  return Object.freeze({
    duration: cloth.duration,
    sample(time) {
      if (time <= 0) return null;
      const clamped = Math.min(time, cloth.duration);
      return new Map([...baked].map(([nodeId, sheetBake]) => [nodeId, sampleLiveGeometry(sheetBake, clamped)]));
    },
    /** Particle counts and where each sheet ends, as numbers an agent can read without a picture. */
    report() {
      reportCache ??= {
        duration: cloth.duration, frames: frameCount, gravity: cloth.gravity ?? [0, -9.81, 0], wind: cloth.wind ?? [0, 0, 0], fields: cloth.fields ?? [],
        sheets: cloth.sheets.map(sheet => sheetReport(baked.get(sheet.node), nodes.get(sheet.node), sheet)),
      };
      return structuredClone(reportCache);
    },
  });
}
