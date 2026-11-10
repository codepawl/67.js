import { mat3, mat4 } from 'gl-matrix';
import { HAIR_LIMITS, buildHairMesh, createStrandRoots } from './hair.js';
import { normalizeForceFields } from './force-fields.js';
import { PARTICLE_LIMITS, buildParticleMesh, createParticleLaunches } from './particles.js';
import { createCollisionSurface } from './particle-collision.js';
import { EMITTER_MESH_MODES, createMeshSource } from './particle-emitter-mesh.js';
import { invalidField } from './field-error.js';
import { bakingContext, boundedArray, finiteNumber, knownKeys, rootNodeWithGeometry, vectorOfThree } from './agent-recipe-checks.js';

const PARTICLES_FIELDS = ['gravity', 'wind', 'fields', 'systems'];
const SYSTEM_TYPES = ['emitter', 'hair'];
const EMITTER_SYSTEM_FIELDS = ['type', 'node', 'seed', 'count', 'rate', 'lifetime', 'speed', 'direction', 'spread', 'emitter', 'size', 'scale', 'drag', 'floor', 'bounce', 'friction', 'colliders', 'spin', 'color', 'alpha', 'instances', 'orient'];
const HAIR_FIELDS = ['type', 'node', 'surface', 'seed', 'count', 'length', 'segments', 'width', 'droop', 'lean', 'sway', 'swayRate'];
const EMITTER_FIELDS = ['shape', 'position', 'halfExtents', 'radius', 'mesh', 'from', 'normalSpeed'];
const EMITTER_SHAPES = ['point', 'box', 'sphere', 'disc', 'mesh'];
const ORIENT_MODES = ['none', 'random', 'normal'];
const SCALE_MODES = ['constant', 'shrink', 'grow'];
const DEFAULT_GRAVITY = Object.freeze([0, -9.81, 0]);
// Defaults that read as debris: a bounce keeps 30 percent of the speed (the first release of collision stuck at 0 without colliders and had no default with them), friction 0.5.
const DEBRIS_BOUNCE = 0.3;
const DEBRIS_FRICTION = 0.5;
const POSITION_LIMIT = 10000;
const MAX_SEED = 0xffffffff;

// A number stands for the range [value, value].
function rangeOf(value, path, minimum, maximum) {
  if (typeof value === 'number') {
    return [finiteNumber(value, path, minimum, maximum), value];
  }
  if (!Array.isArray(value) || value.length !== 2) {
    throw invalidField(path, value, `a number or [minimum, maximum] from ${minimum} to ${maximum}, such as [${Math.max(minimum, 0.5)}, ${Math.min(maximum, 1)}]`, TypeError);
  }
  const range = value.map((entry, index) => finiteNumber(entry, `${path}[${index}]`, minimum, maximum));
  if (range[0] > range[1]) {
    throw invalidField(path, value, `[minimum, maximum] with the minimum not above the maximum, such as [${range[1]}, ${range[0]}]`);
  }
  return range;
}

function normalizeMeshEmitter(input, emitter, context, path) {
  rootNodeWithGeometry(input.mesh, context.recipeNodes, new Set(), context.motionNodeIds, context.physicsNodeIds, `${path}.mesh`, 'particles');
  const from = input.from ?? 'surface';
  if (!EMITTER_MESH_MODES.includes(from)) {
    throw invalidField(`${path}.from`, from, `one of ${EMITTER_MESH_MODES.join(', ')}`);
  }
  emitter.mesh = input.mesh;
  emitter.from = from;
  if (input.normalSpeed !== undefined) {
    emitter.normalSpeed = finiteNumber(input.normalSpeed, `${path}.normalSpeed`, -1000, 1000);
  }
}

