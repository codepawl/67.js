import { oceanSurfaceAt, oceanWaves } from './ocean-waves.js';
import { applyBoatForces, normalizeBoat, resolveBoat } from './physics-boat.js';
import { boundedInteger, boundedNumber, rejectUnknownKeys, rotateByQuaternion } from './physics-values.js';

// Buoyancy for rigid bodies on the ocean. A floating body carries up to 16 sample points. Each point owns an equal share of
// the body's volume as a vertical column the height of the body. Where the sea surface (the same function the ocean
// modifier draws) stands above the point, the column is submerged by a fraction and the water pushes up with
// waterDensity * gravity * (volume / points) * fraction, applied at the point. That lifts, tips and rolls the body. Drag then
// damps the body's linear and angular velocity in proportion to how much of it is under water. Nothing is random, so the same
// seed and definition give the same frames.

export const BUOYANCY_LIMITS = Object.freeze({ maxPointsPerBody: 16, maxWaveEvaluations: 100_000_000 });

const OCEAN_KEYS = ['level', 'waterDensity', 'windSpeed', 'direction', 'choppiness', 'size', 'seed', 'time', 'resolution'];
const FLOAT_KEYS = ['drag', 'angularDrag', 'points', 'boat'];
const MAX_SEED = 0x7fffffff;
const DEFAULT_DRAG = 2;
const CHOPPY_REST_PASSES = 2;

/**
 * Validate the sea bodies float on. The wave fields are those of the ocean mesh edit (same defaults), so a body floats on the
 * surface that edit draws. `level` is the world height of the calm sea, `waterDensity` is in kg/m3, `time` is the sea clock at
 * physics time 0 in seconds.
 */
export function normalizeOcean(input, label = 'ocean') {
  rejectUnknownKeys(input, OCEAN_KEYS, label);
  const ocean = {
    level: boundedNumber(input.level ?? 0, `${label}.level`, -10000, 10000, 0),
    waterDensity: boundedNumber(input.waterDensity ?? 1000, `${label}.waterDensity`, 1, 20000, 1000),
    windSpeed: boundedNumber(input.windSpeed ?? 10, `${label}.windSpeed`, 0, 60, 10, true),
    direction: boundedNumber(input.direction ?? 0, `${label}.direction`, -3600, 3600, 0),
    choppiness: boundedNumber(input.choppiness ?? 1, `${label}.choppiness`, 0, 4, 1),
    size: boundedNumber(input.size ?? 100, `${label}.size`, 1, 10000, 100),
    seed: boundedInteger(input.seed ?? 0, `${label}.seed`, 0, MAX_SEED, 0),
    time: boundedNumber(input.time ?? 0, `${label}.time`, -1e6, 1e6, 0),
    resolution: boundedInteger(input.resolution ?? 8, `${label}.resolution`, 1, 16, 8),
  };
  ocean.waves = oceanWaves(ocean);
  return ocean;
}

/** Validate the `float` field of a body: drag and angularDrag in 1/s (2 each) and up to 16 sample points [x, y, z] in body space. */
export function normalizeFloat(input, label) {
  rejectUnknownKeys(input, FLOAT_KEYS, label);
  const result = {
    drag: boundedNumber(input.drag ?? DEFAULT_DRAG, `${label}.drag`, 0, 100, DEFAULT_DRAG),
    angularDrag: boundedNumber(input.angularDrag ?? DEFAULT_DRAG, `${label}.angularDrag`, 0, 100, DEFAULT_DRAG),
  };
  if (input.points !== undefined) {
    const points = input.points;
    if (!Array.isArray(points) || points.length < 1 || points.length > BUOYANCY_LIMITS.maxPointsPerBody) {
      throw new RangeError(`${label}.points must be 1 to ${BUOYANCY_LIMITS.maxPointsPerBody} points in body space, such as [[-1, 0, -1], [1, 0, 1]]`);
    }
    result.points = points.map((point, index) => {
      if (!Array.isArray(point) || point.length !== 3) {
        throw new TypeError(`${label}.points[${index}] must be [x, y, z] in body space, such as [0, 0, 0]`);
      }
      return point.map((component, axis) => boundedNumber(component, `${label}.points[${index}][${axis}]`, -1e6, 1e6, 0));
    });
  }
  if (input.boat !== undefined) result.boat = normalizeBoat(input.boat, `${label}.boat`);
  return result;
}

function colliderBounds(collider) {
  const [offsetX, offsetY, offsetZ] = collider.translation;
  let half;
  let center = [offsetX, offsetY, offsetZ];
  if (collider.points) {
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < collider.points.length; index += 3) {
      for (let axis = 0; axis < 3; axis++) {
        low[axis] = Math.min(low[axis], collider.points[index + axis]);
        high[axis] = Math.max(high[axis], collider.points[index + axis]);
      }
    }
    half = low.map((value, axis) => (high[axis] - value) / 2);
    center = center.map((value, axis) => value + (low[axis] + high[axis]) / 2);
  } else if (collider.halfExtents) {
    half = collider.halfExtents;
  } else if (collider.shape === 'ball') {
    half = [collider.radius, collider.radius, collider.radius];
  } else if (collider.shape === 'capsule') {
    half = [collider.radius, collider.halfHeight + collider.radius, collider.radius];
  } else {
    half = [collider.radius, collider.halfHeight, collider.radius];
  }
  return { low: center.map((value, axis) => value - half[axis]), high: center.map((value, axis) => value + half[axis]) };
}

