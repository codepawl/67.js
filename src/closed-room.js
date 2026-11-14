// A cheap test for a closed room: shoot a fixed set of rays from the middle of the scene's bounds and count how many hit
// the inner face of a part. A solid object has only back faces facing a ray that starts inside it, so it never counts as a
// room. It reads no clock and uses no random numbers, so the same scene gives the same share.

export const CLOSED_ROOM_RAYS = 48;
// The same share the automatic reflection probe uses to call a scene a room (probe-trace.js).
export const CLOSED_ROOM_SHARE = 0.9;
// Brute force over every triangle: 48 rays over this many triangles stays near 10 ms, and a larger scene is not tested.
export const CLOSED_ROOM_MAXIMUM_TRIANGLES = 150_000;
const PARALLEL_EPSILON = 1e-9;

function worldTriangles(parts, worldMatrices) {
  let triangleCount = 0;
  for (const part of parts) {
    triangleCount += part.geometry.indices.length / 3;
  }
  if (triangleCount === 0 || triangleCount > CLOSED_ROOM_MAXIMUM_TRIANGLES) {
    return null;
  }
  const corners = new Float64Array(triangleCount * 9);
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const partBounds = [];
  let write = 0;
  for (const part of parts) {
    const matrix = worldMatrices.get(part.name);
    const { positions, indices } = part.geometry;
    const partMinimum = [Infinity, Infinity, Infinity];
    const partMaximum = [-Infinity, -Infinity, -Infinity];
    for (const index of indices) {
      for (let axis = 0; axis < 3; axis++) {
        const value = matrix[axis] * positions[index * 3] + matrix[4 + axis] * positions[index * 3 + 1] + matrix[8 + axis] * positions[index * 3 + 2] + matrix[12 + axis];
        corners[write++] = value;
        minimum[axis] = Math.min(minimum[axis], value);
        maximum[axis] = Math.max(maximum[axis], value);
        partMinimum[axis] = Math.min(partMinimum[axis], value);
        partMaximum[axis] = Math.max(partMaximum[axis], value);
      }
    }
    partBounds.push({ minimum: partMinimum, maximum: partMaximum });
  }
  return { corners, triangleCount, partBounds, minimum, maximum, centre: minimum.map((value, axis) => (value + maximum[axis]) / 2) };
}

// Fractions of the scene bounds tried for a ray origin, the middle first.
const ORIGIN_FRACTIONS = [0.5, 0.25, 0.75];

function insideAnyPart(point, partBounds) {
  return partBounds.some(bounds => point.every((value, axis) => value > bounds.minimum[axis] && value < bounds.maximum[axis]));
}

/**
 * The first point of the scene bounds that lies inside no part's bounds, trying the middle, then points lifted and offset
 * within the bounds. A ray that starts inside a part (a mug, a lamp, a table) tests that part, not the room around it.
 * Null when every candidate is inside a part.
 */
function freeOrigin(triangles) {
  for (const heightFraction of ORIGIN_FRACTIONS) {
    for (const offsetFraction of ORIGIN_FRACTIONS) {
      for (const depthFraction of ORIGIN_FRACTIONS) {
        const fractions = [offsetFraction, heightFraction, depthFraction];
        const point = triangles.minimum.map((low, axis) => low + fractions[axis] * (triangles.maximum[axis] - low));
        if (!insideAnyPart(point, triangles.partBounds)) {
          return point;
        }
      }
    }
  }
  return null;
}

export function fibonacciDirection(index, count, out) {
  const height = 1 - (index + 0.5) * 2 / count;
  const ring = Math.sqrt(1 - height * height);
  const angle = index * Math.PI * (3 - Math.sqrt(5));
  out[0] = Math.cos(angle) * ring;
  out[1] = height;
  out[2] = Math.sin(angle) * ring;
  return out;
}

// Moller-Trumbore, counting only a triangle whose front face looks at the ray (det > 0).
function hitsFrontFace(corners, offset, origin, direction) {
  const edgeOneX = corners[offset + 3] - corners[offset];
  const edgeOneY = corners[offset + 4] - corners[offset + 1];
  const edgeOneZ = corners[offset + 5] - corners[offset + 2];
  const edgeTwoX = corners[offset + 6] - corners[offset];
  const edgeTwoY = corners[offset + 7] - corners[offset + 1];
  const edgeTwoZ = corners[offset + 8] - corners[offset + 2];
  const pX = direction[1] * edgeTwoZ - direction[2] * edgeTwoY;
  const pY = direction[2] * edgeTwoX - direction[0] * edgeTwoZ;
  const pZ = direction[0] * edgeTwoY - direction[1] * edgeTwoX;
  const determinant = edgeOneX * pX + edgeOneY * pY + edgeOneZ * pZ;
  if (determinant < PARALLEL_EPSILON) {
    return false;
  }
  const toOriginX = origin[0] - corners[offset];
  const toOriginY = origin[1] - corners[offset + 1];
  const toOriginZ = origin[2] - corners[offset + 2];
  const u = toOriginX * pX + toOriginY * pY + toOriginZ * pZ;
  if (u < 0 || u > determinant) {
    return false;
  }
  const qX = toOriginY * edgeOneZ - toOriginZ * edgeOneY;
  const qY = toOriginZ * edgeOneX - toOriginX * edgeOneZ;
  const qZ = toOriginX * edgeOneY - toOriginY * edgeOneX;
  const v = direction[0] * qX + direction[1] * qY + direction[2] * qZ;
  if (v < 0 || u + v > determinant) {
    return false;
  }
  return edgeTwoX * qX + edgeTwoY * qY + edgeTwoZ * qZ > 0;
}

