import { createMeshData } from './mesh-data.js';
import { registerModifierRunner } from './mesh-modifiers.js';

// Two whole-mesh modifiers that replace the mesh with a simple solid around it: bounding_box is the axis-aligned box
// (6 quads) and convex_hull is the smallest convex solid (triangles). Tags and attributes are dropped.

export const MAX_HULL_VERTICES = 8192;
const HULL_EPSILON_SCALE = 1e-9;

// Corner k of the box is (k & 1, k >> 1 & 1, k >> 2 & 1), 0 for the minimum and 1 for the maximum of that axis.
// Every face lists its corners counter-clockwise seen from outside.
const BOX_FACES = Object.freeze([[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]]);

/** The axis-aligned box around all vertices: 8 vertices, 6 quads. */
export function boundingBoxMesh(mesh) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    for (let axis = 0; axis < 3; axis++) {
      const value = mesh.positions[vertex * 3 + axis];
      if (value < low[axis]) low[axis] = value;
      if (value > high[axis]) high[axis] = value;
    }
  }
  const positions = new Float32Array(24);
  for (let corner = 0; corner < 8; corner++) {
    for (let axis = 0; axis < 3; axis++) positions[corner * 3 + axis] = (corner >> axis) & 1 ? high[axis] : low[axis];
  }
  const faceOffsets = Uint32Array.from({ length: 7 }, (unused, face) => face * 4);
  return createMeshData({ positions, faceOffsets, cornerVertices: Uint32Array.from(BOX_FACES.flat()) });
}

function pointAt(positions, vertex) {
  return [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]];
}

function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function cross(first, second) {
  return [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
}

function dot(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

// A hull face keeps its outward plane, so "which side of it is this point" is one dot product.
function createFace(positions, first, second, third) {
  const origin = pointAt(positions, first);
  const raw = cross(subtract(pointAt(positions, second), origin), subtract(pointAt(positions, third), origin));
  const length = Math.hypot(raw[0], raw[1], raw[2]) || 1;
  const normal = [raw[0] / length, raw[1] / length, raw[2] / length];
  return { corners: [first, second, third], normal, offset: dot(normal, origin), alive: true };
}

function distanceAbove(face, point) {
  return dot(face.normal, point) - face.offset;
}

function findStartingTetrahedron(positions, count, epsilon) {
  const extreme = [0, 0];
  for (let vertex = 1; vertex < count; vertex++) {
    if (positions[vertex * 3] < positions[extreme[0] * 3]) extreme[0] = vertex;
    if (positions[vertex * 3] > positions[extreme[1] * 3]) extreme[1] = vertex;
  }
  const first = extreme[0];
  let second = extreme[1];
  if (first === second || Math.hypot(...subtract(pointAt(positions, first), pointAt(positions, second))) <= epsilon) {
    second = Array.from({ length: count }, (unused, vertex) => vertex)
      .reduce((best, vertex) => (Math.hypot(...subtract(pointAt(positions, vertex), pointAt(positions, first))) > Math.hypot(...subtract(pointAt(positions, best), pointAt(positions, first))) ? vertex : best), first);
  }
  const line = subtract(pointAt(positions, second), pointAt(positions, first));
  let third = -1;
  let bestArea = epsilon;
  for (let vertex = 0; vertex < count; vertex++) {
    const area = Math.hypot(...cross(line, subtract(pointAt(positions, vertex), pointAt(positions, first))));
    if (area > bestArea) {
      bestArea = area;
      third = vertex;
    }
  }
  if (third < 0) throw new RangeError('convex_hull needs vertices that do not all lie on one line.');
  const normal = cross(line, subtract(pointAt(positions, third), pointAt(positions, first)));
  let fourth = -1;
  let bestHeight = epsilon * Math.hypot(...normal);
  for (let vertex = 0; vertex < count; vertex++) {
    const height = Math.abs(dot(normal, subtract(pointAt(positions, vertex), pointAt(positions, first))));
    if (height > bestHeight) {
      bestHeight = height;
      fourth = vertex;
    }
  }
  if (fourth < 0) throw new RangeError('convex_hull needs vertices that do not all lie in one plane.');
  return [first, second, third, fourth];
}

/** Incremental convex hull of all vertices as a triangle mesh with outward faces; unused vertices are dropped. */
export function convexHullMesh(mesh) {
  if (mesh.vertexCount > MAX_HULL_VERTICES) {
    throw new RangeError(`convex_hull takes at most ${MAX_HULL_VERTICES} vertices and the mesh has ${mesh.vertexCount}. Decimate or weld first.`);
  }
  const { positions } = mesh;
  const count = mesh.vertexCount;
  const bounds = boundingBoxMesh(mesh).positions;
  const epsilon = Math.hypot(bounds[21] - bounds[0], bounds[22] - bounds[1], bounds[23] - bounds[2]) * HULL_EPSILON_SCALE;
  const [first, second, third, fourth] = findStartingTetrahedron(positions, count, epsilon);
  const inside = [0, 1, 2].map(axis => (positions[first * 3 + axis] + positions[second * 3 + axis] + positions[third * 3 + axis] + positions[fourth * 3 + axis]) / 4);
  const faces = [];
  for (const [a, b, c] of [[first, second, third], [first, second, fourth], [first, third, fourth], [second, third, fourth]]) {
    const face = createFace(positions, a, b, c);
    if (distanceAbove(face, inside) > 0) {
      face.corners = [a, c, b];
      face.normal = face.normal.map(component => -component);
      face.offset = -face.offset;
    }
    faces.push(face);
  }
  const used = new Set([first, second, third, fourth]);
  for (let vertex = 0; vertex < count; vertex++) {
    if (used.has(vertex)) continue;
    const point = pointAt(positions, vertex);
    const visible = faces.filter(face => face.alive && distanceAbove(face, point) > epsilon);
    if (visible.length === 0) continue;
    const horizon = new Map();
    for (const face of visible) {
      face.alive = false;
      for (let side = 0; side < 3; side++) horizon.set(`${face.corners[side]}:${face.corners[(side + 1) % 3]}`, [face.corners[side], face.corners[(side + 1) % 3]]);
    }
    for (const [start, end] of horizon.values()) {
      if (horizon.has(`${end}:${start}`)) continue;
      faces.push(createFace(positions, start, end, vertex));
    }
  }
  const alive = faces.filter(face => face.alive);
  const remap = new Map();
  const hullPositions = [];
  const cornerVertices = [];
  for (const face of alive) {
    for (const vertex of face.corners) {
      if (!remap.has(vertex)) {
        remap.set(vertex, remap.size);
        hullPositions.push(...pointAt(positions, vertex));
      }
      cornerVertices.push(remap.get(vertex));
    }
  }
  const faceOffsets = Uint32Array.from({ length: alive.length + 1 }, (unused, face) => face * 3);
  return createMeshData({ positions: Float32Array.from(hullPositions), faceOffsets, cornerVertices: Uint32Array.from(cornerVertices) });
}

export const HULL_RUNNERS = Object.freeze({
  bounding_box: mesh => ({ mesh: boundingBoxMesh(mesh), result: {} }),
  convex_hull: mesh => {
    const hull = convexHullMesh(mesh);
    return { mesh: hull, result: { hullVertices: hull.vertexCount } };
  },
});

for (const [operation, runner] of Object.entries(HULL_RUNNERS)) registerModifierRunner(operation, runner);
