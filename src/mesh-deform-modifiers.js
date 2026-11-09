import { withPositions } from './mesh-field-edits.js';
import { vertexNormals } from './mesh-normals.js';
import { invalidField } from './field-error.js';
import { editField, editInteger, editBoolean, editAxis } from './mesh-edit-field.js';

// Modifiers that only move vertices, each from a few numbers: lattice (a coarse grid of moved control points), curve (bend
// along a path), hook (pull the vertices near a point) and wave (a travelling ripple). Every list is bounded, and the
// errors name the field and the limit.

export const MAX_LATTICE_DIVISIONS = 8;
export const MAX_LATTICE_MOVES = 64;
export const MAX_CURVE_POINTS = 64;
export const HOOK_FALLOFFS = Object.freeze(['smooth', 'linear', 'constant']);
export const WAVE_AXES = Object.freeze(['xy', 'x', 'y']);
const AXIS_NAMES = Object.freeze({ x: 0, y: 1, z: 2 });
const CURVE_SAMPLES_PER_SEGMENT = 16;
const MINIMUM_SPAN = 1e-9;

function meshBounds(mesh) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], mesh.positions[vertex * 3 + axis]);
      high[axis] = Math.max(high[axis], mesh.positions[vertex * 3 + axis]);
    }
  }
  return { low, high };
}

/**
 * A lattice of `divisions` control points per axis spanning the mesh bounds. Each move shifts one control point by an
 * offset, and every vertex follows the trilinear blend of the shifts around it. Blender's default is a B-spline blend,
 * which is smoother between points.
 */
export function latticeDeform(mesh, { divisions, moves }) {
  const [countX, countY, countZ] = divisions;
  const shifts = new Float64Array(countX * countY * countZ * 3);
  const indexOfPoint = (x, y, z) => ((z * countY + y) * countX + x) * 3;
  for (const { point, offset } of moves) {
    for (let axis = 0; axis < 3; axis++) shifts[indexOfPoint(...point) + axis] += offset[axis];
  }
  const { low, high } = meshBounds(mesh);
  const counts = [countX, countY, countZ];
  const positions = new Float32Array(mesh.positions);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const cells = [0, 0, 0];
    const fractions = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      const span = high[axis] - low[axis];
      const position = span > MINIMUM_SPAN ? (mesh.positions[vertex * 3 + axis] - low[axis]) / span * (counts[axis] - 1) : 0;
      cells[axis] = Math.min(Math.floor(position), counts[axis] - 2);
      fractions[axis] = position - cells[axis];
    }
    for (let corner = 0; corner < 8; corner++) {
      const stepX = corner & 1;
      const stepY = (corner >> 1) & 1;
      const stepZ = (corner >> 2) & 1;
      const weight = (stepX ? fractions[0] : 1 - fractions[0]) * (stepY ? fractions[1] : 1 - fractions[1]) * (stepZ ? fractions[2] : 1 - fractions[2]);
      if (weight === 0) continue;
      const base = indexOfPoint(cells[0] + stepX, cells[1] + stepY, cells[2] + stepZ);
      for (let axis = 0; axis < 3; axis++) positions[vertex * 3 + axis] += shifts[base + axis] * weight;
    }
  }
  return positions;
}

function hookWeight(falloff, distance, radius) {
  if (distance >= radius) return 0;
  const closeness = 1 - distance / radius;
  if (falloff === 'constant') return 1;
  if (falloff === 'linear') return closeness;
  return closeness * closeness * (3 - 2 * closeness);
}

/** Blender's Hook: vertices within `radius` of `center` move by `translation` times `strength` and the falloff weight. */
export function hookDeform(mesh, { center, radius, translation, strength, falloff }) {
  const positions = new Float32Array(mesh.positions);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const distance = Math.hypot(
      mesh.positions[vertex * 3] - center[0],
      mesh.positions[vertex * 3 + 1] - center[1],
      mesh.positions[vertex * 3 + 2] - center[2],
    );
    const weight = hookWeight(falloff, distance, radius) * strength;
    if (weight === 0) continue;
    for (let axis = 0; axis < 3; axis++) positions[vertex * 3 + axis] += translation[axis] * weight;
  }
  return positions;
}

