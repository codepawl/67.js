import { withPositions } from './mesh-field-edits.js';
import { mergeByDistance } from './mesh-ops.js';
import { triangulateFaces, splitSharpEdges } from './mesh-restructure.js';
import { MODIFIER_OPERATIONS } from './mesh-operations.js';
import { editField, editInteger, editAxis } from './mesh-edit-field.js';
import { normalizeGeneratorEdit, GENERATOR_RUNNERS } from './mesh-generator-modifiers.js';
import { normalizeNormalEdit, NORMAL_RUNNERS } from './mesh-normal-modifiers.js';
import { isDeformModifier, normalizeDeformEdit, runDeformEdit } from './mesh-deform-modifiers.js';

// The whole-mesh modifiers as recipe operations: validation of their fields and running them on MeshData. Smooth, cast and
// simple_deform only move vertices; weld, triangulate and edge_split change the faces (see mesh-restructure.js).

export const SIMPLE_DEFORM_MODES = Object.freeze(['twist', 'bend', 'taper', 'stretch']);
const AXIS_NAMES = Object.freeze({ x: 0, y: 1, z: 2 });
export const MAX_SMOOTH_ITERATIONS = 64;
const MINIMUM_FACTOR = 1e-7;

export function isModifierOperation(operation) {
  return Object.hasOwn(MODIFIER_OPERATIONS, operation);
}

function rejectField(edit, index, field, usedInstead) {
  if (edit[field] !== undefined) throw editField(index, field, edit[field], `left out, because ${edit.op} ${edit.mode} takes ${usedInstead}`);
}

function normalizeSimpleDeform(edit, normalized, index, finiteNumber) {
  if (!SIMPLE_DEFORM_MODES.includes(edit.mode)) {
    throw editField(index, 'mode', edit.mode, `one of ${SIMPLE_DEFORM_MODES.join(', ')}`);
  }
  normalized.mode = edit.mode;
  normalized.axis = edit.axis ?? 'z';
  editAxis(normalized.axis, index);
  if (edit.mode === 'twist' || edit.mode === 'bend') {
    rejectField(edit, index, 'factor', 'angle in degrees, such as "angle": 45');
    normalized.angle = edit.angle === undefined ? 45 : finiteNumber(edit.angle, index, 'angle', { minimum: -3600, maximum: 3600 });
    return;
  }
  rejectField(edit, index, 'angle', 'factor, such as "factor": 0.5');
  normalized.factor = edit.factor === undefined ? 0.5 : finiteNumber(edit.factor, index, 'factor', { minimum: -10, maximum: 10 });
}

/** Fill in `normalized` for a modifier edit, throwing a TypeError that names the edit when a field is wrong. */
export function normalizeModifierEdit(edit, normalized, index, { finiteNumber, checkedField }) {
  if (Object.hasOwn(GENERATOR_RUNNERS, edit.op)) {
    normalizeGeneratorEdit(edit, normalized, index, { finiteNumber, checkedField });
    return;
  }
  if (Object.hasOwn(NORMAL_RUNNERS, edit.op)) {
    normalizeNormalEdit(edit, normalized, index, { finiteNumber });
    return;
  }
  if (isDeformModifier(edit.op)) {
    normalizeDeformEdit(edit, normalized, index, { finiteNumber });
    return;
  }
  switch (edit.op) {
    case 'weld':
      normalized.distance = edit.distance === undefined ? 0.001 : finiteNumber(edit.distance, index, 'distance', { minimum: 0, maximum: 1e3, exclusiveMinimum: true });
      break;
    case 'triangulate':
      normalized.minVertices = edit.minVertices === undefined ? 4 : editInteger(edit.minVertices, index, 'minVertices', 4, 4096);
      break;
    case 'edge_split':
      normalized.angle = edit.angle === undefined ? 30 : finiteNumber(edit.angle, index, 'angle', { minimum: 0, maximum: 180 });
      break;
    case 'smooth':
      normalized.factor = edit.factor === undefined ? 0.5 : finiteNumber(edit.factor, index, 'factor', { minimum: -2, maximum: 2 });
      normalized.iterations = edit.iterations === undefined ? 1 : editInteger(edit.iterations, index, 'iterations', 1, MAX_SMOOTH_ITERATIONS);
      break;
    case 'simple_deform':
      normalizeSimpleDeform(edit, normalized, index, finiteNumber);
      break;
    case 'cast':
      normalized.factor = edit.factor === undefined ? 0.5 : finiteNumber(edit.factor, index, 'factor', { minimum: 0, maximum: 1 });
      normalized.size = edit.size === undefined ? 0 : finiteNumber(edit.size, index, 'size', { minimum: 0, maximum: 1e6 });
      break;
  }
}

/** Laplacian smoothing over the mesh edges, as Blender's Smooth modifier: a step of factor / 2 toward the neighbour mean. */
function smoothPositions(mesh, { factor, iterations }) {
  const positions = Float64Array.from(mesh.positions);
  const sums = new Float64Array(positions.length);
  const counts = new Uint32Array(mesh.vertexCount);
  for (let iteration = 0; iteration < iterations; iteration++) {
    sums.fill(0);
    counts.fill(0);
    for (let edge = 0; edge < mesh.edgeCount; edge++) {
      const first = mesh.edgeVertices[edge * 2];
      const second = mesh.edgeVertices[edge * 2 + 1];
      for (let axis = 0; axis < 3; axis++) {
        sums[first * 3 + axis] += positions[second * 3 + axis];
        sums[second * 3 + axis] += positions[first * 3 + axis];
      }
      counts[first]++;
      counts[second]++;
    }
    for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
      if (counts[vertex] === 0) continue;
      for (let axis = 0; axis < 3; axis++) {
        const index = vertex * 3 + axis;
        positions[index] += (factor / 2) * (sums[index] / counts[vertex] - positions[index]);
      }
    }
  }
  return Float32Array.from(positions);
}

