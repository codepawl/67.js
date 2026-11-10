// Spline sources for the curve geometry: arc, spiral and star primitives, poly and NURBS splines, and trimming.
// Every function is deterministic and returns plain arrays; modeling.js validates the public input first.
import { fillZeroTangents, resolveHandles, sampleBezierSpans } from './modeling-bezier.js';

const TWO_PI = Math.PI * 2;
export const NURBS_DEFAULT_ORDER = 4;
export const NURBS_MAX_ORDER = 8;
export const KNOT_MODES = ['clamped', 'uniform'];
const DERIVATIVE_STEP = 1e-5;
const MINIMUM_SEGMENT = 1e-9;

export const SHAPE_TYPES = ['arc', 'spiral', 'star'];

function number(value, fallback, name, minimum, maximum) {
  const result = value === undefined ? fallback : value;
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new RangeError(`${name} must be a number from ${minimum} to ${maximum}, such as ${fallback}.`);
  }
  return result;
}

function whole(value, fallback, name, minimum, maximum) {
  const result = value === undefined ? fallback : value;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}, such as ${fallback}.`);
  }
  return result;
}

function knownFields(shape, allowed) {
  for (const key of Object.keys(shape)) {
    if (!allowed.includes(key)) throw new TypeError(`Unknown shape field: ${key}. Use ${allowed.join(', ')}.`);
  }
}

// Exact quarter-turn style Bezier arc: the handle length is 4/3 tan(sweep / 4) times the radius.
function arcSpline(shape) {
  knownFields(shape, ['type', 'radius', 'startAngle', 'sweep', 'segments']);
  const radius = number(shape.radius, 1, 'shape.radius', 1e-6, 1e6);
  const startAngle = number(shape.startAngle, 0, 'shape.startAngle', -1e4, 1e4);
  const sweep = number(shape.sweep, Math.PI, 'shape.sweep', -TWO_PI, TWO_PI);
  const segments = whole(shape.segments, 8, 'shape.segments', 1, 256);
  if (Math.abs(sweep) < 1e-6) throw new RangeError('shape.sweep must not be 0. Pass an angle in radians such as 3.14.');
  const closed = Math.abs(Math.abs(sweep) - TWO_PI) < 1e-9;
  const step = sweep / segments;
  const handleLength = 4 / 3 * Math.tan(step / 4) * radius;
  const knotCount = closed ? segments : segments + 1;
  const points = Array.from({ length: knotCount }, (_, index) => {
    const angle = startAngle + step * index;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const position = [radius * cosine, radius * sine, 0];
    const tangent = [-sine * handleLength, cosine * handleLength, 0];
    return {
      position,
      handleIn: [position[0] - tangent[0], position[1] - tangent[1], 0],
      handleOut: [position[0] + tangent[0], position[1] + tangent[1], 0],
    };
  });
  return { type: 'bezier', closed, points };
}

// A rising helix of radius from startRadius to endRadius, smooth through its points.
function spiralSpline(shape) {
  knownFields(shape, ['type', 'rotations', 'startRadius', 'endRadius', 'height', 'pointsPerRotation', 'reverse']);
  const rotations = number(shape.rotations, 2, 'shape.rotations', 0.05, 64);
  const startRadius = number(shape.startRadius, 1, 'shape.startRadius', 0, 1e6);
  const endRadius = number(shape.endRadius, 1, 'shape.endRadius', 0, 1e6);
  const height = number(shape.height, 2, 'shape.height', -1e6, 1e6);
  const pointsPerRotation = whole(shape.pointsPerRotation, 12, 'shape.pointsPerRotation', 3, 128);
  if (shape.reverse !== undefined && typeof shape.reverse !== 'boolean') throw new TypeError('shape.reverse must be true or false.');
  const segments = Math.max(1, Math.ceil(rotations * pointsPerRotation));
  if (segments + 1 > 1024) throw new RangeError('The spiral needs at most 1024 points. Lower shape.rotations or shape.pointsPerRotation.');
  const direction = shape.reverse ? -1 : 1;
  const points = Array.from({ length: segments + 1 }, (_, index) => {
    const fraction = index / segments;
    const angle = direction * TWO_PI * rotations * fraction;
    const radius = startRadius + (endRadius - startRadius) * fraction;
    return [radius * Math.cos(angle), radius * Math.sin(angle), height * fraction];
  });
  return { type: 'bezier', closed: false, points };
}

// A closed poly star; innerTwist (radians) turns the inner vertices against the outer ones.
function starSpline(shape) {
  knownFields(shape, ['type', 'points', 'innerRadius', 'outerRadius', 'innerTwist']);
  const count = whole(shape.points, 5, 'shape.points', 3, 256);
  const innerRadius = number(shape.innerRadius, 0.5, 'shape.innerRadius', 1e-6, 1e6);
  const outerRadius = number(shape.outerRadius, 1, 'shape.outerRadius', 1e-6, 1e6);
  const twist = number(shape.innerTwist, 0, 'shape.innerTwist', -TWO_PI, TWO_PI);
  const points = [];
  for (let index = 0; index < count; index++) {
    const outerAngle = TWO_PI * index / count;
    const innerAngle = outerAngle + Math.PI / count + twist;
    points.push([outerRadius * Math.cos(outerAngle), outerRadius * Math.sin(outerAngle), 0]);
    points.push([innerRadius * Math.cos(innerAngle), innerRadius * Math.sin(innerAngle), 0]);
  }
  return { type: 'poly', closed: true, points };
}

/** A primitive shape as a spline: `{ type: 'bezier' | 'poly', closed, points }`, in the XY plane. */
export function shapeToSpline(shape) {
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) throw new TypeError(`shape must be an object with type ${SHAPE_TYPES.join(', ')}.`);
  if (shape.type === 'arc') return arcSpline(shape);
  if (shape.type === 'spiral') return spiralSpline(shape);
  if (shape.type === 'star') return starSpline(shape);
  throw new RangeError(`shape.type must be one of ${SHAPE_TYPES.join(', ')}, not ${JSON.stringify(shape.type)}.`);
}

function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function unitOrNull(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length > MINIMUM_SEGMENT ? [vector[0] / length, vector[1] / length, vector[2] / length] : null;
}

/** Straight segments between the points; a corner takes the direction of the segment that leaves it. */
function samplePoly(points, closed) {
  const count = points.length;
  const tangents = points.map((point, index) => {
    const isLastOfOpen = index === count - 1 && !closed;
    const direction = isLastOfOpen ? subtract(point, points[index - 1]) : subtract(points[(index + 1) % count], point);
    return unitOrNull(direction);
  });
  return { points, tangents: fillZeroTangents(points, tangents, closed) };
}

// Clamped (open, the default), uniform (open, not touching the end points) or periodic (closed) knot vector for a
// B-spline of the given order over `count` control points.
function knotVector(count, order, closed, knotMode = 'clamped') {
  const total = count + order;
  if (closed || knotMode === 'uniform') return Array.from({ length: total }, (_, index) => index);
  return Array.from({ length: total }, (_, index) => Math.min(Math.max(index - order + 1, 0), count - order + 1));
}

function findSpan(count, order, parameter, knots) {
  const degree = order - 1;
  if (parameter >= knots[count]) return count - 1;
  let span = degree;
  while (span < count - 1 && parameter >= knots[span + 1]) span++;
  return span;
}

// Cox-de Boor: the `order` basis values that are not zero at the parameter, starting at index span - degree.
function basisValues(span, parameter, knots, order) {
  const degree = order - 1;
  const values = [1];
  const left = [];
  const right = [];
  for (let level = 1; level <= degree; level++) {
    left[level] = parameter - knots[span + 1 - level];
    right[level] = knots[span + level] - parameter;
    let saved = 0;
    for (let index = 0; index < level; index++) {
      const denominator = right[index + 1] + left[level - index];
      const term = denominator === 0 ? 0 : values[index] / denominator;
      values[index] = saved + right[index + 1] * term;
      saved = left[level - index] * term;
    }
    values[level] = saved;
  }
  return values;
}

function nurbsPoint(controls, weights, knots, order, parameter) {
  const count = controls.length;
  const span = findSpan(count, order, parameter, knots);
  const values = basisValues(span, parameter, knots, order);
  const sum = [0, 0, 0];
  let weightSum = 0;
  values.forEach((value, offset) => {
    const index = span - (order - 1) + offset;
    const weighted = value * weights[index];
    weightSum += weighted;
    for (let axis = 0; axis < 3; axis++) sum[axis] += weighted * controls[index][axis];
  });
  return sum.map(component => component / weightSum);
}

/**
 * NURBS of `options.order` (default 4, or the point count when lower). An open spline uses `options.knots` (one
 * non-decreasing value per control point plus the order) or a `knotMode`: `clamped` starts and ends on the first and
 * last control point, `uniform` does not. A closed one is periodic. `resolution` samples per control point span.
 */
export function sampleNurbs(controlPoints, weights, closed, resolution, options = {}) {
  const order = Math.min(options.order ?? NURBS_DEFAULT_ORDER, controlPoints.length);
  const wrap = closed ? order - 1 : 0;
  const controls = [...controlPoints, ...controlPoints.slice(0, wrap)];
  const controlWeights = [...weights, ...weights.slice(0, wrap)];
  const knots = options.knots ?? knotVector(controls.length, order, closed, options.knotMode);
  const start = knots[order - 1];
  const end = knots[controls.length];
  const spans = closed ? controlPoints.length : controlPoints.length - 1;
  const sampleCount = closed ? spans * resolution : spans * resolution + 1;
  const parameterAt = index => start + (end - start) * index / (spans * resolution);
  const evaluate = parameter => nurbsPoint(controls, controlWeights, knots, order, Math.min(Math.max(parameter, start), end));
  const points = Array.from({ length: sampleCount }, (_, index) => evaluate(parameterAt(index)));
  const step = DERIVATIVE_STEP * (end - start);
  const tangents = Array.from({ length: sampleCount }, (_, index) => {
    const parameter = parameterAt(index);
    const before = closed ? evaluate(start + ((parameter - step - start + (end - start)) % (end - start))) : evaluate(parameter - step);
    const after = closed ? evaluate(start + ((parameter + step - start) % (end - start))) : evaluate(parameter + step);
    return unitOrNull(subtract(after, before));
  });
  return { points, tangents: fillZeroTangents(points, tangents, closed) };
}

/** Points and unit tangents of a resolved spline `{ type, closed, points, weights }`. */
export function sampleSpline(spline, resolution) {
  if (spline.type === 'poly') return samplePoly(spline.points, spline.closed);
  if (spline.type === 'nurbs') return sampleNurbs(spline.points, spline.weights, spline.closed, resolution, spline.basis);
  return sampleBezierSpans(resolveHandles(spline.points, spline.closed), spline.closed, resolution);
}

function lerp(first, second, weight) {
  return first.map((value, axis) => value + (second[axis] - value) * weight);
}

/** The vertex count a spline of this kind and size samples to, trimmed or not, before any budget check. */
export function sampleCountOf(spline, resolution) {
  const count = spline.points.length;
  if (spline.type === 'poly') return count;
  const spans = spline.closed ? count : count - 1;
  return spans * resolution + (spline.closed ? 0 : 1);
}

/**
 * Cuts samples to the arc-length range [start, end] (factors of the length, or lengths when `byLength`). The result is
 * open. A range that covers a whole open curve returns it unchanged. Lengths past the curve are clamped to it.
 */
export function trimSamples(samples, closed, { start = 0, end = 1, length: byLength = false }) {
  const loop = closed ? [...samples.points, samples.points[0]] : samples.points;
  const loopTangents = closed ? [...samples.tangents, samples.tangents[0]] : samples.tangents;
  const distances = [0];
  for (let index = 1; index < loop.length; index++) {
    const segment = subtract(loop[index], loop[index - 1]);
    distances.push(distances[index - 1] + Math.hypot(segment[0], segment[1], segment[2]));
  }
  const total = distances.at(-1);
  const from = Math.min(byLength ? start : start * total, total);
  const to = Math.min(byLength ? end : end * total, total);
  if (to - from <= MINIMUM_SEGMENT * Math.max(total, 1)) {
    throw new RangeError('trim leaves no curve. Pass trim.end greater than trim.start, within the curve length.');
  }
  if (!closed && from <= 0 && to >= total) return samples;
  const points = [];
  const tangents = [];
  const place = distance => {
    let upper = distances.findIndex(value => value >= distance);
    if (upper <= 0) upper = 1;
    const weight = (distance - distances[upper - 1]) / ((distances[upper] - distances[upper - 1]) || 1);
    points.push(lerp(loop[upper - 1], loop[upper], weight));
    tangents.push(unitOrNull(lerp(loopTangents[upper - 1], loopTangents[upper], weight)) ?? loopTangents[upper]);
  };
  place(from);
  for (let index = 0; index < loop.length; index++) {
    if (distances[index] > from + MINIMUM_SEGMENT && distances[index] < to - MINIMUM_SEGMENT) {
      points.push(loop[index]);
      tangents.push(loopTangents[index]);
    }
  }
  place(to);
  return { points, tangents };
}

/** Spreads `count` samples evenly by arc length along an open curve, so curves of any length share one topology. */
export function resampleSamples(samples, count) {
  const { points, tangents } = samples;
  const distances = [0];
  for (let index = 1; index < points.length; index++) {
    const segment = subtract(points[index], points[index - 1]);
    distances.push(distances[index - 1] + Math.hypot(segment[0], segment[1], segment[2]));
  }
  const total = distances.at(-1);
  const resampled = { points: [], tangents: [] };
  let upper = 1;
  for (let index = 0; index < count; index++) {
    const distance = total * index / (count - 1);
    while (upper < points.length - 1 && distances[upper] < distance) upper++;
    const span = distances[upper] - distances[upper - 1];
    const weight = span > 0 ? Math.min(Math.max((distance - distances[upper - 1]) / span, 0), 1) : 0;
    resampled.points.push(lerp(points[upper - 1], points[upper], weight));
    resampled.tangents.push(unitOrNull(lerp(tangents[upper - 1], tangents[upper], weight)) ?? tangents[upper]);
  }
  return resampled;
}
