import { buildLathe, buildExtrusion, buildTube } from './modeling-shapes.js';
import { sweepSamples } from './modeling-bezier.js';
import { resampleSamples, sampleCountOf, sampleSpline, shapeToSpline, trimSamples } from './modeling-splines.js';
import { planSdf, sdfGeometry as buildSdf } from './modeling-sdf.js';

const MAX_INPUT_POINTS = 4096;
const DEFAULT_VERTEX_LIMIT = 250_000;

function finite(value, name) {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new TypeError(`${name} must be a finite float.`);
  return Math.fround(value);
}

function integer(value, minimum, maximum, name) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be an integer within ${minimum} and ${maximum}.`);
  return value;
}

function pointsFrom(input, size, minimum, name) {
  if (!Array.isArray(input) || input.length < minimum || input.length > MAX_INPUT_POINTS) throw new RangeError(`${name} needs ${minimum} to ${MAX_INPUT_POINTS} points.`);
  const points = input.map(point => {
    if ((!Array.isArray(point) && !ArrayBuffer.isView(point)) || point.length !== size) throw new TypeError(`${name} points need ${size} components.`);
    return Array.from(point, value => finite(value, name));
  });
  for (let index = 1; index < points.length; index++) {
    if (points[index].every((value, axis) => value === points[index - 1][axis])) throw new RangeError(`${name} cannot contain consecutive duplicate points.`);
  }
  return points;
}

function vectorFrom(input, name) {
  if (!Array.isArray(input) || input.length !== 3) throw new TypeError(`${name} needs three components.`);
  return input.map(value => finite(value, name));
}

function knotFrom(input, index) {
  if (Array.isArray(input)) return { position: vectorFrom(input, 'point') };
  if (!input || typeof input !== 'object') throw new TypeError(`Curve point ${index} must be [x, y, z] or an object with position.`);
  for (const key of Object.keys(input)) {
    if (!['position', 'handleIn', 'handleOut'].includes(key)) throw new TypeError(`Unknown curve point field: ${key}.`);
  }
  return {
    position: vectorFrom(input.position, 'position'),
    ...(input.handleIn === undefined ? {} : { handleIn: vectorFrom(input.handleIn, 'handleIn') }),
    ...(input.handleOut === undefined ? {} : { handleOut: vectorFrom(input.handleOut, 'handleOut') }),
  };
}

function taperFrom(taper) {
  if (taper === undefined) return null;
  if (!Array.isArray(taper) || taper.length < 2 || taper.length > 64) throw new RangeError('taper needs 2 to 64 radius factors.');
  return taper.map(factor => {
    finite(factor, 'taper');
    if (factor < 0) throw new RangeError('taper factors cannot be negative.');
    return factor;
  });
}

function checkBudget(vertices, maximum) {
  integer(maximum, 3, 1_000_000, 'maxVertices');
  if (vertices > maximum) throw new RangeError(`Modeling requires up to ${vertices} vertices, exceeding maxVertices ${maximum}. Reduce detail.`);
}

function meshFrom(source, maximum) {
  checkBudget(source.positions.length / 3, maximum);
  const { positions, normals, uvs } = source;
  const indices = source.indices ?? Uint32Array.from({ length: positions.length / 3 }, (_, index) => index);
  for (let offset = 0; offset < normals.length; offset += 3) {
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]);
    if (!Number.isFinite(length) || length === 0) throw new RangeError('Modeling produced an invalid normal. Adjust the profile or contour.');
    for (let axis = 0; axis < 3; axis++) normals[offset + axis] /= length;
  }
  for (const value of positions) if (!Number.isFinite(value)) throw new RangeError('Modeling geometry exceeds the finite Float32 range. Reduce coordinates.');
  for (const value of uvs) if (!Number.isFinite(value)) throw new RangeError('Modeling produced invalid UVs. Adjust the profile or contour.');
  let drawable = false;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const first = indices[offset] * 3;
    const second = indices[offset + 1] * 3;
    const third = indices[offset + 2] * 3;
    const ax = positions[second] - positions[first];
    const ay = positions[second + 1] - positions[first + 1];
    const az = positions[second + 2] - positions[first + 2];
    const bx = positions[third] - positions[first];
    const by = positions[third + 1] - positions[first + 1];
    const bz = positions[third + 2] - positions[first + 2];
    if (Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) > 0) {
      drawable = true;
      break;
    }
  }
  if (!drawable) throw new RangeError('Modeling collapsed at Float32 precision. Center geometry locally and position it with a transform.');
  return { positions, normals, uvs, indices };
}

/** Revolve a radius/height profile around Y. */
export function lathe(profile, { segments = 64, startAngle = 0, sweep = Math.PI * 2, maxVertices = DEFAULT_VERTEX_LIMIT } = {}) {
  integer(segments, 3, 2048, 'segments');
  finite(startAngle, 'startAngle');
  startAngle %= Math.PI * 2;
  finite(sweep, 'sweep');
  if (sweep <= 0 || sweep > Math.PI * 2) throw new RangeError('sweep must be greater than zero and at most one full turn.');
  const points = pointsFrom(profile, 2, 2, 'profile');
  if (points.some(point => point[0] < 0) || !points.some(point => point[0] > 0)) throw new RangeError('Profile radii must be nonnegative, with at least one positive radius.');
  checkBudget((segments + 1) * points.length, maxVertices);
  return meshFrom(buildLathe(points, segments, startAngle, sweep), maxVertices);
}

function orientation(first, second, third) {
  return (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]);
}

function onSegment(first, second, point) {
  return orientation(first, second, point) === 0 && point[0] >= Math.min(first[0], second[0]) && point[0] <= Math.max(first[0], second[0]) && point[1] >= Math.min(first[1], second[1]) && point[1] <= Math.max(first[1], second[1]);
}

function intersects(first, second, third, fourth) {
  const a = orientation(first, second, third);
  const b = orientation(first, second, fourth);
  const c = orientation(third, fourth, first);
  const d = orientation(third, fourth, second);
  return Math.sign(a) !== Math.sign(b) && Math.sign(c) !== Math.sign(d) ||
    a === 0 && onSegment(first, second, third) || b === 0 && onSegment(first, second, fourth) ||
    c === 0 && onSegment(third, fourth, first) || d === 0 && onSegment(third, fourth, second);
}

function ringFrom(input, name) {
  const points = pointsFrom(input, 2, 3, name);
  if (points[0].every((value, axis) => value === points.at(-1)[axis])) points.pop();
  if (points.length < 3) throw new RangeError(`${name} needs three distinct points.`);
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const next = (index + 1) % points.length;
    area += points[index][0] * points[next][1] - points[next][0] * points[index][1];
    for (let other = index + 1; other < points.length; other++) {
      const otherNext = (other + 1) % points.length;
      if (other === next || otherNext === index) continue;
      if (intersects(points[index], points[next], points[other], points[otherNext])) throw new RangeError(`${name} cannot intersect or touch itself.`);
    }
  }
  if (area === 0) throw new RangeError(`${name} must enclose a nonzero area.`);
  return points;
}

function inside(point, ring) {
  let result = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index];
    const b = ring[previous];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

function ringsIntersect(first, second) {
  for (let a = 0; a < first.length; a++) {
    for (let b = 0; b < second.length; b++) {
      if (intersects(first[a], first[(a + 1) % first.length], second[b], second[(b + 1) % second.length])) return true;
    }
  }
  return false;
}

/**
 * Triangulating a cap drops points that are collinear with their neighbours, so a long cap edge can run past wall
 * vertices and leave the solid open. Split those triangles at the skipped points, which keeps the surface unchanged.
 */
function closeTJunctions(geometry) {
  const { positions, normals, uvs, indices } = geometry;
  const vertexKey = vertex => `${positions[vertex * 3]},${positions[vertex * 3 + 1]},${positions[vertex * 3 + 2]}`;
  const edgeKey = (first, second) => {
    const firstKey = vertexKey(first);
    const secondKey = vertexKey(second);
    return firstKey < secondKey ? `${firstKey}|${secondKey}` : `${secondKey}|${firstKey}`;
  };
  const edgeUses = new Map();
  for (let offset = 0; offset < indices.length; offset += 3) {
    for (let side = 0; side < 3; side++) {
      const key = edgeKey(indices[offset + side], indices[offset + (side + 1) % 3]);
      edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
    }
  }
  const openEdges = new Set([...edgeUses].filter(([, uses]) => uses !== 2).map(([key]) => key));
  if (openEdges.size === 0) return geometry;
  const candidates = new Map();
  for (let offset = 0; offset < indices.length; offset += 3) {
    for (let side = 0; side < 3; side++) {
      const first = indices[offset + side];
      const second = indices[offset + (side + 1) % 3];
      if (!openEdges.has(edgeKey(first, second))) continue;
      candidates.set(vertexKey(first), first);
      candidates.set(vertexKey(second), second);
    }
  }
  const newPositions = Array.from(positions);
  const newNormals = Array.from(normals);
  const newUvs = Array.from(uvs);
  const pointsInside = (first, second) => {
    const start = [newPositions[first * 3], newPositions[first * 3 + 1], newPositions[first * 3 + 2]];
    const direction = [0, 1, 2].map(axis => newPositions[second * 3 + axis] - start[axis]);
    const lengthSquared = direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2;
    const tolerance = 1e-6 * Math.max(Math.sqrt(lengthSquared), ...start.map(Math.abs));
    const inside = [];
    for (const candidate of candidates.values()) {
      const offsetFromStart = [0, 1, 2].map(axis => positions[candidate * 3 + axis] - start[axis]);
      const along = (offsetFromStart[0] * direction[0] + offsetFromStart[1] * direction[1] + offsetFromStart[2] * direction[2]) / lengthSquared;
      if (along <= 1e-6 || along >= 1 - 1e-6) continue;
      const distance = Math.hypot(...offsetFromStart.map((value, axis) => value - direction[axis] * along));
      if (distance <= tolerance) inside.push({ candidate, along });
    }
    return inside.sort((left, right) => left.along - right.along);
  };
  const addVertexOnEdge = (first, second, { candidate, along }) => {
    const vertex = newPositions.length / 3;
    for (let axis = 0; axis < 3; axis++) {
      newPositions.push(positions[candidate * 3 + axis]);
      newNormals.push(newNormals[first * 3 + axis] + (newNormals[second * 3 + axis] - newNormals[first * 3 + axis]) * along);
    }
    for (let axis = 0; axis < 2; axis++) newUvs.push(newUvs[first * 2 + axis] + (newUvs[second * 2 + axis] - newUvs[first * 2 + axis]) * along);
    return vertex;
  };
  const newIndices = [];
  const pending = [];
  for (let offset = indices.length - 3; offset >= 0; offset -= 3) pending.push([indices[offset], indices[offset + 1], indices[offset + 2]]);
  while (pending.length) {
    const triangle = pending.pop();
    let split = false;
    for (let side = 0; side < 3 && !split; side++) {
      const first = triangle[side];
      const second = triangle[(side + 1) % 3];
      const opposite = triangle[(side + 2) % 3];
      if (!openEdges.has(edgeKey(first, second))) continue;
      const inside = pointsInside(first, second);
      if (!inside.length) continue;
      const chain = [first, ...inside.map(point => addVertexOnEdge(first, second, point)), second];
      for (let link = chain.length - 2; link >= 0; link--) pending.push([chain[link], chain[link + 1], opposite]);
      split = true;
    }
    if (!split) newIndices.push(...triangle);
  }
  return {
    positions: Float32Array.from(newPositions), normals: Float32Array.from(newNormals),
    uvs: Float32Array.from(newUvs), indices: Uint32Array.from(newIndices),
  };
}

/** Extrude a simple XY contour and disjoint enclosed holes along positive Z. */
export function extrude(contour, {
  holes = [], depth = 1, steps = 1, bevel = 0, bevelThickness = bevel,
  bevelSegments = 3, maxVertices = DEFAULT_VERTEX_LIMIT,
} = {}) {
  depth = finite(depth, 'depth');
  bevel = finite(bevel, 'bevel');
  bevelThickness = finite(bevelThickness, 'bevelThickness');
  if (depth <= 0 || bevel < 0 || bevelThickness < 0) throw new RangeError('depth must be positive and bevel dimensions must be nonnegative.');
  integer(steps, 1, 256, 'steps');
  integer(bevelSegments, 1, 32, 'bevelSegments');
  if (!Array.isArray(holes) || holes.length > 128) throw new RangeError('holes must be an array with at most 128 rings.');
  const inputPoints = (contour?.length ?? 0) + holes.reduce((count, hole) => count + (hole?.length ?? 0), 0);
  if (inputPoints > MAX_INPUT_POINTS + holes.length + 1) throw new RangeError(`Contours and holes must contain at most ${MAX_INPUT_POINTS} total points.`);
  const outer = ringFrom(contour, 'contour');
  const inner = holes.map((hole, index) => ringFrom(hole, `hole ${index}`));
  const totalPoints = outer.length + inner.reduce((count, ring) => count + ring.length, 0);
  if (totalPoints > MAX_INPUT_POINTS) throw new RangeError(`Contours and holes must contain at most ${MAX_INPUT_POINTS} total points.`);
  const beveled = bevel > 0 || bevelThickness > 0;
  checkBudget(6 * (totalPoints + inner.length * 2 - 2) + 6 * totalPoints * (steps + (beveled ? bevelSegments * 2 : 0)), maxVertices);
  for (let index = 0; index < inner.length; index++) {
    if (!inside(inner[index][0], outer) || ringsIntersect(outer, inner[index])) throw new RangeError('Every hole must lie strictly inside the contour.');
    for (let other = 0; other < index; other++) {
      if (ringsIntersect(inner[index], inner[other]) || inside(inner[index][0], inner[other]) || inside(inner[other][0], inner[index])) throw new RangeError('Holes cannot overlap, touch or contain each other.');
    }
  }
  return closeTJunctions(meshFrom(buildExtrusion(outer, inner, { depth, steps, bevel, bevelThickness, bevelSegments }), maxVertices));
}

const SPLINE_TYPES = ['bezier', 'poly', 'nurbs'];
const MAX_SPLINES = 64;
const MAX_CURVE_POINTS = 1024;
const MAX_TOTAL_CURVE_POINTS = 4096;
const SPLINE_FIELDS = ['points', 'shape', 'closed', 'kind', 'weights', 'trim'];

function trimFrom(input, label) {
  if (input === undefined) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${label} must be an object such as { "start": 0, "end": 0.5 }.`);
  for (const key of Object.keys(input)) {
    if (!['start', 'end', 'length'].includes(key)) throw new TypeError(`Unknown ${label} field: ${key}. Use start, end, length.`);
  }
  if (input.length !== undefined && typeof input.length !== 'boolean') throw new TypeError(`${label}.length must be true (start and end are lengths) or false (factors 0 to 1).`);
  const byLength = input.length === true;
  const maximum = byLength ? 1e9 : 1;
  const start = finite(input.start ?? 0, `${label}.start`);
  const end = finite(input.end ?? maximum, `${label}.end`);
  if (start < 0 || start > maximum || end < 0 || end > maximum) {
    throw new RangeError(`${label}.start and ${label}.end must be from 0 to ${byLength ? 'the curve length' : '1'}.`);
  }
  if (end <= start) throw new RangeError(`${label}.end must be greater than ${label}.start. Pass a range such as { "start": 0, "end": 0.5 }.`);
  return { start, end, length: byLength };
}

