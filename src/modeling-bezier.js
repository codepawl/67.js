// Bezier curve sweep: a chain of cubic Bezier spans with explicit or automatic handles, swept with a round or custom
// profile that can taper along the curve. The ring frames use the minimum-twist transport of the tube generator.
import { transportFrames } from './modeling-curve.js';

const SMOOTH_NORMAL_COSINE = Math.cos(40 * Math.PI / 180);
const ZERO_LENGTH = 1e-12;

function add(first, second) {
  return [first[0] + second[0], first[1] + second[1], first[2] + second[2]];
}

function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function scale(vector, factor) {
  return [vector[0] * factor, vector[1] * factor, vector[2] * factor];
}

function lengthOf(vector) {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

/** Fills every missing handle: a lone handle is mirrored, a knot with none gets a smooth handle along its neighbours. */
export function resolveHandles(knots, closed) {
  const count = knots.length;
  return knots.map((knot, index) => {
    const previous = knots[closed ? (index + count - 1) % count : Math.max(index - 1, 0)].position;
    const next = knots[closed ? (index + 1) % count : Math.min(index + 1, count - 1)].position;
    const interior = closed || (index > 0 && index < count - 1);
    const direction = interior ? scale(subtract(next, previous), 1 / 6) : null;
    let handleOut = knot.handleOut;
    let handleIn = knot.handleIn;
    if (!handleOut && handleIn) handleOut = subtract(scale(knot.position, 2), handleIn);
    if (!handleIn && handleOut) handleIn = subtract(scale(knot.position, 2), handleOut);
    if (!handleOut) {
      handleOut = direction ? add(knot.position, direction) : add(knot.position, scale(subtract(next, knot.position), 1 / 3));
      handleIn = direction ? subtract(knot.position, direction) : add(knot.position, scale(subtract(previous, knot.position), 1 / 3));
    }
    return { position: knot.position, handleIn, handleOut };
  });
}

function cubicPoint(start, controlStart, controlEnd, end, parameter) {
  const remainder = 1 - parameter;
  const weights = [remainder ** 3, 3 * remainder * remainder * parameter, 3 * remainder * parameter * parameter, parameter ** 3];
  return [0, 1, 2].map(axis => weights[0] * start[axis] + weights[1] * controlStart[axis] + weights[2] * controlEnd[axis] + weights[3] * end[axis]);
}

function cubicDerivative(start, controlStart, controlEnd, end, parameter) {
  const remainder = 1 - parameter;
  return [0, 1, 2].map(axis => 3 * (
    remainder * remainder * (controlStart[axis] - start[axis]) +
    2 * remainder * parameter * (controlEnd[axis] - controlStart[axis]) +
    parameter * parameter * (end[axis] - controlEnd[axis])
  ));
}

/** Points and unit tangents along the spans, `resolution` per span. A closed curve does not repeat its first sample. */
export function sampleBezierSpans(handles, closed, resolution) {
  const spans = closed ? handles.length : handles.length - 1;
  const points = [];
  const tangents = [];
  for (let span = 0; span < spans; span++) {
    const from = handles[span];
    const to = handles[(span + 1) % handles.length];
    for (let step = 0; step < resolution; step++) {
      const parameter = step / resolution;
      points.push(cubicPoint(from.position, from.handleOut, to.handleIn, to.position, parameter));
      tangents.push(cubicDerivative(from.position, from.handleOut, to.handleIn, to.position, parameter));
    }
  }
  if (!closed) {
    const from = handles.at(-2);
    const to = handles.at(-1);
    points.push(to.position);
    tangents.push(cubicDerivative(from.position, from.handleOut, to.handleIn, to.position, 1));
  }
  return { points, tangents: fillZeroTangents(points, tangents, closed) };
}

// A handle that sits on its knot makes the derivative zero there; the chord to a neighbour stands in.
export function fillZeroTangents(points, tangents, closed) {
  const count = points.length;
  const unit = tangents.map(tangent => {
    const length = lengthOf(tangent);
    return length > ZERO_LENGTH ? scale(tangent, 1 / length) : null;
  });
  return unit.map((tangent, index) => {
    if (tangent) return tangent;
    for (let offset = 1; offset < count; offset++) {
      const neighbour = closed ? (index + offset) % count : index + offset;
      if (neighbour >= count) break;
      const chord = subtract(points[neighbour], points[index]);
      const length = lengthOf(chord);
      if (length > ZERO_LENGTH) return scale(chord, 1 / length);
    }
    throw new RangeError('The curve has no length. Move its points apart.');
  });
}

function circleProfile(sides) {
  return Array.from({ length: sides }, (_, side) => {
    const angle = side / sides * Math.PI * 2;
    return [-Math.cos(angle), Math.sin(angle)];
  });
}

function signedArea(profile) {
  let area = 0;
  for (let index = 0; index < profile.length; index++) {
    const next = profile[(index + 1) % profile.length];
    area += profile[index][0] * next[1] - next[0] * profile[index][1];
  }
  return area;
}

/** Profile points counter-clockwise, with the flat normal of each edge and a smoothed normal at each corner. */
function profileEdges(profile) {
  const ordered = signedArea(profile) < 0 ? [...profile].reverse() : profile;
  const edgeNormals = ordered.map((point, index) => {
    const next = ordered[(index + 1) % ordered.length];
    const dx = next[0] - point[0];
    const dy = next[1] - point[1];
    const length = Math.hypot(dx, dy);
    if (length === 0) throw new RangeError('The profile cannot repeat a point.');
    return [dy / length, -dx / length];
  });
  const cornerNormal = (before, after) => {
    const cosine = before[0] * after[0] + before[1] * after[1];
    if (cosine < SMOOTH_NORMAL_COSINE) return null;
    const sum = [before[0] + after[0], before[1] + after[1]];
    const length = Math.hypot(sum[0], sum[1]);
    return [sum[0] / length, sum[1] / length];
  };
  return ordered.map((point, index) => {
    const next = (index + 1) % ordered.length;
    const before = edgeNormals[(index + ordered.length - 1) % ordered.length];
    const after = edgeNormals[index];
    const following = edgeNormals[next];
    return {
      start: ordered[index],
      end: ordered[next],
      startNormal: cornerNormal(before, after) ?? after,
      endNormal: cornerNormal(after, following) ?? after,
    };
  });
}

function taperAt(taper, fraction) {
  if (!taper) return 1;
  const position = fraction * (taper.length - 1);
  const lower = Math.min(Math.floor(position), taper.length - 2);
  const weight = position - lower;
  return taper[lower] * (1 - weight) + taper[lower + 1] * weight;
}

/**
 * Sweeps the profile along the sampled curve. `profile` is a list of 2D points, or null for a round profile of
 * `radialSegments` sides. Open curves get flat caps.
 */
export function buildBezierSweep({ handles, closed, radius, taper, profile, resolution, radialSegments }) {
  const { points, tangents } = sampleBezierSpans(handles, closed, resolution);
  return sweepSamples({ points, tangents, closed, radius, taper, profile, radialSegments });
}

/** The sweep of buildBezierSweep along any samples: points with unit tangents, a closed curve not repeating its first point. */
export function sweepSamples({ points, tangents, closed, radius, taper, profile, radialSegments }) {
  const count = points.length;
  const frames = transportFrames(closed ? [...tangents, tangents[0]] : tangents, closed);
  const distances = [0];
  for (let index = 1; index < count; index++) distances.push(distances[index - 1] + lengthOf(subtract(points[index], points[index - 1])));
  const totalLength = closed ? distances[count - 1] + lengthOf(subtract(points[0], points[count - 1])) : distances[count - 1];
  const edges = profileEdges(profile ?? circleProfile(radialSegments));
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const ringCount = closed ? count + 1 : count;
  const verticesPerRing = edges.length * 2;
  for (let ring = 0; ring < ringCount; ring++) {
    const source = ring % count;
    const { normal, binormal } = frames[source];
    const fraction = totalLength > 0 ? distances[source] / totalLength : 0;
    const along = ring === count ? 1 : fraction;
    const size = radius * taperAt(taper, fraction);
    const place = (planar, planarNormal, edgeFraction) => {
      for (let axis = 0; axis < 3; axis++) {
        positions.push(points[source][axis] + size * (planar[0] * normal[axis] + planar[1] * binormal[axis]));
        normals.push(planarNormal[0] * normal[axis] + planarNormal[1] * binormal[axis]);
      }
      uvs.push(along, edgeFraction);
    };
    edges.forEach((edge, index) => {
      place(edge.start, edge.startNormal, index / edges.length);
      place(edge.end, edge.endNormal, (index + 1) / edges.length);
    });
  }
  for (let ring = 1; ring < ringCount; ring++) {
    for (let edge = 0; edge < edges.length; edge++) {
      const a = (ring - 1) * verticesPerRing + edge * 2;
      const b = ring * verticesPerRing + edge * 2;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  if (!closed) {
    addCap(positions, normals, uvs, indices, { ring: 0, tangent: scale(tangents[0], -1), flip: true, ...capContext(edges, frames, points, radius, taper, 0) });
    addCap(positions, normals, uvs, indices, { ring: count - 1, tangent: tangents[count - 1], flip: false, ...capContext(edges, frames, points, radius, taper, 1) });
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) };
}

function capContext(edges, frames, points, radius, taper, fraction) {
  const index = fraction === 0 ? 0 : points.length - 1;
  return { edges, frame: frames[index], center: points[index], size: radius * taperAt(taper, fraction) };
}

// A fan from the profile centre, with its own vertices so the cap edge stays sharp.
function addCap(positions, normals, uvs, indices, { tangent, flip, edges, frame, center, size }) {
  const first = positions.length / 3;
  const average = edges.reduce((sum, edge) => [sum[0] + edge.start[0], sum[1] + edge.start[1]], [0, 0]).map(value => value / edges.length);
  const extent = Math.max(...edges.map(edge => Math.hypot(edge.start[0], edge.start[1]))) || 1;
  const place = planar => {
    for (let axis = 0; axis < 3; axis++) {
      positions.push(center[axis] + size * (planar[0] * frame.normal[axis] + planar[1] * frame.binormal[axis]));
      normals.push(tangent[axis]);
    }
    uvs.push(0.5 + planar[0] * 0.5 / extent, 0.5 + planar[1] * 0.5 / extent);
  };
  place(average);
  edges.forEach(edge => place(edge.start));
  for (let index = 0; index < edges.length; index++) {
    const current = first + 1 + index;
    const next = first + 1 + (index + 1) % edges.length;
    if (flip) indices.push(first, next, current);
    else indices.push(first, current, next);
  }
}