function normalizeEmitter(input, context, path) {
  knownKeys(input, EMITTER_FIELDS, path);
  const shape = input.shape ?? 'point';
  if (!EMITTER_SHAPES.includes(shape)) {
    throw invalidField(`${path}.shape`, shape, `one of ${EMITTER_SHAPES.join(', ')}`);
  }
  const emitter = {
    shape,
    position: input.position === undefined ? [0, 0, 0] : vectorOfThree(input.position, `${path}.position`, POSITION_LIMIT),
    halfExtents: input.halfExtents === undefined ? [0.5, 0.5, 0.5] : vectorOfThree(input.halfExtents, `${path}.halfExtents`, POSITION_LIMIT).map(Math.abs),
    radius: input.radius === undefined ? 0.5 : finiteNumber(input.radius, `${path}.radius`, 0, POSITION_LIMIT),
  };
  if (shape === 'mesh') {
    normalizeMeshEmitter(input, emitter, context, path);
  } else {
    for (const field of ['mesh', 'from', 'normalSpeed']) {
      if (input[field] !== undefined) throw invalidField(`${path}.${field}`, input[field], `left out unless ${path}.shape is "mesh"`);
    }
  }
  return emitter;
}

function normalizeInstances(input, system, context, path) {
  if (input.instances !== undefined) {
    const nodeIds = boundedArray(input.instances, PARTICLE_LIMITS.maxInstances, `${path}.instances`);
    if (!nodeIds.length) {
      throw invalidField(`${path}.instances`, nodeIds, 'at least one node ID, such as ["leaf"]; leave it out to repeat the system node');
    }
    // Instance nodes are only read, so several systems may share one.
    nodeIds.forEach((nodeId, index) => {
      rootNodeWithGeometry(nodeId, context.recipeNodes, new Set(), context.motionNodeIds, context.physicsNodeIds, `${path}.instances[${index}]`, 'particles');
    });
    system.instances = nodeIds;
  }
  const orient = input.orient ?? 'none';
  if (!ORIENT_MODES.includes(orient)) {
    throw invalidField(`${path}.orient`, orient, `one of ${ORIENT_MODES.join(', ')}`);
  }
  const source = system.emitter;
  if (orient === 'normal' && (source.shape !== 'mesh' || source.from === 'volume')) {
    throw invalidField(`${path}.orient`, orient, `"none" or "random", because a normal needs ${path}.emitter.shape "mesh" with from "surface" or "vertices"`);
  }
  if (source.normalSpeed && source.from === 'volume') {
    throw invalidField(`${path}.emitter.normalSpeed`, source.normalSpeed, 'left out when from is "volume", which has no surface normal');
  }
  if (orient !== 'none') system.orient = orient;
}

function normalizeCount(input, path) {
  const count = input.count ?? 100;
  if (!Number.isInteger(count) || count < 1 || count > PARTICLE_LIMITS.maxParticlesPerSystem) {
    throw invalidField(`${path}.count`, count, `a whole number from 1 to ${PARTICLE_LIMITS.maxParticlesPerSystem}, such as 100`);
  }
  return count;
}

function normalizeSeed(input, path) {
  const seed = input.seed ?? 1;
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw invalidField(`${path}.seed`, seed, `a whole number from 0 to ${MAX_SEED}, such as 1`);
  }
  return seed;
}

function normalizeColors(value, path) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw invalidField(path, value, '[start, end], each [r, g, b] from 0 to 1, such as [[1, 0.6, 0.1], [0.3, 0, 0]]', TypeError);
  }
  return value.map((color, index) => vectorOfThree(color, `${path}[${index}]`, 1000).map((channel, channelIndex) => finiteNumber(channel, `${path}[${index}][${channelIndex}]`, 0, 1000)));
}

// [start, end] over the life, in either direction; a number holds one value.
function normalizeAlpha(value, path) {
  if (typeof value === 'number') {
    return [finiteNumber(value, path, 0, 1), value];
  }
  if (!Array.isArray(value) || value.length !== 2) {
    throw invalidField(path, value, 'a number or [start, end] from 0 to 1, such as [1, 0]', TypeError);
  }
  return value.map((entry, index) => finiteNumber(entry, `${path}[${index}]`, 0, 1));
}

