import { mat3, mat4 } from 'gl-matrix';
import { HAIR_LIMITS, buildHairMesh, createStrandRoots } from './hair.js';
import { normalizeForceFields } from './force-fields.js';
import { PARTICLE_LIMITS, buildParticleMesh, createParticleLaunches } from './particles.js';
import { createCollisionSurface } from './particle-collision.js';
import { bakingContext, boundedArray, finiteNumber, knownKeys, rootNodeWithGeometry, vectorOfThree } from './agent-recipe-checks.js';

const PARTICLES_FIELDS = ['gravity', 'wind', 'fields', 'systems'];
const SYSTEM_TYPES = ['emitter', 'hair'];
const EMITTER_SYSTEM_FIELDS = ['type', 'node', 'seed', 'count', 'rate', 'lifetime', 'speed', 'direction', 'spread', 'emitter', 'size', 'scale', 'drag', 'floor', 'bounce', 'friction', 'colliders', 'spin', 'color', 'alpha'];
const HAIR_FIELDS = ['type', 'node', 'surface', 'seed', 'count', 'length', 'segments', 'width', 'droop', 'lean', 'sway', 'swayRate'];
const EMITTER_FIELDS = ['shape', 'position', 'halfExtents', 'radius'];
const EMITTER_SHAPES = ['point', 'box', 'sphere', 'disc'];
const SCALE_MODES = ['constant', 'shrink', 'grow'];
const DEFAULT_GRAVITY = Object.freeze([0, -9.81, 0]);
// Defaults that read as debris: a bounce keeps 30 percent of the speed (the first release of collision stuck at 0 without colliders and had no default with them), friction 0.5.
const DEBRIS_BOUNCE = 0.3;
const DEBRIS_FRICTION = 0.5;
const POSITION_LIMIT = 10000;
const MAX_SEED = 0xffffffff;

// A number stands for the range [value, value].
function rangeOf(value, label, minimum, maximum) {
  if (typeof value === 'number') {
    return [finiteNumber(value, label, minimum, maximum), value];
  }
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError(`${label} must be a number or [minimum, maximum].`);
  }
  const range = value.map(entry => finiteNumber(entry, label, minimum, maximum));
  if (range[0] > range[1]) {
    throw new RangeError(`${label} minimum must not exceed its maximum.`);
  }
  return range;
}

function normalizeEmitter(input) {
  knownKeys(input, EMITTER_FIELDS, 'particle emitter');
  const shape = input.shape ?? 'point';
  if (!EMITTER_SHAPES.includes(shape)) {
    throw new RangeError(`Particle emitter shape must be one of ${EMITTER_SHAPES.join(', ')}.`);
  }
  return {
    shape,
    position: input.position === undefined ? [0, 0, 0] : vectorOfThree(input.position, 'Particle emitter position', POSITION_LIMIT),
    halfExtents: input.halfExtents === undefined ? [0.5, 0.5, 0.5] : vectorOfThree(input.halfExtents, 'Particle emitter halfExtents', POSITION_LIMIT).map(Math.abs),
    radius: input.radius === undefined ? 0.5 : finiteNumber(input.radius, 'Particle emitter radius', 0, POSITION_LIMIT),
  };
}

function normalizeCount(input) {
  const count = input.count ?? 100;
  if (!Number.isInteger(count) || count < 1 || count > PARTICLE_LIMITS.maxParticlesPerSystem) {
    throw new RangeError(`Particle count must be an integer from 1 to ${PARTICLE_LIMITS.maxParticlesPerSystem}.`);
  }
  return count;
}

function normalizeSeed(input) {
  const seed = input.seed ?? 1;
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new RangeError(`Particle seed must be an integer from 0 to ${MAX_SEED}.`);
  }
  return seed;
}

function normalizeColors(value) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError('Particle color must be [start, end], each [r, g, b] from 0 to 1.');
  }
  return value.map(color => vectorOfThree(color, 'Particle color', 1000).map(channel => finiteNumber(channel, 'Particle color', 0, 1000)));
}

// [start, end] over the life, in either direction; a number holds one value.
function normalizeAlpha(value) {
  if (typeof value === 'number') {
    return [finiteNumber(value, 'Particle alpha', 0, 1), value];
  }
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError('Particle alpha must be a number or [start, end] from 0 to 1.');
  }
  return value.map(entry => finiteNumber(entry, 'Particle alpha', 0, 1));
}

