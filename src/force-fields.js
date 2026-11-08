// Force fields: wind, turbulence, vortex, drag and magnet. One evaluation turns a field, a position, a velocity and a
// time into an acceleration, so particles, hair and cloth all read the same fields. There is no state and no
// random call outside the seeded lattice hash, so the same seed gives the same frames.

export const FORCE_FIELD_TYPES = Object.freeze(['wind', 'turbulence', 'vortex', 'drag', 'magnet']);
export const FORCE_FIELD_LIMITS = Object.freeze({ maxFields: 8, maxStrength: 1000, maxRange: 10000 });

const FIELD_KEYS = ['type', 'strength', 'position', 'direction', 'axis', 'falloff', 'radius', 'seed', 'scale', 'rate'];
const SEED_MIXER = 0x9e3779b1;
const LATTICE_PRIME = [73856093, 19349663, 83492791];

function checkedNumber(value, label, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a number from ${minimum} to ${maximum}.`);
  }
  return value;
}

function checkedVector(value, label, limit) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError(`${label} must be [x, y, z].`);
  }
  return value.map(component => checkedNumber(component, label, -limit, limit));
}

function unitVector(vector, label) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length === 0) {
    throw new RangeError(`${label} must not be the zero vector.`);
  }
  return vector.map(component => component / length);
}

/**
 * Validate a list of force fields into plain bounded objects. `strength` is an acceleration in m/s2 (for drag, a rate
 * in 1/s). `falloff` is the exponent of 1 / (1 + distance) from `position` (0 means no falloff) and `radius` cuts the
 * field off beyond that distance (0 means no cutoff). Turbulence takes `scale` (cycles per metre) and `rate`
 * (cycles per second).
 */
export function normalizeForceFields(input, label = 'Force fields') {
  if (!Array.isArray(input) || input.length > FORCE_FIELD_LIMITS.maxFields) {
    throw new RangeError(`${label} must be a list of at most ${FORCE_FIELD_LIMITS.maxFields} fields.`);
  }
  return input.map((field, index) => {
    const name = `${label} ${index + 1}`;
    if (field === null || typeof field !== 'object' || Array.isArray(field)) {
      throw new TypeError(`${name} must be an object.`);
    }
    const unknown = Object.keys(field).filter(key => !FIELD_KEYS.includes(key));
    if (unknown.length) {
      throw new RangeError(`${name} has unknown fields: ${unknown.join(', ')}. Known: ${FIELD_KEYS.join(', ')}.`);
    }
    if (!FORCE_FIELD_TYPES.includes(field.type)) {
      throw new RangeError(`${name} type must be one of ${FORCE_FIELD_TYPES.join(', ')}.`);
    }
    const seed = field.seed ?? 1;
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new RangeError(`${name} seed must be an integer from 0 to 4294967295.`);
    }
    const result = {
      type: field.type,
      strength: checkedNumber(field.strength ?? 1, `${name} strength`, -FORCE_FIELD_LIMITS.maxStrength, FORCE_FIELD_LIMITS.maxStrength),
      position: checkedVector(field.position ?? [0, 0, 0], `${name} position`, FORCE_FIELD_LIMITS.maxRange),
      falloff: checkedNumber(field.falloff ?? 0, `${name} falloff`, 0, 8),
      radius: checkedNumber(field.radius ?? 0, `${name} radius`, 0, FORCE_FIELD_LIMITS.maxRange),
      seed,
    };
    if (field.type === 'wind') {
      result.direction = unitVector(checkedVector(field.direction ?? [1, 0, 0], `${name} direction`, 1000), `${name} direction`);
    }
    if (field.type === 'vortex') {
      result.axis = unitVector(checkedVector(field.axis ?? [0, 1, 0], `${name} axis`, 1000), `${name} axis`);
    }
    if (field.type === 'turbulence') {
      result.scale = checkedNumber(field.scale ?? 1, `${name} scale`, 0.001, 1000);
      result.rate = checkedNumber(field.rate ?? 0.5, `${name} rate`, 0, 100);
    }
    return Object.freeze(result);
  });
}

function latticeValue(seed, x, y, z, channel) {
  let hash = Math.imul(seed ^ SEED_MIXER, 0x85ebca6b) ^ Math.imul(channel + 1, 0xc2b2ae35);
  hash ^= Math.imul(x, LATTICE_PRIME[0]) ^ Math.imul(y, LATTICE_PRIME[1]) ^ Math.imul(z, LATTICE_PRIME[2]);
  hash = Math.imul(hash ^ hash >>> 16, 0x7feb352d);
  hash = Math.imul(hash ^ hash >>> 15, 0x846ca68b);
  return ((hash ^ hash >>> 16) >>> 0) / 4294967296 * 2 - 1;
}

function smooth(fraction) {
  return fraction * fraction * (3 - 2 * fraction);
}

// Trilinear value noise in [-1, 1] on an integer lattice, one independent channel per axis of the result.
function valueNoise(seed, x, y, z, channel) {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const cellZ = Math.floor(z);
  const fractionX = smooth(x - cellX);
  const fractionY = smooth(y - cellY);
  const fractionZ = smooth(z - cellZ);
  let total = 0;
  for (let corner = 0; corner < 8; corner++) {
    const offsetX = corner & 1;
    const offsetY = corner >> 1 & 1;
    const offsetZ = corner >> 2 & 1;
    const weight = (offsetX ? fractionX : 1 - fractionX) * (offsetY ? fractionY : 1 - fractionY) * (offsetZ ? fractionZ : 1 - fractionZ);
    total += weight * latticeValue(seed, cellX + offsetX, cellY + offsetY, cellZ + offsetZ, channel);
  }
  return total;
}

// Distance weight of one field at a point: 1 at the field's position, shrinking with the falloff exponent.
function reach(field, offsetX, offsetY, offsetZ) {
  if (field.falloff === 0 && field.radius === 0) {
    return 1;
  }
  const distance = Math.hypot(offsetX, offsetY, offsetZ);
  if (field.radius > 0 && distance > field.radius) {
    return 0;
  }
  return field.falloff === 0 ? 1 : (1 + distance) ** -field.falloff;
}

/**
 * Adds the acceleration of one field at `position` (moving at `velocity`, at `time`) into `target`, a 3-number array
 * or typed array at `targetOffset`. Allocation free, so a solver can call it for every particle every substep.
 */
export function addFieldAcceleration(field, position, velocity, time, target, targetOffset = 0) {
  const offsetX = position[0] - field.position[0];
  const offsetY = position[1] - field.position[1];
  const offsetZ = position[2] - field.position[2];
  const weight = reach(field, offsetX, offsetY, offsetZ) * field.strength;
  if (weight === 0) {
    return;
  }
  if (field.type === 'wind') {
    for (let axis = 0; axis < 3; axis++) target[targetOffset + axis] += field.direction[axis] * weight;
  } else if (field.type === 'drag') {
    for (let axis = 0; axis < 3; axis++) target[targetOffset + axis] -= velocity[axis] * weight;
  } else if (field.type === 'magnet') {
    const distance = Math.hypot(offsetX, offsetY, offsetZ);
    if (distance < 1e-9) return;
    target[targetOffset] -= offsetX / distance * weight;
    target[targetOffset + 1] -= offsetY / distance * weight;
    target[targetOffset + 2] -= offsetZ / distance * weight;
  } else if (field.type === 'vortex') {
    const [axisX, axisY, axisZ] = field.axis;
    const swirlX = axisY * offsetZ - axisZ * offsetY;
    const swirlY = axisZ * offsetX - axisX * offsetZ;
    const swirlZ = axisX * offsetY - axisY * offsetX;
    const swirlLength = Math.hypot(swirlX, swirlY, swirlZ);
    if (swirlLength < 1e-9) return;
    target[targetOffset] += swirlX / swirlLength * weight;
    target[targetOffset + 1] += swirlY / swirlLength * weight;
    target[targetOffset + 2] += swirlZ / swirlLength * weight;
  } else {
    const frequency = field.scale;
    const drift = time * field.rate;
    for (let axis = 0; axis < 3; axis++) {
      target[targetOffset + axis] += weight * valueNoise(field.seed, position[0] * frequency + drift, position[1] * frequency + drift, position[2] * frequency + drift, axis);
    }
  }
}

/** Sum of every field's acceleration into `target` (zeroed first). Returns `target`. */
export function evaluateForceFields(fields, position, velocity, time, target) {
  target[0] = 0;
  target[1] = 0;
  target[2] = 0;
  for (const field of fields) {
    addFieldAcceleration(field, position, velocity, time, target);
  }
  return target;
}
