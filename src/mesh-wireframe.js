import { meshBounds } from './mesh-data.js';
import { faceNormals } from './mesh-normals.js';
import { edgeCornerTable } from './mesh-topology.js';

// The polygon edges of a mesh, each tagged with what it shows, for the wireframe render pass. Edges are the edges of
// the polygons, so the diagonals that triangulation adds inside a quad or n-gon never appear.

/** The edge kinds, in the order of the numbers written into the segment buffer. */
export const WIREFRAME_KINDS = Object.freeze(['regular', 'boundary', 'nonManifold', 'flipped', 'degenerate']);
/** Floats per segment: two local-space endpoints and the kind number. */
export const WIREFRAME_SEGMENT_STRIDE = 7;
/** The most segments one mesh contributes; fault edges are kept first and regular edges fill what is left. */
export const MAXIMUM_WIREFRAME_SEGMENTS = 200_000;

const REGULAR = 0;
const BOUNDARY = 1;
const NON_MANIFOLD = 2;
const FLIPPED = 3;
const DEGENERATE = 4;
// An edge that is several faults shows the one that matters most for a repair.
const KIND_PRIORITY = Object.freeze([0, 1, 4, 2, 3]);

function edgeKinds(mesh, table) {
  const kinds = new Uint8Array(mesh.edgeCount);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const start = table.edgeOffsets[edge];
    const faceCount = table.edgeOffsets[edge + 1] - start;
    if (faceCount === 1) {
      kinds[edge] = BOUNDARY;
    } else if (faceCount > 2) {
      kinds[edge] = NON_MANIFOLD;
    } else if (mesh.cornerVertices[table.edgeCorners[start]] === mesh.cornerVertices[table.edgeCorners[start + 1]]) {
      // Two faces that run the same way along a shared edge: one of them is flipped.
      kinds[edge] = FLIPPED;
    }
  }
  return kinds;
}

function markDegenerateFaces(mesh, kinds) {
  const bounds = meshBounds(mesh);
  const diagonal = Math.hypot(...bounds.max.map((value, axis) => value - bounds.min[axis]));
  const minimumArea = (diagonal * 1e-7) ** 2;
  const { areas } = faceNormals(mesh);
  for (let face = 0; face < mesh.faceCount; face++) {
    if (areas[face] > minimumArea) continue;
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
      const edge = mesh.cornerEdges[corner];
      if (KIND_PRIORITY[DEGENERATE] > KIND_PRIORITY[kinds[edge]]) kinds[edge] = DEGENERATE;
    }
  }
}

/**
 * Segments of every polygon edge of `mesh`: `segments` holds WIREFRAME_SEGMENT_STRIDE floats each (ax, ay, az, bx, by, bz, kind),
 * `counts` how many edges of each kind the mesh has, and `truncated` is true when regular edges were dropped to stay within
 * `maximumSegments`. Faults are never dropped before regular edges.
 */
export function meshWireframe(mesh, { maximumSegments = MAXIMUM_WIREFRAME_SEGMENTS } = {}) {
  if (!Number.isInteger(maximumSegments) || maximumSegments < 1) throw new RangeError('maximumSegments must be a positive integer.');
  const table = edgeCornerTable(mesh);
  const kinds = edgeKinds(mesh, table);
  markDegenerateFaces(mesh, kinds);
  const counts = Object.fromEntries(WIREFRAME_KINDS.map(name => [name, 0]));
  for (const kind of kinds) counts[WIREFRAME_KINDS[kind]]++;
  const faultCount = mesh.edgeCount - counts.regular;
  const written = Math.min(mesh.edgeCount, maximumSegments);
  const segments = new Float32Array(written * WIREFRAME_SEGMENT_STRIDE);
  let cursor = 0;
  for (const wantFaults of [true, false]) {
    for (let edge = 0; edge < mesh.edgeCount && cursor < written; edge++) {
      if ((kinds[edge] !== REGULAR) !== wantFaults) continue;
      const base = cursor * WIREFRAME_SEGMENT_STRIDE;
      segments.set(mesh.positions.subarray(mesh.edgeVertices[edge * 2] * 3, mesh.edgeVertices[edge * 2] * 3 + 3), base);
      segments.set(mesh.positions.subarray(mesh.edgeVertices[edge * 2 + 1] * 3, mesh.edgeVertices[edge * 2 + 1] * 3 + 3), base + 3);
      segments[base + 6] = kinds[edge];
      cursor++;
    }
  }
  return { segments, count: cursor, counts, truncated: cursor < mesh.edgeCount, droppedFaults: Math.max(0, faultCount - cursor) };
}