function normalizeColliders(value, context) {
  const nodeIds = boundedArray(value, PARTICLE_LIMITS.maxColliders, 'Particle colliders');
  // Colliders are only read, so several systems may share one.
  for (const nodeId of nodeIds) {
    rootNodeWithGeometry(nodeId, context.recipeNodes, new Set(), context.motionNodeIds, context.physicsNodeIds, 'Particle collider', 'particles');
  }
  return nodeIds;
}

function normalizeEmitterSystem(input, context) {
  knownKeys(input, EMITTER_SYSTEM_FIELDS, 'particle system');
  rootNodeWithGeometry(input.node, context.recipeNodes, context.claimedNodes, context.motionNodeIds, context.physicsNodeIds, 'Particle system', 'particles');
  const system = {
    type: 'emitter', node: input.node, seed: normalizeSeed(input), count: normalizeCount(input),
    lifetime: rangeOf(input.lifetime ?? 1, 'Particle lifetime', 0.01, PARTICLE_LIMITS.maxLifetime),
    speed: rangeOf(input.speed ?? 1, 'Particle speed', 0, 1000),
    size: rangeOf(input.size ?? 0.05, 'Particle size', 0.0001, 100),
    direction: input.direction === undefined ? [0, 1, 0] : vectorOfThree(input.direction, 'Particle direction', 1000),
    spread: input.spread === undefined ? 30 : finiteNumber(input.spread, 'Particle spread', 0, 180),
    emitter: normalizeEmitter(input.emitter ?? {}),
    scale: input.scale ?? 'constant',
    drag: input.drag === undefined ? 0 : finiteNumber(input.drag, 'Particle drag', 0, 100),
  };
  if (Math.hypot(...system.direction) === 0) {
    throw new RangeError('Particle direction must not be the zero vector.');
  }
  if (!SCALE_MODES.includes(system.scale)) {
    throw new RangeError(`Particle scale must be one of ${SCALE_MODES.join(', ')}.`);
  }
  if (input.rate !== undefined) system.rate = finiteNumber(input.rate, 'Particle rate', 0.01, PARTICLE_LIMITS.maxParticlesPerSystem * 100);
  if (input.bounce !== undefined) system.bounce = finiteNumber(input.bounce, 'Particle bounce', 0, 1);
  if (input.friction !== undefined) system.friction = finiteNumber(input.friction, 'Particle friction', 0, 1);
  if (input.spin !== undefined) system.spin = rangeOf(input.spin, 'Particle spin', -100000, 100000);
  if (input.color !== undefined) system.color = normalizeColors(input.color);
  if (input.alpha !== undefined) system.alpha = normalizeAlpha(input.alpha);
  if (input.colliders !== undefined) {
    system.colliders = normalizeColliders(input.colliders, context);
    if (system.colliders.includes(system.node)) {
      throw new RangeError('A particle system node cannot be its own collider.');
    }
  }
  if (input.floor !== undefined) system.floor = finiteNumber(input.floor, 'Particle floor', -POSITION_LIMIT, POSITION_LIMIT);
  return system;
}

function normalizeHairSystem(input, context) {
  knownKeys(input, HAIR_FIELDS, 'hair system');
  rootNodeWithGeometry(input.node, context.recipeNodes, context.claimedNodes, context.motionNodeIds, context.physicsNodeIds, 'Hair system', 'particles');
  // The surface is only read, so several systems may grow from one node.
  rootNodeWithGeometry(input.surface, context.recipeNodes, new Set(), context.motionNodeIds, context.physicsNodeIds, 'Hair surface', 'particles');
  if (input.surface === input.node) {
    throw new RangeError('Hair surface and hair node must be different nodes.');
  }
  const segments = input.segments ?? 4;
  if (!Number.isInteger(segments) || segments < 1 || segments > HAIR_LIMITS.maxSegments) {
    throw new RangeError(`Hair segments must be an integer from 1 to ${HAIR_LIMITS.maxSegments}.`);
  }
  const system = {
    type: 'hair', node: input.node, surface: input.surface, seed: normalizeSeed(input), count: normalizeCount(input), segments,
    length: rangeOf(input.length ?? 0.1, 'Hair length', 0.001, 100),
    width: finiteNumber(input.width ?? 0.004, 'Hair width', 0.0001, 10),
    droop: finiteNumber(input.droop ?? 0.5, 'Hair droop', 0, 10),
    lean: finiteNumber(input.lean ?? 0.2, 'Hair lean', 0, 2),
  };
  if (input.sway !== undefined) {
    system.sway = finiteNumber(input.sway, 'Hair sway', 0, 10);
    system.swayRate = finiteNumber(input.swayRate ?? 0.5, 'Hair swayRate', 0.01, 20);
  }
  return system;
}