function normalizeColliders(value, context, path) {
  const nodeIds = boundedArray(value, PARTICLE_LIMITS.maxColliders, path);
  // Colliders are only read, so several systems may share one.
  nodeIds.forEach((nodeId, index) => {
    rootNodeWithGeometry(nodeId, context.recipeNodes, new Set(), context.motionNodeIds, context.physicsNodeIds, `${path}[${index}]`, 'particles');
  });
  return nodeIds;
}

function normalizeEmitterSystem(input, context, path) {
  knownKeys(input, EMITTER_SYSTEM_FIELDS, path);
  rootNodeWithGeometry(input.node, context.recipeNodes, context.claimedNodes, context.motionNodeIds, context.physicsNodeIds, `${path}.node`, 'particles');
  const system = {
    type: 'emitter', node: input.node, seed: normalizeSeed(input, path), count: normalizeCount(input, path),
    lifetime: rangeOf(input.lifetime ?? 1, `${path}.lifetime`, 0.01, PARTICLE_LIMITS.maxLifetime),
    speed: rangeOf(input.speed ?? 1, `${path}.speed`, 0, 1000),
    size: rangeOf(input.size ?? 0.05, `${path}.size`, 0.0001, 100),
    direction: input.direction === undefined ? [0, 1, 0] : vectorOfThree(input.direction, `${path}.direction`, 1000),
    spread: input.spread === undefined ? 30 : finiteNumber(input.spread, `${path}.spread`, 0, 180),
    emitter: normalizeEmitter(input.emitter ?? {}, context, `${path}.emitter`),
    scale: input.scale ?? 'constant',
    drag: input.drag === undefined ? 0 : finiteNumber(input.drag, `${path}.drag`, 0, 100),
  };
  if (Math.hypot(...system.direction) === 0) {
    throw invalidField(`${path}.direction`, system.direction, 'a direction that is not the zero vector, such as [0, 1, 0]');
  }
  if (!SCALE_MODES.includes(system.scale)) {
    throw invalidField(`${path}.scale`, system.scale, `one of ${SCALE_MODES.join(', ')}`);
  }
  if (input.rate !== undefined) system.rate = finiteNumber(input.rate, `${path}.rate`, 0.01, PARTICLE_LIMITS.maxParticlesPerSystem * 100);
  if (input.bounce !== undefined) system.bounce = finiteNumber(input.bounce, `${path}.bounce`, 0, 1);
  if (input.friction !== undefined) system.friction = finiteNumber(input.friction, `${path}.friction`, 0, 1);
  if (input.spin !== undefined) system.spin = rangeOf(input.spin, `${path}.spin`, -100000, 100000);
  if (input.color !== undefined) system.color = normalizeColors(input.color, `${path}.color`);
  if (input.alpha !== undefined) system.alpha = normalizeAlpha(input.alpha, `${path}.alpha`);
  if (input.colliders !== undefined) {
    system.colliders = normalizeColliders(input.colliders, context, `${path}.colliders`);
    if (system.colliders.includes(system.node)) {
      throw invalidField(`${path}.colliders`, system.colliders, `node IDs other than the system's own node "${system.node}"`);
    }
  }
  normalizeInstances(input, system, context, path);
  if (input.floor !== undefined) system.floor = finiteNumber(input.floor, `${path}.floor`, -POSITION_LIMIT, POSITION_LIMIT);
  return system;
}

