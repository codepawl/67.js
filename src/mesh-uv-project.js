import { createMeshData, DOMAINS } from './mesh-data.js';
import { faceNormals } from './mesh-normals.js';
import { cornerCycles, edgeCornerTable, UnionFind } from './mesh-topology.js';
import { bounds2d, packIslands } from './mesh-uv.js';

// Projected UVs: cube, cylinder and sphere mapping, and packing of the islands that already exist in the corner
// attribute `uv`. Both are deterministic and keep one texel density across all islands.

export const UV_PROJECTION_MODES = Object.freeze(['cube', 'cylinder', 'sphere']);
const AXIS_INDEX = Object.freeze({ x: 0, y: 1, z: 2 });
const TWO_PI = Math.PI * 2;
const SAME_UV = 1e-6;
// A cylinder face whose normal leans more than 45 degrees along the axis is a cap and projects flat.
const CAP_THRESHOLD = Math.SQRT1_2;

function withCornerUv(mesh, uv) {
  const attributes = {};
  for (const domain of DOMAINS) attributes[domain] = { ...mesh.attributes[domain] };
  attributes.corner.uv = { data: uv, size: 2 };
  return createMeshData({
    positions: mesh.positions, faceOffsets: mesh.faceOffsets, cornerVertices: mesh.cornerVertices,
    edgeVertices: mesh.edgeVertices, cornerEdges: mesh.cornerEdges, attributes,
  });
}

function boundsCenter(mesh) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    for (let axis = 0; axis < 3; axis++) {
      const value = mesh.positions[vertex * 3 + axis];
      low[axis] = Math.min(low[axis], value);
      high[axis] = Math.max(high[axis], value);
    }
  }
  return low.map((value, axis) => (value + high[axis]) / 2);
}

function cornerPoint(mesh, corner, center) {
  const vertex = mesh.cornerVertices[corner];
  return [0, 1, 2].map(axis => mesh.positions[vertex * 3 + axis] - center[axis]);
}

/** Flat projection along the face's dominant axis, mirrored on the negative side so the picture is never reversed. */
function projectFlat(point, normalAxis, normalNegative) {
  const first = (normalAxis + 1) % 3;
  const second = (normalAxis + 2) % 3;
  return [normalNegative ? -point[first] : point[first], point[second]];
}

function dominantAxis(normals, face) {
  let best = 0;
  for (let axis = 1; axis < 3; axis++) {
    if (Math.abs(normals[face * 3 + axis]) > Math.abs(normals[face * 3 + best])) best = axis;
  }
  return best;
}

/** Longitude of each corner, shifted by whole turns to lie within half a turn of the face's first measurable corner. */
function faceLongitudes(mesh, face, axis, center) {
  const first = (axis + 1) % 3;
  const second = (axis + 2) % 3;
  const angles = [];
  for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
    const point = cornerPoint(mesh, corner, center);
    const onAxis = Math.hypot(point[first], point[second]) < 1e-9;
    angles.push(onAxis ? null : Math.atan2(point[second], point[first]));
  }
  const reference = angles.find(angle => angle !== null) ?? 0;
  return angles.map(angle => {
    if (angle === null) return reference;
    let shifted = angle;
    while (shifted - reference > Math.PI) shifted -= TWO_PI;
    while (shifted - reference < -Math.PI) shifted += TWO_PI;
    return shifted;
  });
}

function meanDistance(mesh, center, distanceOf) {
  let total = 0;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const point = [0, 1, 2].map(axis => mesh.positions[vertex * 3 + axis] - center[axis]);
    total += distanceOf(point);
  }
  const mean = mesh.vertexCount ? total / mesh.vertexCount : 0;
  return mean > 1e-9 ? mean : 1;
}

