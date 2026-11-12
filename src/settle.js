// Settle: drop props onto scene colliders as rigid bodies, run Rapier at a fixed step for a bounded time and return the
// resting transforms, so scattered rubble, crates and pebbles lie against each other instead of hovering where they were
// placed. The caller writes the result back as static parts (the `settle` scene operation does). Placement and the solver
// are both deterministic: the same seed and inputs give the same transforms byte for byte.

import { quat, vec3 } from 'gl-matrix';
import { invalidField } from './field-error.js';
import { bakePhysicsScene, loadPhysicsEngine } from './physics.js';
import { createRandom } from './vegetation-geometry.js';

export const SETTLE_LIMITS = Object.freeze({ maxProps: 256, maxColliders: 64, maxDuration: 6, maxAttemptsPerProp: 60 });
const FRAMES_PER_SECOND = 60;
const PLACEMENT_ATTEMPTS_BEFORE_RAISING = 20;
const COLUMN_GROWTH = 1.15;
const PACKING_FRACTION = 0.2;
const MAX_COLUMN_HEIGHT = 40;
const ROUNDING = 1e5;
const SHAPES = ['box', 'ball'];

const SETTINGS_FIELDS = ['colliders', 'shape', 'instances', 'area', 'count', 'density', 'size', 'aspect', 'rotation', 'spacing', 'maxSlope', 'seed', 'duration', 'friction', 'restitution'];
const COLLIDER_FIELDS = ['shape', 'translation', 'rotation', 'halfExtents', 'radius'];
const INSTANCE_FIELDS = ['translation', 'rotation', 'size'];

function finiteNumber(value, path, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidField(path, value, `a number from ${minimum} to ${maximum}, such as ${Math.min(Math.max(1, minimum), maximum)}`);
  }
  return value;
}

function numberList(value, size, path) {
  if (!Array.isArray(value) || value.length !== size || !value.every(Number.isFinite)) {
    throw invalidField(path, value, `an array of ${size} finite numbers, such as [${Array(size).fill(0).join(', ')}]`, TypeError);
  }
  return value;
}

function knownKeys(value, fields, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidField(path, value, 'an object, such as {}', TypeError);
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw invalidField(`${path}.${key}`, value[key], `no such field; use one of ${fields.join(', ')}`, TypeError);
  }
}

function normalizeCollider(input, path) {
  knownKeys(input, COLLIDER_FIELDS, path);
  const shape = input.shape === 'cuboid' ? 'box' : input.shape;
  if (!SHAPES.includes(shape)) throw invalidField(`${path}.shape`, input.shape, `one of ${SHAPES.join(', ')}`);
  const collider = { shape, translation: numberList(input.translation ?? [0, 0, 0], 3, `${path}.translation`) };
  if (shape === 'box') {
    const halfExtents = numberList(input.halfExtents, 3, `${path}.halfExtents`);
    if (halfExtents.some(extent => !(extent > 0))) throw invalidField(`${path}.halfExtents`, halfExtents, 'three positive half sizes, such as [1, 0.1, 1]');
    const rotation = numberList(input.rotation ?? [0, 0, 0, 1], 4, `${path}.rotation`);
    if (!Math.hypot(...rotation)) throw invalidField(`${path}.rotation`, rotation, 'a nonzero quaternion, such as [0, 0, 0, 1]');
    return { ...collider, halfExtents, rotation: quat.normalize(quat.create(), rotation) };
  }
  return { ...collider, radius: finiteNumber(input.radius, `${path}.radius`, 1e-4, 1e6), rotation: quat.create() };
}

function normalizeInstance(input, shape, path) {
  knownKeys(input, INSTANCE_FIELDS, path);
  const translation = numberList(input.translation, 3, `${path}.translation`);
  const rotation = quat.normalize(quat.create(), numberList(input.rotation ?? [0, 0, 0, 1], 4, `${path}.rotation`));
  const size = shape === 'box' ? numberList(input.size, 3, `${path}.size`) : [input.size, input.size, input.size];
  if (!size.every(edge => Number.isFinite(edge) && edge >= 0.001 && edge <= 100)) {
    throw invalidField(`${path}.size`, input.size, shape === 'box' ? 'three edge lengths from 0.001 to 100 metres, such as [0.2, 0.1, 0.3]' : 'a diameter from 0.001 to 100 metres, such as 0.2');
  }
  return { translation, rotation, size };
}

