import { createMeshData } from './mesh-data.js';
import { vertexNormals, faceNormals } from './mesh-normals.js';
import { evaluateField, meshFieldContext } from './mesh-fields.js';
import { invalidField } from './field-error.js';
import { editInteger, editBoolean, editAxis } from './mesh-edit-field.js';

// Modifiers that build new surface from the mesh they are given: screw revolves its edges, wireframe turns its faces into
// struts and skin puts a square tube on every edge. Each one checks the size of its result against the limits before it
// allocates, and each says in its error what to change.

export const MAX_SCREW_STEPS = 256;
export const MAX_SCREW_ITERATIONS = 64;
const AXIS_NAMES = Object.freeze({ x: 0, y: 1, z: 2 });
const FULL_TURN_TOLERANCE = 1e-6;
const MINIMUM_EDGE_LENGTH = 1e-12;

function limitError(operation, vertices, faces, { maxVertices, maxFaces }, advice) {
  if (vertices > maxVertices || faces > maxFaces) {
    throw new RangeError(`${operation} would make ${vertices} vertices and ${faces} faces, over the limit of ${maxVertices} vertices and ${maxFaces} faces. ${advice}`);
  }
}

function meshFromQuads(positions, quads) {
  const faceOffsets = new Uint32Array(quads.length / 4 + 1);
  for (let face = 0; face < faceOffsets.length; face++) faceOffsets[face] = face * 4;
  return createMeshData({ positions: Float32Array.from(positions), faceOffsets, cornerVertices: Uint32Array.from(quads) });
}

function rotateAboutAxis(point, axisIndex, angle) {
  const first = (axisIndex + 1) % 3;
  const second = (axisIndex + 2) % 3;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const rotated = [...point];
  rotated[first] = point[first] * cosine - point[second] * sine;
  rotated[second] = point[first] * sine + point[second] * cosine;
  return rotated;
}

/**
 * Blender's Screw: every edge of the mesh is revolved about the axis through the origin, `steps` per iteration, turning by
 * `angle` degrees and rising by `lift` along the axis in each iteration. The faces of the input are not kept. A whole number of
 * turns with no lift closes the ring instead of repeating the first copy.
 */
export function screwMesh(mesh, { axis, angle, steps, iterations, lift }, limits) {
  const totalSteps = steps * iterations;
  const turns = angle * iterations / 360;
  const isClosed = lift === 0 && Math.abs(turns) >= 1 - FULL_TURN_TOLERANCE && Math.abs(turns - Math.round(turns)) < FULL_TURN_TOLERANCE;
  const copies = isClosed ? totalSteps : totalSteps + 1;
  limitError('screw', mesh.vertexCount * copies, mesh.edgeCount * totalSteps, limits, 'Lower steps or iterations, or revolve a smaller profile.');
  const axisIndex = AXIS_NAMES[axis];
  const stepAngle = angle * Math.PI / 180 / steps;
  const stepLift = lift / steps;
  const positions = [];
  for (let copy = 0; copy < copies; copy++) {
    for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
      const point = [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
      const moved = rotateAboutAxis(point, axisIndex, stepAngle * copy);
      moved[axisIndex] += stepLift * copy;
      positions.push(...moved);
    }
  }
  const quads = [];
  for (let step = 0; step < totalSteps; step++) {
    const current = step * mesh.vertexCount;
    const following = ((step + 1) % copies) * mesh.vertexCount;
    for (let edge = 0; edge < mesh.edgeCount; edge++) {
      const first = mesh.edgeVertices[edge * 2];
      const second = mesh.edgeVertices[edge * 2 + 1];
      quads.push(current + first, current + second, following + second, following + first);
    }
  }
  return { mesh: meshFromQuads(positions, quads), result: { steps: totalSteps, closed: isClosed } };
}