function normalizeHairSystem(input, context, path) {
  knownKeys(input, HAIR_FIELDS, path);
  rootNodeWithGeometry(input.node, context.recipeNodes, context.claimedNodes, context.motionNodeIds, context.physicsNodeIds, `${path}.node`, 'particles');
  // The surface is only read, so several systems may grow from one node.
  rootNodeWithGeometry(input.surface, context.recipeNodes, new Set(), context.motionNodeIds, context.physicsNodeIds, `${path}.surface`, 'particles');
  if (input.surface === input.node) {
    throw invalidField(`${path}.surface`, input.surface, 'a node other than the hair node, such as the head mesh');
  }
  const segments = input.segments ?? 4;
  if (!Number.isInteger(segments) || segments < 1 || segments > HAIR_LIMITS.maxSegments) {
    throw invalidField(`${path}.segments`, segments, `a whole number from 1 to ${HAIR_LIMITS.maxSegments}, such as 4`);
  }
  const system = {
    type: 'hair', node: input.node, surface: input.surface, seed: normalizeSeed(input, path), count: normalizeCount(input, path), segments,
    length: rangeOf(input.length ?? 0.1, `${path}.length`, 0.001, 100),
    width: finiteNumber(input.width ?? 0.004, `${path}.width`, 0.0001, 10),
    droop: finiteNumber(input.droop ?? 0.5, `${path}.droop`, 0, 10),
    lean: finiteNumber(input.lean ?? 0.2, `${path}.lean`, 0, 2),
  };
  if (input.sway !== undefined) {
    system.sway = finiteNumber(input.sway, `${path}.sway`, 0, 10);
    system.swayRate = finiteNumber(input.swayRate ?? 0.5, `${path}.swayRate`, 0.01, 20);
  }
  return system;
}

function normalizeSystem(input, context, path) {
  const type = input?.type ?? 'emitter';
  if (!SYSTEM_TYPES.includes(type)) {
    throw invalidField(`${path}.type`, type, `one of ${SYSTEM_TYPES.join(', ')}`);
  }
  return type === 'hair' ? normalizeHairSystem(input, context, path) : normalizeEmitterSystem(input, context, path);
}

/** Validate a recipe particles section against its nodes. Returns the plain, bounded form stored in the recipe. */
export function normalizeAgentParticles(input, recipe) {
  if (input === null || input === undefined) {
    return null;
  }
  knownKeys(input, PARTICLES_FIELDS, 'particles');
  const context = bakingContext(recipe, ['cloth']);
  const result = {};
  result.systems = boundedArray(input.systems, PARTICLE_LIMITS.maxSystems, 'particles.systems').map((system, index) => normalizeSystem(system, context, `particles.systems[${index}]`));
  if (!result.systems.length) {
    throw invalidField('particles.systems', result.systems, 'at least one system, such as [{ "node": "sparks" }]; use particles: null to clear it');
  }
  const systemNodes = new Set(result.systems.map(system => system.node));
  for (const system of result.systems) {
    const clash = system.colliders?.find(nodeId => systemNodes.has(nodeId));
    if (clash) {
      throw invalidField('particles.systems', clash, 'colliders that are not particle system nodes, because a system replaces its own geometry with particles');
    }
  }
  const total = result.systems.reduce((sum, system) => sum + system.count, 0);
  if (total > PARTICLE_LIMITS.maxParticles) {
    throw invalidField('particles.systems', `${total} particles in total`, `counts that add up to at most ${PARTICLE_LIMITS.maxParticles}, such as a lower count in each system`);
  }
  if (input.gravity !== undefined) result.gravity = vectorOfThree(input.gravity, 'particles.gravity', 1000);
  if (input.wind !== undefined) result.wind = vectorOfThree(input.wind, 'particles.wind', 100);
  if (input.fields !== undefined) result.fields = normalizeForceFields(input.fields, 'Particle force field');
  return result;
}

function nodeMatrix(node) {
  return mat4.fromRotationTranslationScale(mat4.create(), node.rotation, node.translation, node.scale);
}

// The mesh is built in world space; the part draws it through the node's own matrix, so undo that matrix here.
function worldToNodeLocal(geometry, matrix) {
  const inverse = mat4.invert(mat4.create(), matrix);
  const positions = new Float32Array(geometry.positions.length);
  const normals = new Float32Array(geometry.normals.length);
  for (let offset = 0; offset < positions.length; offset += 3) {
    const x = geometry.positions[offset];
    const y = geometry.positions[offset + 1];
    const z = geometry.positions[offset + 2];
    for (let axis = 0; axis < 3; axis++) {
      positions[offset + axis] = inverse[axis] * x + inverse[4 + axis] * y + inverse[8 + axis] * z + inverse[12 + axis];
      normals[offset + axis] = matrix[axis * 4] * geometry.normals[offset] + matrix[axis * 4 + 1] * geometry.normals[offset + 1] + matrix[axis * 4 + 2] * geometry.normals[offset + 2];
    }
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]) || 1;
    for (let axis = 0; axis < 3; axis++) normals[offset + axis] /= length;
  }
  return Object.freeze({ ...geometry, positions, normals });
}