/** Validate settings at the public boundary; returns the plain form `settleInstances` runs. */
export function normalizeSettle(input) {
  knownKeys(input, SETTINGS_FIELDS, 'settle');
  const shape = input.shape ?? 'box';
  if (!SHAPES.includes(shape)) throw invalidField('settle.shape', shape, `one of ${SHAPES.join(', ')}`);
  if (!Array.isArray(input.colliders) || input.colliders.length > SETTLE_LIMITS.maxColliders) {
    throw invalidField('settle.colliders', Array.isArray(input.colliders) ? `${input.colliders.length} entries` : input.colliders, `a list of at most ${SETTLE_LIMITS.maxColliders} colliders, such as [{ "shape": "box", "halfExtents": [2, 0.1, 2] }]`, TypeError);
  }
  const settings = {
    shape,
    colliders: input.colliders.map((collider, index) => normalizeCollider(collider, `settle.colliders[${index}]`)),
    seed: Math.trunc(finiteNumber(input.seed ?? 1, 'settle.seed', 0, 2 ** 32 - 1)),
    duration: finiteNumber(input.duration ?? 3, 'settle.duration', 0.5, SETTLE_LIMITS.maxDuration),
    friction: finiteNumber(input.friction ?? 0.6, 'settle.friction', 0, 10),
    restitution: finiteNumber(input.restitution ?? 0.1, 'settle.restitution', 0, 1),
    spacing: finiteNumber(input.spacing ?? 0.01, 'settle.spacing', 0, 10),
    maxSlope: finiteNumber(input.maxSlope ?? 60, 'settle.maxSlope', 0, 90),
    aspect: finiteNumber(input.aspect ?? 0.3, 'settle.aspect', 0, 1),
    rotation: finiteNumber(input.rotation ?? 1, 'settle.rotation', 0, 1),
  };
  if (!settings.colliders.length) throw invalidField('settle.colliders', [], 'at least one collider to land on, such as [{ "shape": "box", "halfExtents": [2, 0.1, 2] }]');
  if (input.instances !== undefined) {
    if (!Array.isArray(input.instances) || !input.instances.length || input.instances.length > SETTLE_LIMITS.maxProps) {
      throw invalidField('settle.instances', Array.isArray(input.instances) ? `${input.instances.length} entries` : input.instances, `a list of 1 to ${SETTLE_LIMITS.maxProps} instances, such as [{ "translation": [0, 1, 0], "size": [0.2, 0.2, 0.2] }]`, TypeError);
    }
    for (const field of ['area', 'count', 'density', 'size']) {
      if (input[field] !== undefined) throw invalidField(`settle.${field}`, input[field], 'a field left out when instances lists the props', TypeError);
    }
    return { ...settings, instances: input.instances.map((instance, index) => normalizeInstance(instance, shape, `settle.instances[${index}]`)) };
  }
  const { area } = input;
  if (!area) throw invalidField('settle.area', area, 'an area { "min": [x, z], "max": [x, z] } to scatter over, or a list of instances', TypeError);
  knownKeys(area, ['min', 'max'], 'settle.area');
  const min = numberList(area.min, 2, 'settle.area.min');
  const max = numberList(area.max, 2, 'settle.area.max');
  if (max[0] <= min[0] || max[1] <= min[1]) throw invalidField('settle.area', area, 'min below max on both axes, such as { "min": [-1, -1], "max": [1, 1] }');
  const size = numberList(input.size ?? [0.1, 0.25], 2, 'settle.size');
  if (!(size[0] >= 0.001 && size[1] >= size[0] && size[1] <= 100)) throw invalidField('settle.size', size, 'a [smallest, largest] size from 0.001 to 100 metres, such as [0.1, 0.25]');
  if ((input.count === undefined) === (input.density === undefined)) {
    throw invalidField('settle.count', input.count, 'exactly one of count (props) or density (props per square metre)', TypeError);
  }
  const areaSize = (max[0] - min[0]) * (max[1] - min[1]);
  const count = input.count !== undefined
    ? Math.trunc(finiteNumber(input.count, 'settle.count', 1, SETTLE_LIMITS.maxProps))
    : Math.min(SETTLE_LIMITS.maxProps, Math.max(1, Math.round(finiteNumber(input.density, 'settle.density', 1e-6, 1e6) * areaSize)));
  return { ...settings, area: { min, max }, size, count };
}

const upVector = vec3.fromValues(0, 1, 0);

function toLocal(collider, point) {
  const offset = vec3.sub(vec3.create(), point, collider.translation);
  return vec3.transformQuat(offset, offset, quat.invert(quat.create(), collider.rotation));
}

