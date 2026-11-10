import { faceCentroids, faceNormals, vertexNormals } from './mesh-normals.js';
import { edgeCornerTable, cornerFaces } from './mesh-topology.js';
import { seededRandom } from './mesh-fields.js';
import { createMeshQueryIndex } from './mesh-query.js';
import { triangulatedSurface } from './mesh-surface-distance.js';
import { meshBounds } from './mesh-data.js';

// Geometry masks: one weight from 0 to 1 for each vertex, measured from the mesh itself, so a material can tell an
// edge from a cavity on a mesh that has no UVs. They are written into a vertex group (the vertex_group edit with a
// `measure`), and a vertex_color gradient reads that group. Every measure is deterministic: the same mesh and the same
// seed give the same bytes.
//
//   curvature  0.5 on a flat surface, up to 1 on a convex bulge and down to 0 in a concave dent.
//   edge       1 on a convex edge sharper than `angle`, 0 away from edges (concave edges give 0).
//   occlusion  the share of `rays` cosine-weighted rays that hit the mesh within `distance`; 1 deep in a cavity, 0 in the open.

export const MASK_MEASURES = Object.freeze(['curvature', 'edge', 'occlusion']);
export const MASK_LIMITS = Object.freeze({
  gain: Object.freeze([0.1, 16]),
  angle: Object.freeze([1, 179]),
  rays: Object.freeze([1, 128]),
  seed: Object.freeze([0, 2147483647]),
  maxRayCasts: 2_000_000,
  maxTriangleTests: 20_000_000,
});
export const MASK_DEFAULTS = Object.freeze({ gain: 2, angle: 30, rays: 32, seed: 0 });

const RAY_START_OFFSET = 1e-4;
const GOLDEN_RATIO_CONJUGATE = 0.6180339887498949;
const DEFAULT_DISTANCE_SHARE = 0.25;

function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

/** Signed curvature from the edges around each vertex: how far the neighbours fall below the tangent plane. */
function measureCurvature(mesh, gain) {
  const normals = vertexNormals(mesh);
  const normalSums = new Float64Array(mesh.vertexCount);
  const lengthSums = new Float64Array(mesh.vertexCount);
  const positions = mesh.positions;
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const first = mesh.edgeVertices[edge * 2];
    const second = mesh.edgeVertices[edge * 2 + 1];
    const deltaX = positions[second * 3] - positions[first * 3];
    const deltaY = positions[second * 3 + 1] - positions[first * 3 + 1];
    const deltaZ = positions[second * 3 + 2] - positions[first * 3 + 2];
    const length = Math.hypot(deltaX, deltaY, deltaZ);
    if (length === 0) continue;
    normalSums[first] += deltaX * normals[first * 3] + deltaY * normals[first * 3 + 1] + deltaZ * normals[first * 3 + 2];
    normalSums[second] -= deltaX * normals[second * 3] + deltaY * normals[second * 3 + 1] + deltaZ * normals[second * 3 + 2];
    lengthSums[first] += length;
    lengthSums[second] += length;
  }
  const weights = new Float32Array(mesh.vertexCount);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const convexity = lengthSums[vertex] > 0 ? -normalSums[vertex] / lengthSums[vertex] : 0;
    weights[vertex] = clampUnit(0.5 + gain * convexity);
  }
  return weights;
}

/** The sharpest convex fold among the edges of each vertex, as a share of `angleDegrees`. */
function measureEdge(mesh, angleDegrees) {
  const { normals } = faceNormals(mesh);
  const centroids = faceCentroids(mesh);
  const facesOfCorners = cornerFaces(mesh);
  const { edgeOffsets, edgeCorners } = edgeCornerTable(mesh);
  const limit = (angleDegrees * Math.PI) / 180;
  const weights = new Float32Array(mesh.vertexCount);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    if (edgeOffsets[edge + 1] - edgeOffsets[edge] !== 2) continue;
    const faceA = facesOfCorners[edgeCorners[edgeOffsets[edge]]];
    const faceB = facesOfCorners[edgeCorners[edgeOffsets[edge] + 1]];
    const alongA = normals[faceA * 3] * (centroids[faceB * 3] - centroids[faceA * 3])
      + normals[faceA * 3 + 1] * (centroids[faceB * 3 + 1] - centroids[faceA * 3 + 1])
      + normals[faceA * 3 + 2] * (centroids[faceB * 3 + 2] - centroids[faceA * 3 + 2]);
    if (alongA >= 0) continue;
    const cosine = normals[faceA * 3] * normals[faceB * 3] + normals[faceA * 3 + 1] * normals[faceB * 3 + 1] + normals[faceA * 3 + 2] * normals[faceB * 3 + 2];
    const share = clampUnit(Math.acos(Math.max(-1, Math.min(1, cosine))) / limit);
    for (const vertex of [mesh.edgeVertices[edge * 2], mesh.edgeVertices[edge * 2 + 1]]) {
      weights[vertex] = Math.max(weights[vertex], share);
    }
  }
  return weights;
}