function normalizeSystem(input, context) {
  const type = input?.type ?? 'emitter';
  if (!SYSTEM_TYPES.includes(type)) {
    throw new RangeError(`Particle system type must be one of ${SYSTEM_TYPES.join(', ')}.`);
  }
  return type === 'hair' ? normalizeHairSystem(input, context) : normalizeEmitterSystem(input, context);
}

/** Validate a recipe particles section against its nodes. Returns the plain, bounded form stored in the recipe. */
export function normalizeAgentParticles(input, recipe) {
  if (input === null || input === undefined) {
    return null;
  }
  knownKeys(input, PARTICLES_FIELDS, 'particles');
  const context = bakingContext(recipe, ['cloth']);
  const result = {};
  result.systems = boundedArray(input.systems, PARTICLE_LIMITS.maxSystems, 'Particle systems').map(system => normalizeSystem(system, context));
  if (!result.systems.length) {
    throw new RangeError('Particles need at least one system. Use null to clear it.');
  }
  const systemNodes = new Set(result.systems.map(system => system.node));
  for (const system of result.systems) {
    const clash = system.colliders?.find(nodeId => systemNodes.has(nodeId));
    if (clash) {
      throw new RangeError(`Particle collider ${clash} is a particle system node; its own geometry is replaced by particles.`);
    }
  }
  const total = result.systems.reduce((sum, system) => sum + system.count, 0);
  if (total > PARTICLE_LIMITS.maxParticles) {
    throw new RangeError(`Particle systems hold ${total} particles; the limit is ${PARTICLE_LIMITS.maxParticles} in total.`);
  }
  if (input.gravity !== undefined) result.gravity = vectorOfThree(input.gravity, 'Particle gravity', 1000);
  if (input.wind !== undefined) result.wind = vectorOfThree(input.wind, 'Particle wind', 100);
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
    throw new RangeError(`Particle node ${nodeId} would draw ${totalVertices} vertices (shape vertices times count); the limit is ${PARTICLE_LIMITS.maxVertices}. Use a shape with fewer segments or a lower count.`);
  }
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
    throw new RangeError(`Particle colliders of ${system.node} hold ${surface.triangleCount} triangles; the limit is ${PARTICLE_LIMITS.maxColliderTriangles}.`);
  }
  return surface;
}

function prepareEmitter(system, node, template, forces, colliders) {
  const systemForces = { ...forces, drag: system.drag, floor: system.floor, bounce: system.bounce ?? (colliders ? DEBRIS_BOUNCE : 0), friction: system.friction ?? DEBRIS_FRICTION, colliders };
  const launches = createParticleLaunches({ ...system, spreadRadians: system.spread * Math.PI / 180, forces: systemForces });
  return {
    node,
    report: () => ({ node: system.node, type: 'emitter', particles: system.count, verticesPerParticle: template.positions.length / 3, ...lifeSummary(launches) }),
    build: time => buildParticleMesh(template, launches, systemForces, system.scale, time, system),
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
    const verticesPerItem = system.type === 'hair' ? (system.segments + 1) * HAIR_LIMITS.ringSides : geometries.get(node.geometry).positions.length / 3;
    totalVertices += verticesPerItem * system.count;
    checkVertexBudget(verticesPerItem * system.count, totalVertices, system.node);
    if (system.type === 'hair') {
      const surfaceNode = nodes.get(system.surface);
      return prepareHair(system, node, surfaceNode, geometries.get(surfaceNode.geometry), forces);
    }
    return prepareEmitter(system, node, geometries.get(node.geometry), forces, collisionSurfaceOf(system, nodes, geometries));
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