function weightsFrom(input, count, label) {
  if (input === undefined) return Array(count).fill(1);
  if (!Array.isArray(input) || input.length !== count) throw new RangeError(`${label} needs one weight per point (${count}).`);
  return input.map(weight => {
    finite(weight, label);
    if (weight <= 0 || weight > 1e6) throw new RangeError(`${label} must be greater than 0 and at most 1000000.`);
    return weight;
  });
}

// One spline: points or a primitive shape, a type (bezier, poly, nurbs), closed, NURBS weights and a trim.
function splineFrom(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${label} must be an object with points or shape.`);
  for (const key of Object.keys(input)) {
    if (!SPLINE_FIELDS.includes(key)) throw new TypeError(`Unknown ${label} field: ${key}. Use ${SPLINE_FIELDS.join(', ')}.`);
  }
  if ((input.points === undefined) === (input.shape === undefined)) throw new TypeError(`${label} needs exactly one of points or shape.`);
  let { points, closed = false, kind = 'bezier' } = input;
  if (input.shape !== undefined) {
    if (input.closed !== undefined || input.kind !== undefined) throw new TypeError(`${label}.closed and ${label}.kind come from shape. Remove them.`);
    ({ points, closed, type: kind } = shapeToSpline(input.shape));
  }
  if (typeof closed !== 'boolean') throw new RangeError('radius must be positive and closed must be boolean.');
  if (!SPLINE_TYPES.includes(kind)) throw new RangeError(`${label}.kind must be one of ${SPLINE_TYPES.join(', ')}.`);
  if (!Array.isArray(points) || points.length < (closed ? 3 : 2) || points.length > MAX_CURVE_POINTS) {
    throw new RangeError(`${label === 'points' ? 'points' : `${label}.points`} needs ${closed ? 3 : 2} to ${MAX_CURVE_POINTS} entries.`);
  }
  if (kind !== 'nurbs' && input.weights !== undefined) throw new TypeError(`${label}.weights apply to kind nurbs only.`);
  const resolved = kind === 'bezier' ? points.map(knotFrom) : points.map(point => vectorFrom(point, 'point'));
  const weights = kind === 'nurbs' ? weightsFrom(input.weights, points.length, `${label}.weights`) : undefined;
  return { type: kind, closed, points: resolved, weights, trim: trimFrom(input.trim, `${label}.trim`) };
}

function joinSweeps(parts) {
  if (parts.length === 1) return parts[0];
  const vertexTotal = parts.reduce((sum, part) => sum + part.positions.length / 3, 0);
  const indexTotal = parts.reduce((sum, part) => sum + part.indices.length, 0);
  const joined = {
    positions: new Float32Array(vertexTotal * 3),
    normals: new Float32Array(vertexTotal * 3),
    uvs: new Float32Array(vertexTotal * 2),
    indices: new Uint32Array(indexTotal),
  };
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const part of parts) {
    joined.positions.set(part.positions, vertexOffset * 3);
    joined.normals.set(part.normals, vertexOffset * 3);
    joined.uvs.set(part.uvs, vertexOffset * 2);
    part.indices.forEach((vertex, index) => {
      joined.indices[indexOffset + index] = vertex + vertexOffset;
    });
    vertexOffset += part.positions.length / 3;
    indexOffset += part.indices.length;
  }
  return joined;
}

/**
 * Sweep a round or custom profile along one or more splines. A spline is { points | shape, closed, kind, weights,
 * trim }: kind is bezier (default), poly or nurbs; shape is an arc, spiral or star; trim cuts an arc-length range.
 * The splines share radius, taper, profile and resolution and become one mesh.
 */
export function curveSet(splines, options = {}, labelFirst = 'splines[0]') {
  const { maxVertices = DEFAULT_VERTEX_LIMIT } = options;
  const plan = planCurveSet(splines, options, labelFirst);
  checkBudget(plan.vertexCount, maxVertices);
  const { resolved, radius, profilePoints, taperFactors, radialSegments, resolution } = plan;
  const parts = resolved.map(spline => {
    let samples = sampleSpline(spline, resolution);
    let closed = spline.closed;
    if (spline.trim) {
      samples = trimSamples(samples, closed, spline.trim);
      closed = false;
    }
    return sweepSamples({ ...samples, closed, radius, taper: taperFactors, profile: profilePoints, radialSegments });
  });
  return meshFrom(joinSweeps(parts), maxVertices);
}

/** Validates curveSet input and returns the vertex count it would build, without building it. */
export function curveSetVertexCount(splines, options = {}) {
  return planCurveSet(splines, options, 'splines[0]').vertexCount;
}

function planCurveSet(splines, {
  radius = 0.05, taper, profile, resolution = 12, radialSegments = 8,
}, labelFirst, growing = false) {
  radius = finite(radius, 'radius');
  if (radius <= 0) throw new RangeError('radius must be positive and closed must be boolean.');
  integer(resolution, 1, 64, 'resolution');
  integer(radialSegments, 3, 128, 'radialSegments');
  if (!Array.isArray(splines) || splines.length < 1 || splines.length > MAX_SPLINES) throw new RangeError(`splines needs 1 to ${MAX_SPLINES} entries.`);
  const resolved = splines.map((spline, index) => splineFrom(spline, index === 0 ? labelFirst : `splines[${index}]`));
  const totalPoints = resolved.reduce((sum, spline) => sum + spline.points.length, 0);
  if (totalPoints > MAX_TOTAL_CURVE_POINTS) throw new RangeError(`splines hold ${totalPoints} points in all; at most ${MAX_TOTAL_CURVE_POINTS}. Remove points or splines.`);
  const profilePoints = profile === undefined ? null : pointsFrom(profile, 2, 3, 'profile');
  if (profilePoints && profilePoints.length > 256) throw new RangeError('profile needs 3 to 256 points.');
  const sides = profilePoints ? profilePoints.length : radialSegments;
  const taperFactors = taperFrom(taper);
  const vertexCount = resolved.reduce((sum, spline) => {
    const samples = sampleCountOf(spline, resolution);
    // A growing curve sweeps every state open, with the ring count of growthState and caps, trim or not.
    const trimmed = Boolean(spline.trim) || growing;
    const extraRings = growing ? (spline.closed ? 1 : 0) : (spline.trim ? 3 : (spline.closed ? 1 : 0));
    const rings = samples + extraRings;
    return sum + rings * sides * 2 + (spline.closed && !trimmed ? 0 : 2 * (sides + 1));
  }, 0);
  return { resolved, vertexCount, radius, profilePoints, taperFactors, radialSegments, resolution };
}

const SINGLE_SPLINE_FIELDS = ['points', 'shape', 'closed', 'kind', 'weights', 'trim'];

// The scene geometry `curve` holds one spline in its own fields, or several in `splines`.
function splinesOfGeometry(value) {
  if (value.splines === undefined) {
    const spline = Object.fromEntries(SINGLE_SPLINE_FIELDS.map(key => [key, value[key]]));
    return { splines: [spline], label: 'points' };
  }
  for (const key of SINGLE_SPLINE_FIELDS) {
    if (value[key] !== undefined) throw new TypeError(`${key} cannot be used with splines. Put ${key} inside a splines entry.`);
  }
  return { splines: value.splines, label: 'splines[0]' };
}

/** The curve scene geometry: points, a shape or splines, with the shared sweep options and an optional growth. */
export function curveGeometry(value, maxVertices) {
  const { splines, label } = splinesOfGeometry(value);
  if (value.grow !== undefined) return growingCurve(splines, { ...value, maxVertices }, label);
  return curveSet(splines, { ...value, maxVertices }, label);
}

const GROW_FIELDS = ['name', 'steps', 'value'];
const MAX_GROW_STEPS = 16;
const MAX_GROW_MORPH_VERTICES = 2000000;
// The smallest fraction a growing curve starts from, so its first state still has a length to sweep.
const MINIMUM_GROWTH = 0.01;

/** Validates the grow field of a curve geometry: { name, steps, value } with the defaults filled in. */
export function growFrom(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('grow must be an object such as { "name": "vine", "steps": 8 }.');
  for (const key of Object.keys(input)) {
    if (!GROW_FIELDS.includes(key)) throw new TypeError(`Unknown grow field: ${key}. Use ${GROW_FIELDS.join(', ')}.`);
  }
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 64) throw new TypeError('grow.name must be 1 to 64 characters, such as "vine". A motion track { kind: "morph", id: <name>, property: "weight" } animates it.');
  const steps = input.steps ?? 8;
  integer(steps, 2, MAX_GROW_STEPS, 'grow.steps');
  const value = finite(input.value ?? 1, 'grow.value');
  if (value < 0 || value > 1) throw new RangeError('grow.value must be from 0 to 1 (0 is a bare root, 1 the whole curve).');
  return { name: input.name, steps, value };
}

// One sweep of every spline grown to `fraction` of its trim range, resampled to the full-curve ring count so all
// states share one topology.
function growthState(plan, fraction) {
  const { resolved, radius, profilePoints, taperFactors, radialSegments, resolution } = plan;
  const parts = resolved.map(spline => {
    if (spline.trim?.length) throw new TypeError('grow works with a trim in factors (length false), not lengths. Remove trim.length.');
    const start = spline.trim?.start ?? 0;
    const end = start + ((spline.trim?.end ?? 1) - start) * fraction;
    const ringCount = Math.max(2, sampleCountOf(spline, resolution) + (spline.closed ? 1 : 0));
    const samples = resampleSamples(trimSamples(sampleSpline(spline, resolution), spline.closed, { start, end }), ringCount);
    return sweepSamples({ ...samples, closed: false, radius, taper: taperFactors, profile: profilePoints, radialSegments });
  });
  return joinSweeps(parts);
}

// A curve that grows: the bare root is the geometry and each step is a morph target holding the curve at that
// length. The motion weight 0 to 1 of grow.name blends two neighbouring steps, so seeking equals playing.
function growingCurve(splines, options, label) {
  const grow = growFrom(options.grow);
  const plan = planCurveSet(splines, options, label, true);
  if (plan.vertexCount * grow.steps > MAX_GROW_MORPH_VERTICES) {
    throw new RangeError(`grow needs ${plan.vertexCount * grow.steps} morph vertices; at most ${MAX_GROW_MORPH_VERTICES}. Lower grow.steps, resolution or radialSegments.`);
  }
  const maximum = options.maxVertices ?? DEFAULT_VERTEX_LIMIT;
  const base = meshFrom(growthState(plan, MINIMUM_GROWTH), maximum);
  base.morphTargets = Array.from({ length: grow.steps }, (_, index) => {
    const state = meshFrom(growthState(plan, Math.max((index + 1) / grow.steps, MINIMUM_GROWTH)), maximum);
    return {
      positions: state.positions.map((position, offset) => position - base.positions[offset]),
      normals: state.normals.map((normal, offset) => normal - base.normals[offset]),
    };
  });
  base.morphTargetNames = base.morphTargets.map((_, index) => `${grow.name}#${index + 1}`);
  base.morphTargetValues = Float32Array.from(growthWeights(grow.steps, grow.value));
  base.morphGrowth = Object.freeze(grow);
  return base;
}