/**
 * Blender's Wave: a gaussian ripple along z (or the vertex normal) that travels away from `start` in x, y or both. `time` is a
 * frame number, as the scene frame is in Blender; the ripple moves `speed` units per frame after `timeOffset`.
 */
export function waveDeform(mesh, { height, width, narrowness, speed, time, timeOffset, start, cyclic, axes, normal }) {
  const positions = new Float32Array(mesh.positions);
  const normals = normal ? vertexNormals(mesh) : null;
  const floor = 1 / Math.exp(width * narrowness * width * narrowness);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const x = mesh.positions[vertex * 3] - start[0];
    const y = mesh.positions[vertex * 3 + 1] - start[1];
    let phase = axes === 'xy' ? Math.hypot(x, y) : axes === 'x' ? x : y;
    phase -= (time - timeOffset) * speed;
    if (cyclic) phase = (phase - width) % (width * 2) + width;
    if (!(phase > -width && phase < width)) continue;
    const scaled = phase * narrowness;
    const displacement = height * (1 / Math.exp(scaled * scaled) - floor);
    if (normals) {
      for (let axis = 0; axis < 3; axis++) positions[vertex * 3 + axis] += normals[vertex * 3 + axis] * displacement;
    } else {
      positions[vertex * 3 + 2] += displacement;
    }
  }
  return positions;
}

function catmullRom(before, from, to, after, fraction) {
  const squared = fraction * fraction;
  const cubed = squared * fraction;
  return from.map((value, axis) => 0.5 * (
    2 * value + (to[axis] - before[axis]) * fraction
    + (2 * before[axis] - 5 * value + 4 * to[axis] - after[axis]) * squared
    + (3 * value - before[axis] - 3 * to[axis] + after[axis]) * cubed));
}

function normalizedVector(vector) {
  const length = Math.hypot(...vector);
  return vector.map(component => component / length);
}