/** Top surface of one collider under (x, z): its height and unit normal, or null when the vertical line misses it. */
function surfaceUnder(collider, x, z) {
  if (collider.shape === 'ball') {
    const horizontal = Math.hypot(x - collider.translation[0], z - collider.translation[2]);
    if (horizontal >= collider.radius) return null;
    const height = collider.translation[1] + Math.sqrt(collider.radius ** 2 - horizontal ** 2);
    const normal = vec3.normalize(vec3.create(), [x - collider.translation[0], height - collider.translation[1], z - collider.translation[2]]);
    return { height, normal };
  }
  const inverse = quat.invert(quat.create(), collider.rotation);
  const origin = toLocal(collider, [x, 1e4, z]);
  const direction = vec3.transformQuat(vec3.create(), [0, -1, 0], inverse);
  let entry = -Infinity;
  let exit = Infinity;
  let entryAxis = -1;
  let entrySign = 1;
  for (let axis = 0; axis < 3; axis++) {
    const half = collider.halfExtents[axis];
    if (Math.abs(direction[axis]) < 1e-12) {
      if (Math.abs(origin[axis]) > half) return null;
      continue;
    }
    const near = (-half - origin[axis]) / direction[axis];
    const far = (half - origin[axis]) / direction[axis];
    const nearT = Math.min(near, far);
    if (nearT > entry) {
      entry = nearT;
      entryAxis = axis;
      entrySign = near < far ? -1 : 1;
    }
    exit = Math.min(exit, Math.max(near, far));
  }
  if (entry > exit || exit < 0 || entryAxis < 0) return null;
  const normalLocal = [0, 0, 0];
  normalLocal[entryAxis] = entrySign;
  const normal = vec3.transformQuat(vec3.create(), normalLocal, collider.rotation);
  return { height: 1e4 - entry, normal };
}

function groundUnder(colliders, x, z) {
  let best = null;
  for (const collider of colliders) {
    const surface = surfaceUnder(collider, x, z);
    if (surface && (!best || surface.height > best.height)) best = surface;
  }
  return best;
}

function clearanceFrom(collider, point) {
  if (collider.shape === 'ball') return vec3.distance(point, collider.translation) - collider.radius;
  const local = toLocal(collider, point);
  const outside = local.map((component, axis) => Math.max(Math.abs(component) - collider.halfExtents[axis], 0));
  return Math.hypot(...outside);
}

function boundingRadius(shape, size) {
  return shape === 'ball' ? size[0] / 2 : Math.hypot(...size) / 2;
}

function tumbleRotation(random, tumble) {
  const yaw = random() * 360;
  const pitch = (random() * 2 - 1) * 90 * tumble;
  const roll = (random() * 2 - 1) * 90 * tumble;
  return quat.fromEuler(quat.create(), pitch, yaw, roll);
}

/** Generates candidate props over the area: spaced apart, off steep ground and clear of every collider. */
function scatterCandidates(settings, skipped) {
  const random = createRandom(settings.seed);
  const { area, colliders, shape, size: sizeRange, aspect, spacing, maxSlope } = settings;
  const meanEdge = (sizeRange[0] + sizeRange[1]) / 2;
  const meanRadius = boundingRadius(shape, [meanEdge, meanEdge, meanEdge]);
  const areaSize = (area.max[0] - area.min[0]) * (area.max[1] - area.min[1]);
  let columnHeight = Math.min(MAX_COLUMN_HEIGHT, Math.max(0.3, settings.count * (4 / 3) * Math.PI * meanRadius ** 3 / PACKING_FRACTION / areaSize));
  const candidates = [];
  const flatSlope = Math.cos(maxSlope * Math.PI / 180);
  for (let index = 0; index < settings.count; index++) {
    for (let attempt = 0; attempt < SETTLE_LIMITS.maxAttemptsPerProp; attempt++) {
      if (attempt > 0 && attempt % PLACEMENT_ATTEMPTS_BEFORE_RAISING === 0) columnHeight = Math.min(MAX_COLUMN_HEIGHT, columnHeight * COLUMN_GROWTH);
      // Every attempt draws the same number of rolls, so a rejection never shifts the later props.
      const rolls = Array.from({ length: 10 }, random);
      const base = sizeRange[0] + (sizeRange[1] - sizeRange[0]) * rolls[0];
      const size = shape === 'ball' ? [base, base, base] : [0, 1, 2].map(axis => base * (1 + aspect * (rolls[1 + axis] * 2 - 1) * 0.5));
      const radius = boundingRadius(shape, size);
      const x = area.min[0] + (area.max[0] - area.min[0]) * rolls[4];
      const z = area.min[1] + (area.max[1] - area.min[1]) * rolls[5];
      const ground = groundUnder(colliders, x, z);
      if (!ground) {
        skipped.noGround++;
        continue;
      }
      if (vec3.dot(ground.normal, upVector) < flatSlope) {
        skipped.tooSteep++;
        continue;
      }
      const translation = [x, ground.height + radius + spacing + columnHeight * rolls[6], z];
      if (colliders.some(collider => clearanceFrom(collider, translation) < radius + spacing)) {
        skipped.overlap++;
        continue;
      }
      if (candidates.some(other => vec3.distance(other.translation, translation) < other.radius + radius + spacing)) {
        skipped.overlap++;
        continue;
      }
      const rotation = tumbleRotation(createRandom(Math.floor(rolls[7] * 2 ** 32)), settings.rotation);
      candidates.push({ translation, rotation, size, radius });
      break;
    }
  }
  return candidates;
}

