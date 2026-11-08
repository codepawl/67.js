// Polyline curves as plain arrays of [x, y, z]: fillet rounds the corners with circular arcs and resample places points
// at equal arc length with the direction of travel at each one. Both are deterministic and bounded.

export const MAX_CURVE_POINTS = 256;
export const MAX_FILLET_ARC_SEGMENTS = 16;
export const MAX_FILLETED_POINTS = 4096;
const MINIMUM_LENGTH = 1e-9;
const STRAIGHT_LIMIT = 1 - 1e-9;

function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function addScaled(base, direction, factor) {
  return [base[0] + direction[0] * factor, base[1] + direction[1] * factor, base[2] + direction[2] * factor];
}

function dot(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function lengthOf(vector) {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function unit(vector) {
  const length = lengthOf(vector);
  return length < MINIMUM_LENGTH ? [0, 0, 0] : [vector[0] / length, vector[1] / length, vector[2] / length];
}

/** The segments of a polyline as { from, to, length }; a closed curve ends with the segment back to the first point. */
function segmentsOf(points, closed) {
  const segments = [];
  const last = closed ? points.length : points.length - 1;
  for (let index = 0; index < last; index++) {
    const from = points[index];
    const to = points[(index + 1) % points.length];
    segments.push({ from, to, length: lengthOf(subtract(to, from)) });
  }
  return segments;
}

/** Total length of a polyline. */
export function curveLength(points, closed = false) {
  return segmentsOf(points, closed).reduce((total, segment) => total + segment.length, 0);
}

/**
 * `count` points at equal arc length along the polyline, each with the unit direction of the segment it lies on.
 * An open curve puts the first and last sample on its ends (count at least 2); a closed one spreads them around the loop.
 */
export function resampleCurve(points, count, closed = false) {
  const segments = segmentsOf(points, closed);
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (!(total > MINIMUM_LENGTH)) throw new RangeError('The curve has no length.');
  const step = closed ? total / count : total / (count - 1);
  const samples = [];
  let segmentIndex = 0;
  let segmentStart = 0;
  for (let sample = 0; sample < count; sample++) {
    const distance = sample * step;
    while (segmentIndex < segments.length - 1 && distance > segmentStart + segments[segmentIndex].length) {
      segmentStart += segments[segmentIndex].length;
      segmentIndex++;
    }
    const segment = segments[segmentIndex];
    const along = segment.length < MINIMUM_LENGTH ? 0 : Math.min(1, Math.max(0, (distance - segmentStart) / segment.length));
    samples.push({
      point: addScaled(segment.from, subtract(segment.to, segment.from), along),
      direction: unit(subtract(segment.to, segment.from)),
    });
  }
  return samples;
}

function filletCorner(previous, corner, next, radius, arcSegments) {
  const toPrevious = unit(subtract(previous, corner));
  const toNext = unit(subtract(next, corner));
  const cosine = dot(toPrevious, toNext);
  if (cosine <= -STRAIGHT_LIMIT || cosine >= STRAIGHT_LIMIT) return [corner];
  const halfAngle = Math.acos(cosine) / 2;
  // The arc may use at most half of each neighbouring segment, so two corners never fight over one segment.
  const room = Math.min(lengthOf(subtract(previous, corner)), lengthOf(subtract(next, corner))) / 2;
  const reach = Math.min(radius / Math.tan(halfAngle), room);
  const usedRadius = reach * Math.tan(halfAngle);
  const start = addScaled(corner, toPrevious, reach);
  const end = addScaled(corner, toNext, reach);
  const bisector = unit([toPrevious[0] + toNext[0], toPrevious[1] + toNext[1], toPrevious[2] + toNext[2]]);
  const center = addScaled(corner, bisector, usedRadius / Math.sin(halfAngle));
  const startArm = subtract(start, center);
  const endArm = subtract(end, center);
  const sweep = Math.acos(Math.min(1, Math.max(-1, dot(unit(startArm), unit(endArm)))));
  const arc = [];
  for (let step = 0; step <= arcSegments; step++) {
    const fraction = step / arcSegments;
    const weightStart = Math.sin((1 - fraction) * sweep) / Math.sin(sweep);
    const weightEnd = Math.sin(fraction * sweep) / Math.sin(sweep);
    arc.push([0, 1, 2].map(axis => center[axis] + startArm[axis] * weightStart + endArm[axis] * weightEnd));
  }
  return arc;
}

/**
 * Round every interior corner (every corner of a closed curve) with a circular arc of the given radius, drawn in
 * `arcSegments` straight pieces. A radius that does not fit between neighbouring corners is reduced to fit.
 */
export function filletCurve(points, radius, arcSegments, closed = false) {
  const result = [];
  const count = points.length;
  for (let index = 0; index < count; index++) {
    const isEnd = !closed && (index === 0 || index === count - 1);
    if (isEnd) {
      result.push(points[index]);
      continue;
    }
    const previous = points[(index + count - 1) % count];
    const next = points[(index + 1) % count];
    result.push(...filletCorner(previous, points[index], next, radius, arcSegments));
    if (result.length > MAX_FILLETED_POINTS) throw new RangeError(`Fillet makes more than ${MAX_FILLETED_POINTS} points; use fewer corners or arc segments.`);
  }
  return result;
}