/** Weights of the growth steps at a growth from 0 to 1: the two steps around it share the weight, the others are 0. */
export function growthWeights(steps, growth) {
  const position = Math.min(Math.max(growth, 0), 1) * steps;
  return Array.from({ length: steps }, (_, index) => Math.max(0, 1 - Math.abs(position - (index + 1))));
}

/** The vertex count of a curve scene geometry, validated like curveGeometry. */
export function curveGeometryVertexCount(value) {
  const { splines, label } = splinesOfGeometry(value);
  if (value.grow !== undefined) growFrom(value.grow);
  return planCurveSet(splines, value, label, value.grow !== undefined).vertexCount;
}

/**
 * Sweep a round or custom profile along a curve: cubic Bezier by default (points are [x, y, z] with smooth automatic
 * handles, or { position, handleIn, handleOut } with absolute handle positions), or kind poly or nurbs. `taper` lists
 * radius factors spread along the length. For several splines or a primitive shape see curveSet.
 */
export function curve(points, {
  closed = false, kind, weights, trim, radius, taper, profile, resolution, radialSegments, maxVertices,
} = {}) {
  return curveSet([{ points, closed, kind, weights, trim }], { radius, taper, profile, resolution, radialSegments, maxVertices }, 'points');
}

/** Sweep a circular tube along a centripetal Catmull-Rom curve. */
export function tube(path, {
  radius = 0.1, segments = 64, radialSegments = 12, closed = false,
  maxVertices = DEFAULT_VERTEX_LIMIT,
} = {}) {
  radius = finite(radius, 'radius');
  if (radius <= 0 || typeof closed !== 'boolean') throw new RangeError('radius must be positive and closed must be boolean.');
  integer(segments, 3, 2048, 'segments');
  integer(radialSegments, 3, 128, 'radialSegments');
  const points = pointsFrom(path, 3, closed ? 3 : 2, 'path');
  if (closed && points[0].every((value, axis) => value === points.at(-1)[axis])) points.pop();
  if (points.length < (closed ? 3 : 2)) throw new RangeError('The path has too few distinct points.');
  checkBudget((segments + 1) * (radialSegments + 1), maxVertices);
  return meshFrom(buildTube(points, closed, radius, segments, radialSegments), maxVertices);
}

/** The sdf scene geometry: signed-distance shapes meshed by surface nets. See docs/modeling.md. */
export function sdfGeometry(value, maxVertices = DEFAULT_VERTEX_LIMIT) {
  planSdf(value);
  return meshFrom(buildSdf(value), maxVertices);
}

/** The vertex count reserved for an sdf geometry, validated like sdfGeometry. */
export { sdfVertexEstimate } from './modeling-sdf.js';