/** Blend vertices toward a sphere about the local origin. Radius 0 means the mean distance of all vertices. */
function castPositions(mesh, { factor, size }) {
  const distances = new Float64Array(mesh.vertexCount);
  let total = 0;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    distances[vertex] = Math.hypot(mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]);
    total += distances[vertex];
  }
  const radius = size > 0 ? size : total / mesh.vertexCount;
  const positions = new Float32Array(mesh.positions);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (distances[vertex] === 0) continue;
    const toward = radius / distances[vertex];
    for (let axis = 0; axis < 3; axis++) {
      const index = vertex * 3 + axis;
      positions[index] = mesh.positions[index] * (1 - factor) + mesh.positions[index] * toward * factor;
    }
  }
  return positions;
}

/**
 * The three coordinates a deformation works in, as axis indices. Twist, taper and stretch run along the chosen axis
 * (the third entry) and use the next two as the cross-section. Bend puts the chosen axis first and measures along z
 * (or x when the axis is z), matching Blender's Simple Deform.
 */
function deformRoles(mode, axis) {
  if (mode !== 'bend') return [(axis + 1) % 3, (axis + 2) % 3, axis];
  return [[0, 1, 2], [1, 0, 2], [2, 1, 0]][axis];
}

function deformPoint(mode, [crossX, crossY, along], rate) {
  if (mode === 'twist') {
    const theta = along * rate;
    return [crossX * Math.cos(theta) - crossY * Math.sin(theta), crossX * Math.sin(theta) + crossY * Math.cos(theta), along];
  }
  if (mode === 'taper') {
    const scale = 1 + along * rate;
    return [crossX * scale, crossY * scale, along];
  }
  if (mode === 'stretch') {
    const scale = along * along * rate - rate + 1;
    return [crossX * scale, crossY * scale, along * (1 + rate)];
  }
  const theta = along * rate;
  return [crossX, crossY * Math.cos(theta) + (1 - Math.cos(theta)) / rate, -(crossY - 1 / rate) * Math.sin(theta)];
}

/** Twist, bend, taper or stretch over the mesh extent along the axis. A mesh with no extent along it stays as it is. */
function simpleDeformPositions(mesh, { mode, axis, angle, factor }) {
  const roles = deformRoles(mode, AXIS_NAMES[axis]);
  let low = Infinity;
  let high = -Infinity;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    low = Math.min(low, mesh.positions[vertex * 3 + roles[2]]);
    high = Math.max(high, mesh.positions[vertex * 3 + roles[2]]);
  }
  const span = high - low;
  const rate = (mode === 'twist' || mode === 'bend' ? angle * Math.PI / 180 : factor) / span;
  const positions = new Float32Array(mesh.positions);
  if (!(span > 1e-9) || (mode === 'bend' && Math.abs(rate) < MINIMUM_FACTOR)) return positions;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const point = roles.map(role => mesh.positions[vertex * 3 + role]);
    const moved = deformPoint(mode, point, rate);
    roles.forEach((role, position) => {
      positions[vertex * 3 + role] = moved[position];
    });
  }
  return positions;
}

/** Run a modifier edit. Returns { mesh, result } where result holds the counts to report. */
// Modifiers that other modules supply (mesh-hull-modifiers.js registers itself), so a bundle that never runs one does not carry its code.
const REGISTERED_RUNNERS = Object.create(null);

export function registerModifierRunner(operation, runner) {
  REGISTERED_RUNNERS[operation] = runner;
}

export function runModifierEdit(mesh, edit, { maxVertices, maxFaces }) {
  if (Object.hasOwn(GENERATOR_RUNNERS, edit.op)) return GENERATOR_RUNNERS[edit.op](mesh, edit, { maxVertices, maxFaces });
  if (Object.hasOwn(NORMAL_RUNNERS, edit.op)) return { mesh: NORMAL_RUNNERS[edit.op](mesh, edit), result: {} };
  if (Object.hasOwn(REGISTERED_RUNNERS, edit.op)) return REGISTERED_RUNNERS[edit.op](mesh, edit);
  if (isDeformModifier(edit.op)) return runDeformEdit(mesh, edit);
  switch (edit.op) {
    case 'weld': {
      const merged = mergeByDistance(mesh, edit.distance);
      return { mesh: merged.mesh, result: { removedVertices: merged.removedVertices, removedFaces: merged.removedFaces } };
    }
    case 'triangulate': {
      const outcome = triangulateFaces(mesh, { minVertices: edit.minVertices, maxFaces });
      return { mesh: outcome.mesh, result: { triangulated: outcome.triangulated } };
    }
    case 'edge_split': {
      const outcome = splitSharpEdges(mesh, { angle: edit.angle, maxVertices });
      return { mesh: outcome.mesh, result: { addedVertices: outcome.addedVertices } };
    }
    case 'smooth':
      return { mesh: withPositions(mesh, smoothPositions(mesh, edit)), result: {} };
    case 'cast':
      return { mesh: withPositions(mesh, castPositions(mesh, edit)), result: {} };
    case 'simple_deform':
      return { mesh: withPositions(mesh, simpleDeformPositions(mesh, edit)), result: {} };
  }
  throw new TypeError(`Not a modifier: ${edit.op}`);
}