function dotProduct(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function crossProduct(first, second) {
  return [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
}

/** The path as a dense polyline with its distance from the start and a twist-free frame (tangent, normal, binormal) at each sample. */
function sampleCurve(path, upAxis) {
  const points = [];
  for (let segment = 0; segment + 1 < path.length; segment++) {
    const before = path[Math.max(segment - 1, 0)];
    const after = path[Math.min(segment + 2, path.length - 1)];
    for (let sample = 0; sample < CURVE_SAMPLES_PER_SEGMENT; sample++) {
      points.push(catmullRom(before, path[segment], path[segment + 1], after, sample / CURVE_SAMPLES_PER_SEGMENT));
    }
  }
  points.push(path.at(-1));
  const distances = [0];
  for (let index = 1; index < points.length; index++) {
    distances.push(distances[index - 1] + Math.hypot(...points[index].map((value, axis) => value - points[index - 1][axis])));
  }
  if (!(distances.at(-1) > MINIMUM_SPAN)) throw invalidField('path', path, 'points that are apart, such as [[0, 0, 0], [0, 0, 2]]');
  const tangents = points.map((point, index) => {
    const ahead = points[Math.min(index + 1, points.length - 1)];
    const behind = points[Math.max(index - 1, 0)];
    const direction = ahead.map((value, axis) => value - behind[axis]);
    return Math.hypot(...direction) > 0 ? normalizedVector(direction) : [1, 0, 0];
  });
  const up = [0, 0, 0];
  up[upAxis] = 1;
  const frames = [];
  let normal = up;
  tangents.forEach((tangent, index) => {
    let candidate = normal.map((value, axis) => value - dotProduct(normal, tangent) * tangent[axis]);
    if (Math.hypot(...candidate) < 1e-6) {
      const other = [0, 0, 0];
      other[(upAxis + 1) % 3] = 1;
      candidate = other.map((value, axis) => value - dotProduct(other, tangent) * tangent[axis]);
    }
    normal = normalizedVector(candidate);
    frames.push({ tangent, normal, binormal: crossProduct(tangent, normal), point: points[index], distance: distances[index] });
  });
  return frames;
}

function frameAtDistance(frames, distance) {
  const last = frames.length - 1;
  if (distance <= 0) return { ...frames[0], along: distance };
  if (distance >= frames[last].distance) return { ...frames[last], along: distance - frames[last].distance };
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (frames[middle].distance <= distance) low = middle;
    else high = middle;
  }
  const span = frames[high].distance - frames[low].distance;
  const fraction = span > 0 ? (distance - frames[low].distance) / span : 0;
  const mix = (first, second) => first.map((value, axis) => value + (second[axis] - value) * fraction);
  const tangent = normalizedVector(mix(frames[low].tangent, frames[high].tangent));
  const normal = normalizedVector(mix(frames[low].normal, frames[high].normal));
  return { tangent, normal, binormal: crossProduct(tangent, normal), point: mix(frames[low].point, frames[high].point), along: 0 };
}

/**
 * Blender's Curve: the coordinate of each vertex along `axis` is a distance from the start of the path, and the other two
 * coordinates become offsets from the path in a twist-free frame. The path is a Catmull-Rom spline through `path`; past
 * either end the mesh continues along the end tangent.
 */
export function curveDeform(mesh, { path, axis }) {
  const axisIndex = AXIS_NAMES[axis];
  const frames = sampleCurve(path, (axisIndex + 1) % 3);
  const positions = new Float32Array(mesh.positions);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const distance = mesh.positions[vertex * 3 + axisIndex];
    const acrossFirst = mesh.positions[vertex * 3 + (axisIndex + 1) % 3];
    const acrossSecond = mesh.positions[vertex * 3 + (axisIndex + 2) % 3];
    const frame = frameAtDistance(frames, distance);
    for (let component = 0; component < 3; component++) {
      positions[vertex * 3 + component] = frame.point[component] + frame.tangent[component] * frame.along
        + frame.normal[component] * acrossFirst + frame.binormal[component] * acrossSecond;
    }
  }
  return positions;
}

function checkedVector(value, index, label, finiteNumber) {
  if (!Array.isArray(value) || value.length !== 3) throw editField(index, label, value, 'an array of three numbers, such as [0, 1, 0]');
  return value.map(component => finiteNumber(component, index, label));
}

function normalizeLattice(edit, normalized, index, { finiteNumber }) {
  const divisions = edit.divisions ?? [2, 2, 2];
  if (!Array.isArray(divisions) || divisions.length !== 3) throw editField(index, 'divisions', divisions, `an array of three whole numbers from 2 to ${MAX_LATTICE_DIVISIONS}, such as [2, 2, 2]`);
  normalized.divisions = divisions.map(count => editInteger(count, index, 'divisions', 2, MAX_LATTICE_DIVISIONS));
  const moves = edit.moves ?? [];
  if (!Array.isArray(moves) || moves.length > MAX_LATTICE_MOVES) throw editField(index, 'moves', moves, `a list of at most ${MAX_LATTICE_MOVES} moves, such as [{ "point": [0, 0, 0], "offset": [0, 0, 1] }]`, RangeError);
  normalized.moves = moves.map((move, moveIndex) => {
    if (!move || typeof move !== 'object' || Array.isArray(move)) throw editField(index, `moves[${moveIndex}]`, move, 'an object such as { "point": [0, 0, 0], "offset": [0, 0, 1] }');
    if (!Array.isArray(move.point) || move.point.length !== 3) throw editField(index, `moves[${moveIndex}].point`, move.point, 'three grid indices, such as [0, 1, 0]');
    const point = move.point.map((cell, axis) => editInteger(cell, index, `moves[${moveIndex}].point`, 0, normalized.divisions[axis] - 1));
    return { point, offset: checkedVector(move.offset, index, `moves[${moveIndex}].offset`, finiteNumber) };
  });
}

