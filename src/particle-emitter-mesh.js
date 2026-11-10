// A mesh as a particle emitter: points on its surface (weighted by triangle area), at its vertices, along its edges (weighted by length), or inside its volume.
// A vertex group (one weight per vertex) narrows the surface, vertex and edge modes to where the group is painted; edges can also be limited to the sharp ones.
// Every sample draws from the particle's own generator, so the same seed gives the same points.

export const EMITTER_MESH_MODES = Object.freeze(['surface', 'vertices', 'edges', 'volume']);

const MAX_VOLUME_TRIES = 200;
// A direction no mesh edge is likely to lie along, so the inside test does not graze an edge.
const PROBE_DIRECTION = Object.freeze([0.5773, 0.5791, 0.5759]);
const EPSILON = 1e-12;
// Two corners closer than this on every axis are the same point when edges are matched.
const WELD_STEP = 1e-5;

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

function trianglesOf(positions, indices, weights) {
  const triangles = [];
  for (let offset = 0; offset + 2 < indices.length; offset += 3) {
    const a = corner(positions, indices[offset]);
    const b = corner(positions, indices[offset + 1]);
    const c = corner(positions, indices[offset + 2]);
    const faceVector = crossProduct(subtract(b, a), subtract(c, a));
    const doubleArea = Math.hypot(faceVector[0], faceVector[1], faceVector[2]);
    const groupWeight = weights ? (weights[indices[offset]] + weights[indices[offset + 1]] + weights[indices[offset + 2]]) / 3 : 1;
    triangles.push({ a, b, c, doubleArea, emitWeight: doubleArea * groupWeight, normal: doubleArea > 0 ? faceVector.map(component => component / doubleArea) : [0, 1, 0] });
  }
  return triangles;
}

function surfaceSampler(triangles) {
  const cumulative = [];
  let total = 0;
  for (const triangle of triangles) {
    total += triangle.emitWeight;
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

function vertexSampler(positions, normals, weights) {
  const vertexCount = positions.length / 3;
  const cumulative = [];
  let total = 0;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    total += weights ? weights[vertex] : 1;
    cumulative.push(total);
  }
  if (!(total > 0)) return null;
  return random => {
    const target = random() * total;
    let low = 0;
    let high = vertexCount - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (cumulative[middle] <= target) low = middle + 1;
      else high = middle;
    }
    return { point: corner(positions, low), normal: corner(normals, low) };
  };
}

function normalized(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length > 0 ? vector.map(component => component / length) : null;
}

// Render meshes repeat a corner for every face that uses it, so an edge is found by the position of its two ends.
function weldKey(point) {
  return point.map(component => Math.round(component / WELD_STEP)).join(',');
}

/**
 * Every distinct edge of the triangles, as `{ start, end, length, faceNormals, weight }`. `weight` is the lighter of the
 * two end weights of the vertex group (an edge belongs to the group only when both ends are painted), or 1 without a group.
 */
function edgesOf(positions, indices, weights) {
  const edges = new Map();
  const cornerWeight = new Map();
  for (let offset = 0; offset + 2 < indices.length; offset += 3) {
    const corners = [0, 1, 2].map(index => corner(positions, indices[offset + index]));
    const keys = corners.map(weldKey);
    const faceNormal = normalized(crossProduct(subtract(corners[1], corners[0]), subtract(corners[2], corners[0])));
    for (let index = 0; index < 3; index++) {
      if (weights) cornerWeight.set(keys[index], Math.max(cornerWeight.get(keys[index]) ?? 0, weights[indices[offset + index]]));
      const next = (index + 1) % 3;
      if (keys[index] === keys[next]) continue;
      const edgeKey = keys[index] < keys[next] ? `${keys[index]}|${keys[next]}` : `${keys[next]}|${keys[index]}`;
      let edge = edges.get(edgeKey);
      if (!edge) {
        const [start, end] = keys[index] < keys[next] ? [index, next] : [next, index];
        edge = { start: corners[start], end: corners[end], startKey: keys[start], endKey: keys[end], faceNormals: [] };
        edge.length = Math.hypot(...subtract(edge.end, edge.start));
        edges.set(edgeKey, edge);
      }
      if (faceNormal) edge.faceNormals.push(faceNormal);
    }
  }
  for (const edge of edges.values()) {
    edge.weight = weights ? Math.min(cornerWeight.get(edge.startKey), cornerWeight.get(edge.endKey)) : 1;
  }
  return [...edges.values()];
}

// An edge is sharp when it has one face or more than two (an open or joined border), or its two faces meet at more than `sharpAngle` degrees.
function isSharpEdge(edge, sharpAngle) {
  if (edge.faceNormals.length !== 2) return true;
  const cosine = Math.max(-1, Math.min(1, dotProduct(edge.faceNormals[0], edge.faceNormals[1])));
  return Math.acos(cosine) * 180 / Math.PI > sharpAngle;
}

function edgeSampler(positions, indices, weights, sharpAngle) {
  let edges = edgesOf(positions, indices, weights);
  if (sharpAngle !== null) edges = edges.filter(edge => isSharpEdge(edge, sharpAngle));
  const cumulative = [];
  let total = 0;
  for (const edge of edges) {
    total += edge.length * edge.weight;
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
    const edge = edges[low];
    const along = random();
    const point = [0, 1, 2].map(axis => edge.start[axis] + (edge.end[axis] - edge.start[axis]) * along);
    const summed = edge.faceNormals.reduce((sum, normal) => sum.map((component, axis) => component + normal[axis]), [0, 0, 0]);
    return { point, normal: normalized(summed) ?? edge.faceNormals[0] ?? [0, 1, 0] };
  };
}

/**
 * Build a sampler over a mesh already in world space. `sample(random)` returns `{ point, normal }`; the normal is null
 * for a volume. `weights` is an optional vertex group (one weight per vertex) for the surface, vertices and edges modes.
 * `sharpAngle` (degrees, edges mode only) keeps the edges that are open or bend more than that. Returns null when the
 * mesh cannot supply the mode (no area, no triangles, no edge left, or a group that weighs nothing).
 */
export function createMeshSource(positions, normals, indices, mode, weights = null, sharpAngle = null) {
  const triangles = trianglesOf(positions, indices, weights);
  if (!triangles.length) return null;
  let sampler = null;
  if (mode === 'vertices') sampler = vertexSampler(positions, normals, weights);
  else if (mode === 'edges') sampler = edgeSampler(positions, indices, weights, sharpAngle);
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