/**
 * The buoyancy data of one floating body: displaced volume, the height of each column and the sample points. Without
 * `points` four sit in a 2 x 2 grid across the collider bounds at mid height. Collider rotations are ignored for the bounds.
 */
export function floatingBody(floatSpec, bodyColliders, label) {
  const solid = bodyColliders.filter(collider => collider.volume !== undefined);
  if (!solid.length) throw new TypeError(`${label} needs a ball, box, capsule, cylinder, cone or convex collider to float; trimesh has no volume`);
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const collider of solid) {
    const bounds = colliderBounds(collider);
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], bounds.low[axis]);
      high[axis] = Math.max(high[axis], bounds.high[axis]);
    }
  }
  const middle = low.map((value, axis) => (value + high[axis]) / 2);
  const quarter = [(high[0] - low[0]) / 4, 0, (high[2] - low[2]) / 4];
  const points = floatSpec.points ?? [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sideX, sideZ]) => [middle[0] + sideX * quarter[0], middle[1], middle[2] + sideZ * quarter[2]]);
  return {
    drag: floatSpec.drag,
    angularDrag: floatSpec.angularDrag,
    points,
    boat: floatSpec.boat === undefined ? undefined : resolveBoat(floatSpec.boat, low, high),
    volume: solid.reduce((total, collider) => total + collider.volume, 0),
    columnHeight: Math.max(high[1] - low[1], 1e-6),
  };
}

/** The reason a scene's float work is too large, or null: wave evaluations over all points and frames. */
export function checkBuoyancyWork(ocean, floatingBodies, frameCount) {
  const pointCount = floatingBodies.reduce((total, body) => total + body.points.length, 0);
  const passes = ocean.choppiness > 0 ? CHOPPY_REST_PASSES + 1 : 1;
  const evaluations = ocean.waves.length * pointCount * frameCount * passes;
  if (evaluations > BUOYANCY_LIMITS.maxWaveEvaluations) {
    throw new RangeError(`buoyancy would make ${evaluations} wave evaluations, over the limit of ${BUOYANCY_LIMITS.maxWaveEvaluations}. Lower ocean.resolution, the float points or the duration.`);
  }
}

/** Height of the sea surface above the calm level at a world position and physics time, following the horizontal pull of choppy waves. */
export function seaHeightAt(ocean, worldX, worldZ, time) {
  const seaTime = ocean.time + time;
  // The ocean mesh edit of a y-up sea reads the waves with its first horizontal axis (z) as the wave x and its second (x) as the
  // wave z, and pulls them by moveX and moveZ in that order. The same order here puts a body on the wave the mesh draws.
  let restFirst = worldZ;
  let restSecond = worldX;
  if (ocean.choppiness > 0) {
    for (let pass = 0; pass < CHOPPY_REST_PASSES; pass++) {
      const surface = oceanSurfaceAt(ocean.waves, restFirst, restSecond, seaTime, ocean.choppiness);
      restFirst = worldZ - surface.moveX;
      restSecond = worldX - surface.moveZ;
    }
  }
  return oceanSurfaceAt(ocean.waves, restFirst, restSecond, seaTime, ocean.choppiness).height;
}

/**
 * Push every floating body for one step of `preparedScene.timestep` seconds at physics `time`: an upward impulse at each
 * sample point by its submerged fraction, then drag on both velocities by the body's mean submerged fraction.
 */
export function applyBuoyancy(preparedScene, bodies, time) {
  const { ocean, floating } = preparedScene.buoyancy;
  const step = preparedScene.timestep;
  const gravity = Math.hypot(...preparedScene.gravity);
  for (const floater of floating) {
    const body = bodies[floater.bodyIndex];
    const translation = body.translation();
    const rotation = body.rotation();
    const pointVolume = floater.volume / floater.points.length;
    let submergedTotal = 0;
    for (const localPoint of floater.points) {
      const offset = rotateByQuaternion(localPoint, rotation);
      const pointX = translation.x + offset[0];
      const pointY = translation.y + offset[1];
      const pointZ = translation.z + offset[2];
      const surfaceHeight = ocean.level + seaHeightAt(ocean, pointX, pointZ, time);
      const submerged = Math.min(1, Math.max(0, (surfaceHeight - pointY) / floater.columnHeight + 0.5));
      if (submerged === 0) continue;
      submergedTotal += submerged;
      const lift = ocean.waterDensity * gravity * pointVolume * submerged * step;
      body.applyImpulseAtPoint({ x: 0, y: lift, z: 0 }, { x: pointX, y: pointY, z: pointZ }, true);
    }
    if (submergedTotal === 0) continue;
    const meanSubmerged = submergedTotal / floater.points.length;
    if (floater.boat) applyBoatForces(body, floater.boat, time, step, meanSubmerged);
    const linearKeep = Math.exp(-floater.drag * meanSubmerged * step);
    const angularKeep = Math.exp(-floater.angularDrag * meanSubmerged * step);
    const linear = body.linvel();
    const angular = body.angvel();
    body.setLinvel({ x: linear.x * linearKeep, y: linear.y * linearKeep, z: linear.z * linearKeep }, true);
    body.setAngvel({ x: angular.x * angularKeep, y: angular.y * angularKeep, z: angular.z * angularKeep }, true);
  }
}
export { setBoatControls } from './physics-boat.js';