function normalizeCurve(edit, normalized, index, { finiteNumber }) {
  if (!Array.isArray(edit.path) || edit.path.length < 2 || edit.path.length > MAX_CURVE_POINTS) {
    throw editField(index, 'path', edit.path, `an array of 2 to ${MAX_CURVE_POINTS} points of three numbers, such as [[0, 0, 0], [0, 0, 2]]`);
  }
  normalized.path = edit.path.map(point => checkedVector(point, index, 'path', finiteNumber));
  normalized.axis = edit.axis ?? 'x';
  editAxis(normalized.axis, index);
}

function normalizeHook(edit, normalized, index, { finiteNumber }) {
  normalized.center = checkedVector(edit.center ?? [0, 0, 0], index, 'center', finiteNumber);
  normalized.radius = edit.radius === undefined ? 1 : finiteNumber(edit.radius, index, 'radius', { minimum: 0, maximum: 1e4, exclusiveMinimum: true });
  normalized.translation = checkedVector(edit.translation ?? [0, 0, 0], index, 'translation', finiteNumber);
  normalized.strength = edit.strength === undefined ? 1 : finiteNumber(edit.strength, index, 'strength', { minimum: 0, maximum: 1 });
  normalized.falloff = edit.falloff ?? 'smooth';
  if (!HOOK_FALLOFFS.includes(normalized.falloff)) throw editField(index, 'falloff', normalized.falloff, `one of ${HOOK_FALLOFFS.join(', ')}`);
}

function normalizeWave(edit, normalized, index, { finiteNumber }) {
  normalized.height = edit.height === undefined ? 0.5 : finiteNumber(edit.height, index, 'height', { minimum: -1e4, maximum: 1e4 });
  normalized.width = edit.width === undefined ? 1.5 : finiteNumber(edit.width, index, 'width', { minimum: 0, maximum: 1e4, exclusiveMinimum: true });
  normalized.narrowness = edit.narrowness === undefined ? 1.5 : finiteNumber(edit.narrowness, index, 'narrowness', { minimum: 0, maximum: 50 });
  normalized.speed = edit.speed === undefined ? 0.25 : finiteNumber(edit.speed, index, 'speed', { minimum: -1e4, maximum: 1e4 });
  normalized.time = edit.time === undefined ? 0 : finiteNumber(edit.time, index, 'time', { minimum: -1e6, maximum: 1e6 });
  normalized.timeOffset = edit.timeOffset === undefined ? 0 : finiteNumber(edit.timeOffset, index, 'timeOffset', { minimum: -1e6, maximum: 1e6 });
  const start = edit.start ?? [0, 0];
  if (!Array.isArray(start) || start.length !== 2) throw editField(index, 'start', start, 'an array of two numbers, x and y, such as [0, 0]');
  normalized.start = start.map(value => finiteNumber(value, index, 'start'));
  normalized.cyclic = edit.cyclic ?? true;
  normalized.normal = edit.normal ?? false;
  editBoolean(normalized.cyclic, index, 'cyclic');
  editBoolean(normalized.normal, index, 'normal');
  normalized.axes = edit.axes ?? 'xy';
  if (!WAVE_AXES.includes(normalized.axes)) throw editField(index, 'axes', normalized.axes, `one of ${WAVE_AXES.join(', ')}`);
}

const NORMALIZERS = Object.freeze({ lattice: normalizeLattice, curve: normalizeCurve, hook: normalizeHook, wave: normalizeWave });
const DEFORMERS = Object.freeze({ lattice: latticeDeform, curve: curveDeform, hook: hookDeform, wave: waveDeform });

export const isDeformModifier = operation => Object.hasOwn(DEFORMERS, operation);

export function normalizeDeformEdit(edit, normalized, index, helpers) {
  NORMALIZERS[edit.op](edit, normalized, index, helpers);
}

export function runDeformEdit(mesh, edit) {
  return { mesh: withPositions(mesh, DEFORMERS[edit.op](mesh, edit)), result: {} };
}
