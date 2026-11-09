import { createMeshData } from './mesh-data.js';
import { faceNormals, cornerNormals } from './mesh-normals.js';
import { edgeCornerTable, cornerFaces } from './mesh-topology.js';
import { editBoolean } from './mesh-edit-field.js';

// Modifiers that decide how a mesh is shaded without moving it. smooth_by_angle writes the edge attributes `sharp` and
// `smooth` that corner normals read, weighted_normal writes one normal per corner that the render extraction uses as is.

export const DEFAULT_NORMAL_ANGLE = 30;
export const MAXIMUM_NORMAL_WEIGHT = 100;
const WEIGHT_REFERENCE = 50;
const ANGLE_TOLERANCE = 1e-6;

function withAttributes(mesh, { edge = {}, corner = {} }) {
  return createMeshData({
    positions: mesh.positions, faceOffsets: mesh.faceOffsets, cornerVertices: mesh.cornerVertices,
    edgeVertices: mesh.edgeVertices, cornerEdges: mesh.cornerEdges,
    attributes: {
      ...mesh.attributes,
      edge: { ...mesh.attributes.edge, ...edge },
      corner: { ...mesh.attributes.corner, ...corner },
    },
  });
}

/**
 * Blender's Smooth by Angle: an edge shared by two faces whose normals differ by more than `angle` degrees is marked
 * sharp, and every other such edge is marked smooth, which overrides the angle the geometry would otherwise use. Edges
 * already marked sharp stay sharp unless `ignoreSharp` is set. Edges on a boundary or shared by three faces are not touched.
 */
export function smoothByAngle(mesh, { angle, ignoreSharp }) {
  const normals = faceNormals(mesh).normals;
  const table = edgeCornerTable(mesh);
  const faces = cornerFaces(mesh);
  const limit = Math.cos(angle * Math.PI / 180) - ANGLE_TOLERANCE;
  const sharp = new Uint8Array(mesh.edgeCount);
  const smooth = new Uint8Array(mesh.edgeCount);
  const previousSharp = mesh.attributes.edge.sharp?.data;
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const wasSharp = Boolean(previousSharp?.[edge]);
    if (table.edgeOffsets[edge + 1] - table.edgeOffsets[edge] !== 2) {
      sharp[edge] = wasSharp ? 1 : 0;
      continue;
    }
    const first = faces[table.edgeCorners[table.edgeOffsets[edge]]] * 3;
    const second = faces[table.edgeCorners[table.edgeOffsets[edge] + 1]] * 3;
    const alignment = normals[first] * normals[second] + normals[first + 1] * normals[second + 1] + normals[first + 2] * normals[second + 2];
    const bends = alignment < limit;
    sharp[edge] = bends || (wasSharp && !ignoreSharp) ? 1 : 0;
    smooth[edge] = sharp[edge] ? 0 : 1;
  }
  return withAttributes(mesh, { edge: { sharp: { data: sharp, size: 1 }, smooth: { data: smooth, size: 1 } } });
}

/**
 * Blender's Weighted Normal in face area mode: the corners around a vertex that stay smoothed together (not across a sharp
 * edge or one bending more than `angle` degrees) share one normal, the sum of their face normals each weighted by the face
 * area to the power weight / 50. The result is stored as the corner attribute `normal`.
 */
export function weightedNormals(mesh, { angle, weight }) {
  const { groupOfCorner, groupCount } = cornerNormals(mesh, { sharpAngle: angle * Math.PI / 180 });
  const { normals, areas } = faceNormals(mesh);
  const faces = cornerFaces(mesh);
  const exponent = weight / WEIGHT_REFERENCE;
  const sums = new Float64Array(groupCount * 3);
  for (let corner = 0; corner < mesh.cornerCount; corner++) {
    const face = faces[corner];
    const scale = Math.pow(areas[face], exponent);
    for (let axis = 0; axis < 3; axis++) sums[groupOfCorner[corner] * 3 + axis] += normals[face * 3 + axis] * scale;
  }
  const data = new Float32Array(mesh.cornerCount * 3);
  for (let corner = 0; corner < mesh.cornerCount; corner++) {
    const group = groupOfCorner[corner] * 3;
    const length = Math.hypot(sums[group], sums[group + 1], sums[group + 2]);
    const face = faces[corner] * 3;
    for (let axis = 0; axis < 3; axis++) data[corner * 3 + axis] = length > 0 ? sums[group + axis] / length : normals[face + axis];
  }
  return withAttributes(mesh, { corner: { normal: { data, size: 3 } } });
}

export function normalizeNormalEdit(edit, normalized, index, { finiteNumber }) {
  normalized.angle = edit.angle === undefined ? DEFAULT_NORMAL_ANGLE : finiteNumber(edit.angle, index, 'angle', { minimum: 0, maximum: 180 });
  if (edit.op === 'smooth_by_angle') {
    normalized.ignoreSharp = editBoolean(edit.ignoreSharp, index, 'ignoreSharp') ?? false;
    return;
  }
  normalized.weight = edit.weight === undefined ? WEIGHT_REFERENCE : finiteNumber(edit.weight, index, 'weight', { minimum: 1, maximum: MAXIMUM_NORMAL_WEIGHT });
}

export const NORMAL_RUNNERS = Object.freeze({ smooth_by_angle: smoothByAngle, weighted_normal: weightedNormals });
