// A wake on the ocean: a bounded trail of points behind a moving hull. Each point is [x, z, strength, width] in the sea's
// horizontal plane. Where a point reaches a vertex it raises the `foam` group and pushes the surface down along the track with a
// small ridge at either side, so the foam the ocean already draws shows a V behind the boat. The trail is a pure function of the
// points, so the same hull path gives the same vertices on every run.

export const MAX_WAKE_POINTS = 64;
export const WAKE_FOAM_REACH = 3;

const DEFAULT_WAKE_HEIGHT = 0.12;
const MAXIMUM_WAKE_HEIGHT = 2;
const REFERENCE_SPEED = 3;
const SPREAD_PER_LIFETIME = 2;
const MINIMUM_STRENGTH = 0.01;

function describe(value) {
  return Array.isArray(value) ? `an array of ${value.length}` : value === null ? 'null' : typeof value;
}

/**
 * Validate the `wake` field of an ocean node: `points` (up to 64 of [x, z, strength, width]; strength 0 to 1 and width in
 * metres) and `height`, the depth of the trough in metres (0 to 2, default 0.12).
 */
export function normalizeWake(input, label = 'wake') {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object like { points: [[0, 0, 1, 1.2]] }, got ${describe(input)}`);
  }
  for (const key of Object.keys(input)) {
    if (key !== 'points' && key !== 'height') throw new TypeError(`${label}.${key} is unsupported; use points or height`);
  }
  const points = input.points ?? [];
  if (!Array.isArray(points) || points.length > MAX_WAKE_POINTS) {
    throw new RangeError(`${label}.points must be an array of at most ${MAX_WAKE_POINTS} points [x, z, strength, width], such as [[0, 0, 1, 1.2]], got ${describe(points)}`);
  }
  const height = input.height ?? DEFAULT_WAKE_HEIGHT;
  if (typeof height !== 'number' || !Number.isFinite(height) || height < 0 || height > MAXIMUM_WAKE_HEIGHT) {
    throw new RangeError(`${label}.height must be a number from 0 to ${MAXIMUM_WAKE_HEIGHT}, such as ${DEFAULT_WAKE_HEIGHT}`);
  }
  const checked = points.map((point, index) => {
    const valid = Array.isArray(point) && point.length === 4 && point.every(Number.isFinite) && point[2] >= 0 && point[2] <= 1 && point[3] > 0 && point[3] <= 1000;
    if (!valid) {
      throw new RangeError(`${label}.points[${index}] must be [x, z, strength, width] with strength from 0 to 1 and width above 0, such as [0, 0, 1, 1.2]`);
    }
    return point.slice();
  });
  return { points: checked, height };
}

/** Foam (0 to 1) and surface offset in metres that a wake adds at one horizontal position. */
export function wakeAt(wake, positionX, positionZ) {
  let foam = 0;
  let offset = 0;
  for (const [pointX, pointZ, strength, width] of wake.points) {
    const distance = Math.hypot(positionX - pointX, positionZ - pointZ) / width;
    if (distance > WAKE_FOAM_REACH) continue;
    const falloff = Math.exp(-distance * distance / 2);
    foam = Math.max(foam, strength * falloff);
    // A negative Ricker profile: a trough on the track and a ridge on both sides.
    offset -= wake.height * strength * (1 - distance * distance) * falloff;
  }
  return { foam, offset };
}

/**
 * The wake points of a hull at `time`: the last `lifetime` seconds of its path, `count` samples (at most 64) evenly spaced.
 * `sample(time)` returns the stern as { x, z, speed }. Older points are weaker and wider, and a slow hull leaves little.
 */
export function wakeTrail({ sample, time, lifetime, width, strength, count = MAX_WAKE_POINTS }) {
  const points = [];
  const total = Math.min(count, MAX_WAKE_POINTS);
  for (let index = 0; index < total; index++) {
    const age = lifetime * index / total;
    if (time - age < 0) break;
    const stern = sample(time - age);
    const fade = (1 - age / lifetime) ** 2;
    const pointStrength = strength * Math.min(1, stern.speed / REFERENCE_SPEED) * fade;
    if (pointStrength < MINIMUM_STRENGTH) continue;
    points.push([stern.x, stern.z, pointStrength, width * (1 + SPREAD_PER_LIFETIME * age / lifetime)]);
  }
  return points;
}