/**
 * The share of rays from the middle of the parts' bounds (or the first nearby point outside every part) that hit a part's
 * inner face, or null when the scene is empty, has more than CLOSED_ROOM_MAXIMUM_TRIANGLES triangles or has no free origin. `worldMatrices` maps a part's name to its world matrix.
 */
export function closedRoomShare(parts, worldMatrices) {
  const triangles = worldTriangles(parts.filter(part => !['blend', 'add'].includes(part.material?.alphaMode)), worldMatrices);
  if (!triangles) {
    return null;
  }
  const origin = freeOrigin(triangles);
  if (!origin) {
    return null;
  }
  const direction = [0, 0, 0];
  let hits = 0;
  for (let ray = 0; ray < CLOSED_ROOM_RAYS; ray++) {
    fibonacciDirection(ray, CLOSED_ROOM_RAYS, direction);
    for (let triangle = 0; triangle < triangles.triangleCount; triangle++) {
      if (hitsFrontFace(triangles.corners, triangle * 9, origin, direction)) {
        hits++;
        break;
      }
    }
  }
  return hits / CLOSED_ROOM_RAYS;
}

export const SKY_OPENNESS_RAYS = 32;

/**
 * The share of upward rays from `point` that leave the parts without hitting a part's underside, or null when the scene is
 * empty or too large to test. 1 is open ground under the sky, 0 is a closed room. Pass it to `CrucibleRenderer` as the
 * `skyOpenness` option and an unset `volumeFog.shadowAmbient` follows it. The rays are the upper half of the same fixed
 * spiral, so the same scene gives the same share.
 */
export function skyOpenness(parts, point) {
  const worldMatrices = new Map(parts.map(part => [part.name, part.matrix]));
  const triangles = worldTriangles(parts.filter(part => !['blend', 'add'].includes(part.material?.alphaMode)), worldMatrices);
  if (!triangles) {
    return null;
  }
  const direction = [0, 0, 0];
  let escaped = 0;
  for (let ray = 0; ray < SKY_OPENNESS_RAYS; ray++) {
    fibonacciDirection(ray, SKY_OPENNESS_RAYS * 2, direction);
    let blocked = false;
    for (let triangle = 0; triangle < triangles.triangleCount && !blocked; triangle++) {
      blocked = hitsFrontFace(triangles.corners, triangle * 9, point, direction);
    }
    if (!blocked) {
      escaped++;
    }
  }
  return escaped / SKY_OPENNESS_RAYS;
}

export const SKY_GRID_POINTS = 2048;
export const SKY_GRID_LONGEST_AXIS = 32;
export const SKY_GRID_RAYS = 24;

/** Cells per axis: roughly cubic cells, at most SKY_GRID_POINTS in total and SKY_GRID_LONGEST_AXIS along any axis. */
export function skyGridSize(minimum, maximum) {
  const extent = maximum.map((high, axis) => high - minimum[axis]);
  const spacing = Math.max(Math.cbrt(extent[0] * extent[1] * extent[2] / SKY_GRID_POINTS), Math.max(...extent) / SKY_GRID_LONGEST_AXIS);
  return extent.map(length => Math.min(SKY_GRID_LONGEST_AXIS, Math.max(2, Math.ceil(length / spacing))));
}

/**
 * Sky visibility at the centres of a grid of cells over the box `minimum`..`maximum`, as bytes (255 = every upward ray
 * escapes), x fastest then y then z. Null when the scene is empty or too large to test. A fixed spiral of rays and fixed cell
 * centres, so the same scene gives the same bytes. `createSkyVisibility` (fog-sky-visibility.js) uploads it as a texture.
 */
export function skyVisibilityGrid(parts, minimum, maximum) {
  const worldMatrices = new Map(parts.map(part => [part.name, part.matrix]));
  const triangles = worldTriangles(parts.filter(part => !['blend', 'add'].includes(part.material?.alphaMode)), worldMatrices);
  if (!triangles) {
    return null;
  }
  const size = skyGridSize(minimum, maximum);
  const directions = Array.from({ length: SKY_GRID_RAYS }, (unused, ray) => fibonacciDirection(ray, SKY_GRID_RAYS * 2, [0, 0, 0]));
  const data = new Uint8Array(size[0] * size[1] * size[2]);
  const point = [0, 0, 0];
  let write = 0;
  for (let z = 0; z < size[2]; z++) {
    for (let y = 0; y < size[1]; y++) {
      for (let x = 0; x < size[0]; x++) {
        const cell = [x, y, z];
        for (let axis = 0; axis < 3; axis++) {
          point[axis] = minimum[axis] + (cell[axis] + 0.5) / size[axis] * (maximum[axis] - minimum[axis]);
        }
        let escaped = 0;
        for (const direction of directions) {
          let blocked = false;
          for (let triangle = 0; triangle < triangles.triangleCount && !blocked; triangle++) {
            blocked = hitsFrontFace(triangles.corners, triangle * 9, point, direction);
          }
          if (!blocked) {
            escaped++;
          }
        }
        data[write++] = Math.round(255 * escaped / SKY_GRID_RAYS);
      }
    }
  }
  return { size, data };
}