/** Corner uv in mesh units for one projection, before packing. */
function projectCorners(mesh, mode, axis) {
  const center = boundsCenter(mesh);
  const { normals } = faceNormals(mesh);
  const uv = new Float32Array(mesh.cornerCount * 2);
  const first = (axis + 1) % 3;
  const second = (axis + 2) % 3;
  const radius = mode === 'cylinder'
    ? meanDistance(mesh, center, point => Math.hypot(point[first], point[second]))
    : meanDistance(mesh, center, point => Math.hypot(point[0], point[1], point[2]));
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    const isCap = mode === 'cylinder' && Math.abs(normals[face * 3 + axis]) > CAP_THRESHOLD;
    const longitudes = mode === 'cube' || isCap ? null : faceLongitudes(mesh, face, axis, center);
    const flatAxis = mode === 'cube' ? dominantAxis(normals, face) : axis;
    for (let corner = start; corner < end; corner++) {
      const point = cornerPoint(mesh, corner, center);
      let u;
      let v;
      if (!longitudes) {
        [u, v] = projectFlat(point, flatAxis, normals[face * 3 + flatAxis] < 0);
      } else if (mode === 'cylinder') {
        u = longitudes[corner - start] * radius;
        v = point[axis];
      } else {
        u = longitudes[corner - start] * radius;
        v = Math.asin(Math.max(-1, Math.min(1, point[axis] / Math.max(Math.hypot(point[0], point[1], point[2]), 1e-12)))) * radius;
      }
      uv[corner * 2] = u;
      uv[corner * 2 + 1] = v;
    }
  }
  return uv;
}

/** Faces joined across edges where both faces agree on the uv of both ends form one island. */
function uvIslands(mesh, uv) {
  const table = edgeCornerTable(mesh);
  const { nextCorner } = cornerCycles(mesh);
  const faceOfCorner = new Uint32Array(mesh.cornerCount);
  for (let face = 0; face < mesh.faceCount; face++) {
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) faceOfCorner[corner] = face;
  }
  const same = (left, right) => Math.abs(uv[left * 2] - uv[right * 2]) <= SAME_UV && Math.abs(uv[left * 2 + 1] - uv[right * 2 + 1]) <= SAME_UV;
  const faces = new UnionFind(mesh.faceCount);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    if (table.edgeOffsets[edge + 1] - table.edgeOffsets[edge] !== 2) continue;
    const first = table.edgeCorners[table.edgeOffsets[edge]];
    const second = table.edgeCorners[table.edgeOffsets[edge] + 1];
    if (same(first, nextCorner[second]) && same(nextCorner[first], second)) faces.union(faceOfCorner[first], faceOfCorner[second]);
  }
  const islands = new Map();
  for (let face = 0; face < mesh.faceCount; face++) {
    const root = faces.find(face);
    if (!islands.has(root)) islands.set(root, []);
    islands.get(root).push(face);
  }
  return [...islands.values()];
}

/**
 * Pack the uv islands of corner attribute `uv` into the unit square with one common scale, so texel density keeps its
 * ratio between islands. margin: gap between islands and around the square. rotate: lay tall islands on their side.
 * Returns the new mesh and the island count.
 */
export function packUvIslands(mesh, { margin = 0.01, rotate = true } = {}) {
  const uv = mesh.attributes.corner.uv?.data;
  if (!uv) throw new RangeError('the mesh has no uv to pack. Put uv_unwrap, or uv_project with pack false, before uv_pack.');
  const islands = uvIslands(mesh, uv);
  const placed = islands.map(faces => {
    const corners = [];
    for (const face of faces) for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) corners.push(corner);
    const points = corners.map(corner => [uv[corner * 2], uv[corner * 2 + 1]]);
    return { corners, points, box: bounds2d(points), offset: [0, 0] };
  });
  if (!placed.length) return { mesh, islands: 0 };
  const scale = packIslands(placed, margin, rotate);
  const packed = new Float32Array(mesh.cornerCount * 2);
  for (const item of placed) {
    item.corners.forEach((corner, index) => {
      packed[corner * 2] = margin + (item.points[index][0] + item.offset[0]) * scale;
      packed[corner * 2 + 1] = margin + (item.points[index][1] + item.offset[1]) * scale;
    });
  }
  return { mesh: withCornerUv(mesh, packed), islands: placed.length };
}

/**
 * Project the mesh to uv. mode cube: each face by its dominant axis; cylinder: side faces wrap around axis (u is arc
 * length at the mean radius, v the height) and caps project flat; sphere: longitude and latitude at the mean radius.
 * pack lays the islands into the unit square; without it uv stays in mesh units.
 */
export function projectUv(mesh, { mode = 'cube', axis = 'y', pack = true, margin = 0.01, rotate = true } = {}) {
  const projected = withCornerUv(mesh, projectCorners(mesh, mode, AXIS_INDEX[axis]));
  if (!pack) return { mesh: projected, islands: uvIslands(projected, projected.attributes.corner.uv.data).length };
  return packUvIslands(projected, { margin, rotate });
}