/** Listed props start where they are given; the ones that start inside a collider or each other are skipped. */
function listedCandidates(settings, skipped) {
  const candidates = [];
  for (const instance of settings.instances) {
    const radius = boundingRadius(settings.shape, instance.size);
    const inside = settings.colliders.some(collider => clearanceFrom(collider, instance.translation) < radius)
      || candidates.some(other => vec3.distance(other.translation, instance.translation) < other.radius + radius);
    if (inside) {
      skipped.overlap++;
      continue;
    }
    candidates.push({ ...instance, radius });
  }
  return candidates;
}

function rounded(values) {
  return Array.from(values, value => Math.round(value * ROUNDING) / ROUNDING);
}

function physicsDefinition(settings, props) {
  const bodies = [];
  const colliders = [];
  settings.colliders.forEach((collider, index) => {
    bodies.push({ name: `ground-${index}`, type: 'fixed', translation: collider.translation, rotation: Array.from(collider.rotation) });
    colliders.push(collider.shape === 'ball'
      ? { name: `ground-${index}`, body: `ground-${index}`, shape: 'ball', radius: collider.radius, friction: settings.friction }
      : { name: `ground-${index}`, body: `ground-${index}`, shape: 'cuboid', halfExtents: collider.halfExtents, friction: settings.friction });
  });
  props.forEach((prop, index) => {
    bodies.push({ name: `prop-${index}`, type: 'dynamic', translation: prop.translation, rotation: Array.from(prop.rotation), ccd: true });
    colliders.push(settings.shape === 'ball'
      ? { name: `prop-${index}`, body: `prop-${index}`, shape: 'ball', radius: prop.size[0] / 2, friction: settings.friction, restitution: settings.restitution }
      : { name: `prop-${index}`, body: `prop-${index}`, shape: 'cuboid', halfExtents: prop.size.map(edge => edge / 2), friction: settings.friction, restitution: settings.restitution });
  });
  return { bodies, colliders };
}

/**
 * Drops props onto the colliders and returns where they come to rest. The solver must be loaded first
 * (await `loadPhysicsEngine()`, or call `settleProps`). Settings are as in `normalizeSettle`.
 * Returns `{ instances: [{ translation, rotation, size }], report }`; `report.skipped` counts rejected placement
 * attempts (no ground below, ground steeper than maxSlope, overlap), not props. A prop that fell off the world is left out and
 * counted in `report.fellOff`, one that still moved at the end is kept and counted in `report.unsettled`.
 */
export function settleInstances(input) {
  const settings = normalizeSettle(input);
  const skipped = { noGround: 0, tooSteep: 0, overlap: 0 };
  const props = settings.instances ? listedCandidates(settings, skipped) : scatterCandidates(settings, skipped);
  const report = { requested: settings.instances?.length ?? settings.count, placed: props.length, skipped, fellOff: 0, unsettled: 0, duration: settings.duration };
  if (!props.length) return { instances: [], report };
  const frameCount = Math.round(settings.duration * FRAMES_PER_SECOND) + 1;
  const scene = bakePhysicsScene(physicsDefinition(settings, props), { frameCount, timestep: 1 / FRAMES_PER_SECOND });
  const finalPose = scene.sample(scene.duration);
  const lowestSurface = Math.min(...settings.colliders.map(collider => (collider.shape === 'ball' ? collider.translation[1] - collider.radius : collider.translation[1] - Math.hypot(...collider.halfExtents))));
  const instances = [];
  props.forEach((prop, index) => {
    const offset = scene.bodyIndex(`prop-${index}`) * 7;
    const translation = finalPose.subarray(offset, offset + 3);
    if (translation[1] < lowestSurface - 1) {
      report.fellOff++;
      return;
    }
    if (scene.restFrames[scene.bodyIndex(`prop-${index}`)] < 0) report.unsettled++;
    instances.push({ translation: rounded(translation), rotation: rounded(finalPose.subarray(offset + 3, offset + 7)), size: rounded(prop.size) });
  });
  scene.dispose();
  report.placed = instances.length;
  return { instances, report };
}

/** Loads the solver if needed, then settles. */
export async function settleProps(input) {
  await loadPhysicsEngine();
  return settleInstances(input);
}