function crossProduct(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function normalized(vector) {
  const length = Math.hypot(...vector);
  return length > 0 ? vector.map(component => component / length) : vector;
}

/**
 * Blender's Wireframe: each face keeps a rim of width `thickness` along its edges. A vertex gets an inner and an outer copy
 * along its normal, split by `offset` (-1 puts the strut inside the surface, 1 outside), and each face edge becomes an inner
 * and an outer quad to the face's inset corners. `evenOffset` insets corners so every strut is as wide as the thickness.
 */
export function wireframeMesh(mesh, { thickness, offset, evenOffset, replace }, limits) {
  const keptVertices = replace ? 0 : mesh.vertexCount;
  const keptFaces = replace ? 0 : mesh.faceCount;
  limitError('wireframe', keptVertices + mesh.vertexCount * 2 + mesh.cornerCount, keptFaces + mesh.cornerCount * 2, limits, 'Use a mesh with fewer faces.');
  const normals = vertexNormals(mesh);
  const faceNormalValues = faceNormals(mesh).normals;
  const half = thickness / 2;
  const positions = [];
  if (!replace) positions.push(...mesh.positions);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    for (const shift of [(offset - 1) * half, (1 + offset) * half]) {
      for (let axis = 0; axis < 3; axis++) positions.push(mesh.positions[vertex * 3 + axis] + normals[vertex * 3 + axis] * shift);
    }
  }
  const cornerBase = keptVertices + mesh.vertexCount * 2;
  const pointAt = vertex => [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    const faceNormal = [...faceNormalValues.subarray(face * 3, face * 3 + 3)];
    for (let corner = start; corner < end; corner++) {
      const vertex = mesh.cornerVertices[corner];
      const previous = pointAt(mesh.cornerVertices[corner === start ? end - 1 : corner - 1]);
      const next = pointAt(mesh.cornerVertices[corner + 1 === end ? start : corner + 1]);
      const here = pointAt(vertex);
      const incoming = normalized(here.map((value, axis) => value - previous[axis]));
      const outgoing = normalized(next.map((value, axis) => value - here[axis]));
      const insideIncoming = crossProduct(faceNormal, incoming);
      const insideOutgoing = crossProduct(faceNormal, outgoing);
      const sum = insideIncoming.map((value, axis) => value + insideOutgoing[axis]);
      const alignment = insideIncoming[0] * insideOutgoing[0] + insideIncoming[1] * insideOutgoing[1] + insideIncoming[2] * insideOutgoing[2];
      const inset = evenOffset ? sum.map(value => value * half / Math.max(1 + alignment, 1e-3)) : normalized(sum).map(value => value * half);
      for (let axis = 0; axis < 3; axis++) {
        positions.push(here[axis] + normals[vertex * 3 + axis] * offset * half + inset[axis]);
      }
    }
  }
  const innerOf = vertex => keptVertices + vertex * 2;
  const outerOf = vertex => keptVertices + vertex * 2 + 1;
  const faceOffsets = [0];
  const cornerVertices = [];
  const addFace = vertices => {
    cornerVertices.push(...vertices);
    faceOffsets.push(cornerVertices.length);
  };
  if (!replace) {
    for (let face = 0; face < mesh.faceCount; face++) {
      addFace(Array.from(mesh.cornerVertices.subarray(mesh.faceOffsets[face], mesh.faceOffsets[face + 1])));
    }
  }
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    for (let corner = start; corner < end; corner++) {
      const nextCorner = corner + 1 === end ? start : corner + 1;
      const here = mesh.cornerVertices[corner];
      const next = mesh.cornerVertices[nextCorner];
      addFace([cornerBase + corner, cornerBase + nextCorner, innerOf(next), innerOf(here)]);
      addFace([cornerBase + nextCorner, cornerBase + corner, outerOf(here), outerOf(next)]);
    }
  }
  return {
    mesh: createMeshData({
      positions: Float32Array.from(positions), faceOffsets: Uint32Array.from(faceOffsets), cornerVertices: Uint32Array.from(cornerVertices),
    }),
    result: {},
  };
}

function perpendicularFrame(direction) {
  const smallest = direction.map(Math.abs).indexOf(Math.min(...direction.map(Math.abs)));
  const reference = [0, 0, 0];
  reference[smallest] = 1;
  const first = normalized(crossProduct(direction, reference));
  const second = crossProduct(direction, first);
  return [first, second];
}

/** One radius per vertex, from a number or a field expression, each of which must be above zero. */
function skinRadii(mesh, radius) {
  if (typeof radius === 'number') return new Float64Array(mesh.vertexCount).fill(radius);
  const { values } = evaluateField(radius, meshFieldContext(mesh, 'point'), { kind: 'scalar' });
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (!(values[vertex] > 0) || !Number.isFinite(values[vertex])) {
      throw invalidField('radius', values[vertex], `above 0 at every vertex, such as 0.1 (vertex ${vertex} breaks this); change the radius field, for example wrap it in max`);
    }
  }
  return values;
}

/**
 * A simple Skin: a square tube along every edge of the mesh, as wide as the radius of its two end vertices, closed by an
 * end cap. Tubes that meet at a vertex overlap rather than being joined into one hull, so this is not Blender's branch solver.
 */