// Most particles alive at once and the time the last one dies, counted from the launch values alone.
function lifeSummary(launches) {
  const events = [];
  for (let index = 0; index < launches.count; index++) {
    events.push([launches.birth[index], 1], [launches.birth[index] + launches.life[index], -1]);
  }
  events.sort((first, second) => first[0] - second[0] || first[1] - second[1]);
  let alive = 0;
  let peak = 0;
  for (const [, change] of events) {
    alive += change;
    peak = Math.max(peak, alive);
  }
  return { maxAlive: peak, endsAt: Number(events.at(-1)[0].toFixed(4)) };
}

function surfaceInWorld(geometry, matrix) {
  const positions = new Float64Array(geometry.positions.length);
  const normals = new Float64Array(geometry.normals.length);
  const normalMatrix = mat3.normalFromMat4(mat3.create(), matrix);
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      positions[offset + axis] = matrix[axis] * geometry.positions[offset] + matrix[4 + axis] * geometry.positions[offset + 1] + matrix[8 + axis] * geometry.positions[offset + 2] + matrix[12 + axis];
      normals[offset + axis] = normalMatrix[axis] * geometry.normals[offset] + normalMatrix[3 + axis] * geometry.normals[offset + 1] + normalMatrix[6 + axis] * geometry.normals[offset + 2];
    }
  }
  return { positions, normals };
}

function checkVertexBudget(vertices, totalVertices, nodeId) {
  if (vertices > PARTICLE_LIMITS.maxVertices || totalVertices > PARTICLE_LIMITS.maxVertices) {
    throw invalidField('particles.systems', `${totalVertices} vertices on node ${nodeId}`, `shape vertices times count of at most ${PARTICLE_LIMITS.maxVertices}; use a shape with fewer segments or a lower count`);
  }
}

// The geometries a particle can be: the listed instance nodes, or else the system node's own.
function templateNodeIds(system) {
  return system.instances ?? [system.node];
}

function horizontalDirection(wind) {
  const length = Math.hypot(wind[0], wind[2]);
  return length > 1e-6 ? [wind[0] / length, 0, wind[2] / length] : [1, 0, 0];
}

function collisionSurfaceOf(system, nodes, geometries) {
  if (!system.colliders) return undefined;
  const meshes = system.colliders.map(nodeId => {
    const collider = nodes.get(nodeId);
    const geometry = geometries.get(collider.geometry);
    return { positions: surfaceInWorld(geometry, nodeMatrix(collider)).positions, indices: geometry.indices };
  });
  const surface = createCollisionSurface(meshes);
  if (surface.triangleCount > PARTICLE_LIMITS.maxColliderTriangles) {
    throw invalidField('particles.systems', `${surface.triangleCount} collider triangles for node ${system.node}`, `colliders with at most ${PARTICLE_LIMITS.maxColliderTriangles} triangles in total, such as a simpler collider mesh`);
  }
  return surface;
}

function meshSourceOf(system, nodes, geometries) {
  const emitter = system.emitter;
  if (emitter.shape !== 'mesh') return emitter;
  const sourceNode = nodes.get(emitter.mesh);
  const geometry = geometries.get(sourceNode.geometry);
  const world = surfaceInWorld(geometry, nodeMatrix(sourceNode));
  const source = createMeshSource(world.positions, world.normals, geometry.indices, emitter.from);
  if (!source) {
    throw invalidField(`particles.systems[].emitter.mesh`, emitter.mesh, `a node whose mesh has triangles with some area, because emitter.from is "${emitter.from}"`);
  }
  if (source.triangleCount > PARTICLE_LIMITS.maxEmitterTriangles) {
    throw invalidField('particles.systems[].emitter.mesh', `${source.triangleCount} triangles on node ${emitter.mesh}`, `a mesh with at most ${PARTICLE_LIMITS.maxEmitterTriangles} triangles, such as a simpler proxy mesh`);
  }
  return { ...emitter, source };
}