// A cosine-weighted direction in the hemisphere around a unit normal, from two numbers in 0 to 1.
function hemisphereDirection(normalX, normalY, normalZ, firstRandom, secondRandom) {
  const useY = Math.abs(normalX) > 0.9;
  let tangentX = useY ? 0 : 1;
  let tangentY = useY ? 1 : 0;
  const tangentDot = tangentX * normalX + tangentY * normalY;
  tangentX -= tangentDot * normalX;
  tangentY -= tangentDot * normalY;
  const tangentZ = -tangentDot * normalZ;
  const tangentLength = Math.hypot(tangentX, tangentY, tangentZ);
  tangentX /= tangentLength;
  tangentY /= tangentLength;
  const unitTangentZ = tangentZ / tangentLength;
  const bitangentX = normalY * unitTangentZ - normalZ * tangentY;
  const bitangentY = normalZ * tangentX - normalX * unitTangentZ;
  const bitangentZ = normalX * tangentY - normalY * tangentX;
  const radius = Math.sqrt(firstRandom);
  const angle = 2 * Math.PI * secondRandom;
  const sideways = radius * Math.cos(angle);
  const forwards = radius * Math.sin(angle);
  const upwards = Math.sqrt(Math.max(0, 1 - firstRandom));
  return [
    tangentX * sideways + bitangentX * forwards + normalX * upwards,
    tangentY * sideways + bitangentY * forwards + normalY * upwards,
    unitTangentZ * sideways + bitangentZ * forwards + normalZ * upwards,
  ];
}

/** The share of rays from each selected vertex that hit the mesh within `distance`. Other vertices stay 0. */
function measureOcclusion(mesh, selectedFlags, { rays, distance, seed }) {
  const normals = vertexNormals(mesh);
  const bounds = meshBounds(mesh);
  const extent = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  const reach = distance ?? extent * DEFAULT_DISTANCE_SHARE;
  const surface = triangulatedSurface(mesh);
  const index = createMeshQueryIndex({ positions: new Float32Array(surface.positions), indices: surface.indices });
  const weights = new Float32Array(mesh.vertexCount);
  let triangleTests = 0;
  try {
    for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
      if (!selectedFlags[vertex]) continue;
      const normalX = normals[vertex * 3];
      const normalY = normals[vertex * 3 + 1];
      const normalZ = normals[vertex * 3 + 2];
      if (normalX === 0 && normalY === 0 && normalZ === 0) continue;
      const origin = [
        mesh.positions[vertex * 3] + normalX * extent * RAY_START_OFFSET,
        mesh.positions[vertex * 3 + 1] + normalY * extent * RAY_START_OFFSET,
        mesh.positions[vertex * 3 + 2] + normalZ * extent * RAY_START_OFFSET,
      ];
      // Stratified rays: the ring of each ray is its own slice of the cosine distribution and the turn follows the golden
      // ratio, rotated by one random angle per vertex. Plain random rays differ from one vertex to the next by their own
      // noise, and that noise showed as wrinkles in the mask.
      const turnOffset = seededRandom(vertex, 0, seed);
      let blocked = 0;
      for (let ray = 0; ray < rays; ray++) {
        const ringShare = (ray + 0.5) / rays;
        const turnShare = (turnOffset + ray * GOLDEN_RATIO_CONJUGATE) % 1;
        const direction = hemisphereDirection(normalX, normalY, normalZ, ringShare, turnShare);
        const found = index.project({ origin, direction, maxDistance: reach, maxTriangleTests: MASK_LIMITS.maxTriangleTests - triangleTests });
        triangleTests += found.triangleTests;
        if (found.hit) blocked++;
      }
      weights[vertex] = blocked / rays;
    }
  } finally {
    index.dispose();
  }
  return weights;
}

/** Cost check for an occlusion measure, before any ray is cast. Throws a RangeError that says what to pass. */
export function checkOcclusionWork(selectedVertexCount, rays) {
  if (selectedVertexCount * rays > MASK_LIMITS.maxRayCasts) {
    throw new RangeError(`Occlusion would cast ${selectedVertexCount * rays} rays; the limit is ${MASK_LIMITS.maxRayCasts}. Pass fewer rays, or a select that holds fewer vertices.`);
  }
}

/**
 * One weight in 0 to 1 for every vertex of the mesh. `settings` holds the numbers the edit validated: gain (curvature),
 * angle in degrees (edge), rays, distance in metres (default a quarter of the bounding box diagonal) and seed (occlusion).
 * Occlusion measures only the vertices flagged in `selectedFlags`.
 */
export function measureVertexMask(mesh, measure, settings, selectedFlags) {
  if (measure === 'curvature') return measureCurvature(mesh, settings.gain ?? MASK_DEFAULTS.gain);
  if (measure === 'edge') return measureEdge(mesh, settings.angle ?? MASK_DEFAULTS.angle);
  if (measure === 'occlusion') {
    return measureOcclusion(mesh, selectedFlags, { rays: settings.rays ?? MASK_DEFAULTS.rays, distance: settings.distance, seed: settings.seed ?? MASK_DEFAULTS.seed });
  }
  throw new RangeError(`Unknown measure ${measure}. Use one of ${MASK_MEASURES.join(', ')}.`);
}