export function skinMesh(mesh, { radius }, limits) {
  limitError('skin', mesh.edgeCount * 8, mesh.edgeCount * 6, limits, 'Skin a mesh with fewer edges.');
  const radii = skinRadii(mesh, radius);
  const positions = [];
  const quads = [];
  const caps = [];
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const firstVertex = mesh.edgeVertices[edge * 2];
    const secondVertex = mesh.edgeVertices[edge * 2 + 1];
    const start = [mesh.positions[firstVertex * 3], mesh.positions[firstVertex * 3 + 1], mesh.positions[firstVertex * 3 + 2]];
    const finish = [mesh.positions[secondVertex * 3], mesh.positions[secondVertex * 3 + 1], mesh.positions[secondVertex * 3 + 2]];
    const direction = finish.map((value, axis) => value - start[axis]);
    if (Math.hypot(...direction) < MINIMUM_EDGE_LENGTH) throw new RangeError(`skin edge ${edge} has no length. Weld the mesh first.`);
    const [across, up] = perpendicularFrame(normalized(direction));
    const base = positions.length / 3;
    for (const [point, size] of [[start, radii[firstVertex]], [finish, radii[secondVertex]]]) {
      for (const [acrossSign, upSign] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        for (let axis = 0; axis < 3; axis++) positions.push(point[axis] + (across[axis] * acrossSign + up[axis] * upSign) * size);
      }
    }
    for (let side = 0; side < 4; side++) {
      const following = (side + 1) % 4;
      quads.push(base + side, base + following, base + 4 + following, base + 4 + side);
    }
    caps.push([base + 3, base + 2, base + 1, base], [base + 4, base + 5, base + 6, base + 7]);
  }
  const faceOffsets = [0];
  const cornerVertices = [];
  for (let index = 0; index < quads.length; index += 4) {
    cornerVertices.push(quads[index], quads[index + 1], quads[index + 2], quads[index + 3]);
    faceOffsets.push(cornerVertices.length);
  }
  for (const cap of caps) {
    cornerVertices.push(...cap);
    faceOffsets.push(cornerVertices.length);
  }
  return {
    mesh: createMeshData({
      positions: Float32Array.from(positions), faceOffsets: Uint32Array.from(faceOffsets), cornerVertices: Uint32Array.from(cornerVertices),
    }),
    result: { tubes: mesh.edgeCount },
  };
}

export function normalizeGeneratorEdit(edit, normalized, index, { finiteNumber, checkedField }) {
  switch (edit.op) {
    case 'screw':
      normalized.axis = edit.axis ?? 'z';
      editAxis(normalized.axis, index);
      normalized.angle = edit.angle === undefined ? 360 : finiteNumber(edit.angle, index, 'angle', { minimum: -3600, maximum: 3600 });
      normalized.steps = edit.steps === undefined ? 16 : editInteger(edit.steps, index, 'steps', 1, MAX_SCREW_STEPS);
      normalized.iterations = edit.iterations === undefined ? 1 : editInteger(edit.iterations, index, 'iterations', 1, MAX_SCREW_ITERATIONS);
      normalized.lift = edit.lift === undefined ? 0 : finiteNumber(edit.lift, index, 'lift', { minimum: -1e4, maximum: 1e4 });
      break;
    case 'wireframe':
      normalized.thickness = edit.thickness === undefined ? 0.02 : finiteNumber(edit.thickness, index, 'thickness', { minimum: 0, maximum: 1e3, exclusiveMinimum: true });
      normalized.offset = edit.offset === undefined ? 0 : finiteNumber(edit.offset, index, 'offset', { minimum: -1, maximum: 1 });
      normalized.evenOffset = edit.evenOffset ?? true;
      normalized.replace = edit.replace ?? true;
      editBoolean(normalized.evenOffset, index, 'evenOffset');
      editBoolean(normalized.replace, index, 'replace');
      break;
    case 'skin':
      if (edit.radius === undefined) {
        normalized.radius = 0.1;
      } else if (typeof edit.radius === 'number') {
        normalized.radius = finiteNumber(edit.radius, index, 'radius', { minimum: 0, maximum: 1e3, exclusiveMinimum: true });
      } else {
        normalized.radius = checkedField(edit.radius, index, 'radius', 'scalar');
      }
      break;
  }
}

export const GENERATOR_RUNNERS = Object.freeze({ screw: screwMesh, wireframe: wireframeMesh, skin: skinMesh });