function prepareEmitter(system, node, templates, forces, colliders, emitter) {
  const systemForces = { ...forces, drag: system.drag, floor: system.floor, bounce: system.bounce ?? (colliders ? DEBRIS_BOUNCE : 0), friction: system.friction ?? DEBRIS_FRICTION, colliders };
  const launches = createParticleLaunches({ ...system, emitter, instanceCount: templates.length, spreadRadians: system.spread * Math.PI / 180, forces: systemForces });
  return {
    node,
    report: () => ({ node: system.node, type: 'emitter', particles: system.count, verticesPerParticle: Math.max(...templates.map(template => template.positions.length / 3)), ...lifeSummary(launches) }),
    build: time => buildParticleMesh(templates, launches, systemForces, system.scale, time, system),
  };
}

function prepareHair(system, node, surfaceNode, surfaceGeometry, forces) {
  const world = surfaceInWorld(surfaceGeometry, nodeMatrix(surfaceNode));
  const strands = createStrandRoots({ ...system, spread: system.lean }, world.positions, world.normals, surfaceGeometry.indices);
  const settings = {
    segments: system.segments, width: system.width, droop: system.droop,
    fields: forces.fields,
    sway: system.sway ? { amplitude: system.sway, rate: system.swayRate, direction: horizontalDirection(forces.wind) } : undefined,
  };
  const verticesPerStrand = (system.segments + 1) * HAIR_LIMITS.ringSides;
  let staticMesh = null;
  return {
    node,
    report: () => ({ node: system.node, type: 'hair', surface: system.surface, strands: system.count, segments: system.segments, verticesPerStrand }),
    // Without sway a strand never moves, so one build serves every time.
    build: time => {
      if (settings.sway || settings.fields.some(field => field.type === 'turbulence')) return buildHairMesh(strands, settings, time);
      staticMesh ??= buildHairMesh(strands, settings, 0);
      return staticMesh;
    },
  };
}

/**
 * Prepare the particles section. The result is a pure function of time: `sample(t)` returns the geometry of each
 * system node with every particle or strand placed from its seeded values, so a seek never replays earlier times.
 */
export function bakeAgentParticles(particles, recipe, geometries) {
  const nodes = new Map(recipe.nodes.map(node => [node.id, node]));
  const forces = { gravity: particles.gravity ?? DEFAULT_GRAVITY, wind: particles.wind ?? [0, 0, 0], fields: particles.fields ?? [] };
  let totalVertices = 0;
  const prepared = particles.systems.map(system => {
    const node = nodes.get(system.node);
    const verticesPerItem = system.type === 'hair' ? (system.segments + 1) * HAIR_LIMITS.ringSides : Math.max(...templateNodeIds(system).map(nodeId => geometries.get(nodes.get(nodeId).geometry).positions.length / 3));
    totalVertices += verticesPerItem * system.count;
    checkVertexBudget(verticesPerItem * system.count, totalVertices, system.node);
    if (system.type === 'hair') {
      const surfaceNode = nodes.get(system.surface);
      return prepareHair(system, node, surfaceNode, geometries.get(surfaceNode.geometry), forces);
    }
    const templates = templateNodeIds(system).map(nodeId => geometries.get(nodes.get(nodeId).geometry));
    return prepareEmitter(system, node, templates, forces, collisionSurfaceOf(system, nodes, geometries), meshSourceOf(system, nodes, geometries));
  });
  return Object.freeze({
    sample(time) {
      return new Map(prepared.map(({ node, build }) => [node.id, worldToNodeLocal(build(time), nodeMatrix(node))]));
    },
    /** Counts, vertices drawn and, for emitters, when each system peaks and ends: numbers an agent can read without a picture. */
    report() {
      return { gravity: [...forces.gravity], wind: [...forces.wind], fields: forces.fields.map(field => ({ ...field })), vertices: totalVertices, systems: prepared.map(entry => entry.report()) };
    },
  });
}
