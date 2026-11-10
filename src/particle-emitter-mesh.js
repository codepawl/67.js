// A mesh as a particle emitter: points on its surface (weighted by triangle area), at its vertices, or inside its volume.
// Every sample draws from the particle's own generator, so the same seed gives the same points.

export const EMITTER_MESH_MODES = Object.freeze(['surface', 'vertices', 'volume']);

const MAX_VOLUME_TRIES = 200;
// A direction no mesh edge is likely to lie along, so the inside test does not graze an edge.
const PROBE_DIRECTION = Object.freeze([0.5773, 0.5791, 0.5759]);
const EPSILON = 1e-12;

function corner(positions, vertex) {
  return [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]];
}

function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function crossProduct(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function dotProduct(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function trianglesOf(positions, indices) {
  const triangles = [];
  for (let offset = 0; offset + 2 < indices.length; offset += 3) {
    const a = corner(positions, indices[offset]);
    const b = corner(positions, indices[offset + 1]);
    const c = corner(positions, indices[offset + 2]);
    const faceVector = crossProduct(subtract(b, a), subtract(c, a));
    const doubleArea = Math.hypot(faceVector[0], faceVector[1], faceVector[2]);
    triangles.push({ a, b, c, doubleArea, normal: doubleArea > 0 ? faceVector.map(component => component / doubleArea) : [0, 1, 0] });
  }
  return triangles;
}

function surfaceSampler(triangles) {
  const cumulative = [];
  let total = 0;
  for (const triangle of triangles) {
    total += triangle.doubleArea;
    cumulative.push(total);
  }
  if (!(total > 0)) return null;
  return random => {
    const target = random() * total;
    let low = 0;
    let high = cumulative.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (cumulative[middle] < target) low = middle + 1;
      else high = middle;
    }
    const triangle = triangles[low];
    const root = Math.sqrt(random());
    const along = random();
    const weightB = root * (1 - along);
    const weightC = root * along;
    const weightA = 1 - root;
    const point = [0, 1, 2].map(axis => triangle.a[axis] * weightA + triangle.b[axis] * weightB + triangle.c[axis] * weightC);
    return { point, normal: triangle.normal };
  };
}

// Möller-Trumbore: does the ray from `origin` along PROBE_DIRECTION cross this triangle?
function rayCrosses(origin, triangle) {
  const edgeB = subtract(triangle.b, triangle.a);
  const edgeC = subtract(triangle.c, triangle.a);
  const pivot = crossProduct(PROBE_DIRECTION, edgeC);
  const determinant = dotProduct(edgeB, pivot);
  if (Math.abs(determinant) < EPSILON) return false;
  const toOrigin = subtract(origin, triangle.a);
  const u = dotProduct(toOrigin, pivot) / determinant;
  if (u < 0 || u > 1) return false;
  const turn = crossProduct(toOrigin, edgeB);
  const v = dotProduct(PROBE_DIRECTION, turn) / determinant;
  if (v < 0 || u + v > 1) return false;
  return dotProduct(edgeC, turn) / determinant > 0;
}

/** True when `point` lies inside the closed mesh: a ray from it crosses the surface an odd number of times. */
export function isInsideMesh(triangles, point) {
  let crossings = 0;
  for (const triangle of triangles) {
    if (rayCrosses(point, triangle)) crossings++;
  }
  return crossings % 2 === 1;
}

function volumeSampler(triangles, positions) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], positions[offset + axis]);
      maximum[axis] = Math.max(maximum[axis], positions[offset + axis]);
    }
  }
  return random => {
    for (let attempt = 0; attempt < MAX_VOLUME_TRIES; attempt++) {
      const point = [0, 1, 2].map(axis => minimum[axis] + (maximum[axis] - minimum[axis]) * random());
      if (isInsideMesh(triangles, point)) return { point, normal: null };
    }
    return null;
  };
}

function vertexSampler(positions, normals) {
  const vertexCount = positions.length / 3;
  return random => {
    const vertex = Math.min(Math.floor(random() * vertexCount), vertexCount - 1);
    return { point: corner(positions, vertex), normal: corner(normals, vertex) };
  };
}

/**
 * Build a sampler over a mesh already in world space. `sample(random)` returns `{ point, normal }`; the normal is null
 * for a volume. Returns null when the mesh cannot supply the mode (no area, or no triangles).
 */
export function createMeshSource(positions, normals, indices, mode) {
  const triangles = trianglesOf(positions, indices);
  if (!triangles.length) return null;
  let sampler = null;
  if (mode === 'vertices') sampler = vertexSampler(positions, normals);
  else if (mode === 'volume') sampler = volumeSampler(triangles, positions);
  else sampler = surfaceSampler(triangles);
  if (!sampler) return null;
  return Object.freeze({
    mode,
    triangleCount: triangles.length,
    sample(random) {
      const result = sampler(random);
      if (!result) {
        throw new Error('The particle emitter mesh has no inside to fill: pass a closed mesh (every edge shared by two faces) for emitter.from "volume", or use "surface".');
      }
      return result;
    },
  });
}
