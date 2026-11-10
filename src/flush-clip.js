// Cuts away the part of a triangle that an opaque triangle on the same plane covers (issue #751). Two faces on one plane
// fight for every pixel they share; once the hidden one is gone there is nothing left to fight, at any depth precision and
// however deep the stack is. flush-resolve.js picks the pairs and the winner; this file does the cutting.
//
// Two rules keep the cut from showing. A cut stops a few float32 steps inside the winner, so the two faces overlap by a hair
// instead of meeting on a line that rounding could open. And a vertex a cut puts on an edge is given to every triangle on
// that edge, in this face and in the next one, so no edge has a vertex on one side only (a T-junction leaks single pixels).
import { float32Step } from './flush-search.js';

/** Numbers per cut: the triangle that is cut, then the three corners (x, y, z) of the winner in the geometry's own space. */
export const FLUSH_CUT_STRIDE = 10;
/** Shared area (square metres) under which a pair is ranked instead of cut: 1 cm2. */
export const FLUSH_CUT_MINIMUM_AREA = 1e-4;
const PER_VERTEX_FIELDS = ['positions', 'normals', 'uvs', 'lightUvs', 'colors', 'skyVisibility', 'surfaceMasks'];
const MARGIN_STEPS = 4;
const DEGENERATE_AREA_SHARE = 1e-12;
const CACHED_CUTS_PER_GEOMETRY = 8;

const clippedByGeometry = new WeakMap();

export function sameNumbers(first, second) {
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index++) {
    if (first[index] !== second[index]) return false;
  }
  return true;
}

function createPiece(points) {
  const piece = { points, minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity };
  for (const point of points) {
    piece.minU = Math.min(piece.minU, point.u);
    piece.minV = Math.min(piece.minV, point.v);
    piece.maxU = Math.max(piece.maxU, point.u);
    piece.maxV = Math.max(piece.maxV, point.v);
  }
  return piece;
}

function doubledArea(points) {
  let doubled = 0;
  for (let index = 0; index < points.length; index++) {
    const following = points[(index + 1) % points.length];
    doubled += points[index].u * following.v - following.u * points[index].v;
  }
  return Math.abs(doubled);
}

// The points of one triangle while it is cut. A point's weights say where it sits in the uncut triangle, so every vertex
// array can be interpolated for it later. Two cuts that reach the same spot get the same point: the grid finds it again.
function createPointSet(tolerance) {
  const cells = new Map();
  const all = [];
  const cellOf = value => Math.round(value / tolerance);
  function find(u, v) {
    const cellU = cellOf(u);
    const cellV = cellOf(v);
    for (let offsetU = -1; offsetU <= 1; offsetU++) {
      for (let offsetV = -1; offsetV <= 1; offsetV++) {
        const point = cells.get(`${cellU + offsetU},${cellV + offsetV}`);
        if (point && Math.abs(point.u - u) <= tolerance && Math.abs(point.v - v) <= tolerance) return point;
      }
    }
    return null;
  }
  function add(u, v, weights, vertex = -1) {
    const point = { u, v, weights, vertex, position: null, seam: null };
    cells.set(`${cellOf(u)},${cellOf(v)}`, point);
    all.push(point);
    return point;
  }
  function between(start, end, along) {
    const u = start.u + (end.u - start.u) * along;
    const v = start.v + (end.v - start.v) * along;
    return find(u, v) ?? add(u, v, [0, 1, 2].map(corner => start.weights[corner] + (end.weights[corner] - start.weights[corner]) * along));
  }
  return { all, add, between, tolerance };
}

// Splits a convex polygon along the line where `distances` is zero. A point within the tolerance of the line is on it and
// belongs to both sides, so a line through a vertex makes no second vertex beside it.
function splitPolygon(points, distances, pointSet) {
  const inside = [];
  const outside = [];
  const sides = distances.map(distance => (distance > pointSet.tolerance ? 1 : distance < -pointSet.tolerance ? -1 : 0));
  for (let index = 0; index < points.length; index++) {
    const following = (index + 1) % points.length;
    if (sides[index] >= 0) inside.push(points[index]);
    if (sides[index] <= 0) outside.push(points[index]);
    if (sides[index] * sides[following] < 0) {
      const crossing = pointSet.between(points[index], points[following], distances[index] / (distances[index] - distances[following]));
      if (inside.at(-1) !== crossing) inside.push(crossing);
      if (outside.at(-1) !== crossing) outside.push(crossing);
    }
  }
  return { inside, outside, reaches: sides.includes(1) };
}

function winnerCorners(cuts, cut, axisU, axisV) {
  const offset = cut * FLUSH_CUT_STRIDE + 1;
  return [0, 1, 2].map(corner => ({ u: cuts[offset + corner * 3 + axisU], v: cuts[offset + corner * 3 + axisV] }));
}

function edgeKey(start, end) {
  const forward = start.u < end.u || (start.u === end.u && start.v <= end.v);
  const [low, high] = forward ? [start, end] : [end, start];
  return `${low.u},${low.v},${high.u},${high.v}`;
}

// The winner's three edges on the plane's two largest axes, each as a start and a unit direction turned so that the
// inside of the winner is at positive distance. An edge is moved `margin` into the winner where the cut face goes on
// beyond it. It stays where it is when two winners share it (it is inside the covered area) and when the whole cut face
// lies on the winner's side of it (nothing goes on beyond it, so moving it would only leave a strip under the winner).
// Null for a winner that is a line on these axes.
function winnerEdges(corners, sharedEdges, margin, facePoints, tolerance) {
  const turn = (corners[1].u - corners[0].u) * (corners[2].v - corners[0].v) - (corners[1].v - corners[0].v) * (corners[2].u - corners[0].u) >= 0 ? 1 : -1;
  const edges = [];
  for (let index = 0; index < 3; index++) {
    const start = corners[index];
    const end = corners[(index + 1) % 3];
    const length = Math.hypot(end.u - start.u, end.v - start.v);
    if (!(length > 0)) return null;
    const edge = { u: start.u, v: start.v, directionU: turn * (end.u - start.u) / length, directionV: turn * (end.v - start.v) / length, margin };
    if (sharedEdges.get(edgeKey(start, end)) > 1 || facePoints.every(point => edgeDistance(edge, point) >= -tolerance)) edge.margin = 0;
    edges.push(edge);
  }
  edges.minU = Math.min(corners[0].u, corners[1].u, corners[2].u);
  edges.maxU = Math.max(corners[0].u, corners[1].u, corners[2].u);
  edges.minV = Math.min(corners[0].v, corners[1].v, corners[2].v);
  edges.maxV = Math.max(corners[0].v, corners[1].v, corners[2].v);
  return edges;
}

function edgeDistance(edge, point) {
  return edge.directionU * (point.v - edge.v) - edge.directionV * (point.u - edge.u);
}

function isCovered(points, edges, margin) {
  return points.every(point => edges.every(edge => edgeDistance(edge, point) >= -margin));
}

// What is left of a convex piece outside the winner, as convex pieces; null when the winner does not reach into it. Each
// edge line splits off the part beyond it; what is inside all three is the hidden part.
function subtractWinner(piece, edges, margin, pointSet) {
  if (piece.maxU < edges.minU || piece.minU > edges.maxU || piece.maxV < edges.minV || piece.minV > edges.maxV) return null;
  let remaining = piece.points;
  const kept = [];
  for (const edge of edges) {
    const { inside, outside, reaches } = splitPolygon(remaining, remaining.map(point => edgeDistance(edge, point) - edge.margin), pointSet);
    if (!reaches || inside.length < 3) return null;
    // A sliver between an edge of the winner and its moved line lies under the winner: it is hidden, not left over.
    if (outside.length >= 3 && !isCovered(outside, edges, margin)) kept.push(createPiece(outside));
    remaining = inside;
  }
  if (doubledArea(remaining) <= margin * margin) return null;
  return kept;
}

// The frame one triangle is cut in: its corners on the plane's two largest axes, and the largest coordinate in play.
function triangleFrame(geometry, triangle) {
  const { positions, indices } = geometry;
  const offsets = [0, 1, 2].map(corner => indices[triangle * 3 + corner] * 3);
  const edgeOne = [0, 1, 2].map(axis => positions[offsets[1] + axis] - positions[offsets[0] + axis]);
  const edgeTwo = [0, 1, 2].map(axis => positions[offsets[2] + axis] - positions[offsets[0] + axis]);
  const normal = [edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1], edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2], edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0]];
  const dropped = normal.reduce((best, value, axis) => (Math.abs(value) > Math.abs(normal[best]) ? axis : best), 0);
  let largest = 0;
  for (const offset of offsets) largest = Math.max(largest, Math.abs(positions[offset]), Math.abs(positions[offset + 1]), Math.abs(positions[offset + 2]));
  return { offsets, axisU: (dropped + 1) % 3, axisV: (dropped + 2) % 3, largest };
}

function cornerPoints(geometry, frame, pointSet) {
  return frame.offsets.map((offset, corner) => pointSet.add(geometry.positions[offset + frame.axisU], geometry.positions[offset + frame.axisV], [0, 1, 2].map(index => (index === corner ? 1 : 0)), offset / 3));
}

// One triangle after its cuts as `{ frame, pointSet, pieces, corners }`, or null when no cut reached it.
function cutTriangle(geometry, triangle, cuts, cutStart, cutEnd, coordinateStep) {
  const frame = triangleFrame(geometry, triangle);
  let largest = frame.largest;
  for (let value = cutStart * FLUSH_CUT_STRIDE; value < cutEnd * FLUSH_CUT_STRIDE; value++) {
    if (value % FLUSH_CUT_STRIDE !== 0) largest = Math.max(largest, Math.abs(cuts[value]));
  }
  const step = Math.max(coordinateStep, float32Step(largest));
  const margin = MARGIN_STEPS * step;
  const pointSet = createPointSet(step);
  const corners = cornerPoints(geometry, frame, pointSet);
  const whole = createPiece(corners);
  const wholeArea = doubledArea(corners);
  const winners = [];
  const sharedEdges = new Map();
  for (let cut = cutStart; cut < cutEnd; cut++) {
    const winner = winnerCorners(cuts, cut, frame.axisU, frame.axisV);
    winners.push(winner);
    for (let index = 0; index < 3; index++) {
      const key = edgeKey(winner[index], winner[(index + 1) % 3]);
      sharedEdges.set(key, (sharedEdges.get(key) ?? 0) + 1);
    }
  }
  let pieces = [whole];
  for (const winner of winners) {
    const edges = winnerEdges(winner, sharedEdges, margin, corners, step);
    if (!edges) continue;
    const next = [];
    for (const piece of pieces) {
      const left = subtractWinner(piece, edges, margin, pointSet);
      if (left) next.push(...left);
      else next.push(piece);
    }
    pieces = next;
  }
  if (pieces.length === 1 && pieces[0] === whole) return null;
  pieces = pieces.filter(piece => doubledArea(piece.points) > DEGENERATE_AREA_SHARE * wholeArea);
  return { frame, pointSet, pieces, corners };
}

function positionKey(positions, offset) {
  return `${positions[offset]},${positions[offset + 1]},${positions[offset + 2]}`;
}

// One side of a triangle as the mesh edge it lies on: a key that every triangle on that edge agrees on, whatever its own
// vertex numbers, and whether this triangle runs along it from the lower end.
function meshEdge(geometry, frame, opposite) {
  const start = frame.offsets[(opposite + 1) % 3];
  const end = frame.offsets[(opposite + 2) % 3];
  const startKey = positionKey(geometry.positions, start);
  const endKey = positionKey(geometry.positions, end);
  const forward = startKey <= endKey;
  return { key: forward ? `${startKey}|${endKey}` : `${endKey}|${startKey}`, forward, start, end };
}

// The corner a point lies opposite of when it sits on a side of the uncut triangle and is not a corner itself, else -1.
function sideOf(point) {
  const zeros = point.weights.filter(weight => weight === 0).length;
  return zeros === 1 ? point.weights.indexOf(0) : -1;
}

// Notes every vertex a cut put on a mesh edge in `seams`, so the triangles on the other side of that edge get it too. Two
// triangles that were cut at the same spot of an edge share one position, to the bit.
function noteSeamPoints(geometry, cut, seams) {
  const { positions } = geometry;
  for (const point of new Set(cut.pieces.flatMap(piece => piece.points))) {
    const opposite = sideOf(point);
    if (opposite < 0) continue;
    const edge = meshEdge(geometry, cut.frame, opposite);
    const along = edge.forward ? point.weights[(opposite + 2) % 3] : point.weights[(opposite + 1) % 3];
    const [low, high] = edge.forward ? [edge.start, edge.end] : [edge.end, edge.start];
    const length = Math.hypot(positions[high] - positions[low], positions[high + 1] - positions[low + 1], positions[high + 2] - positions[low + 2]);
    const entries = seams.get(edge.key) ?? [];
    seams.set(edge.key, entries);
    let entry = entries.find(candidate => Math.abs(candidate.along - along) * length <= cut.pointSet.tolerance);
    if (!entry) {
      entry = { along, position: [0, 1, 2].map(axis => Math.fround(positions[low + axis] + (positions[high + axis] - positions[low + axis]) * along)) };
      entries.push(entry);
    }
    point.seam = entry;
    point.position = entry.position;
  }
}

// Gives a triangle the seam vertices of its three sides that it does not have yet.
function addSeamPoints(geometry, cut, seams) {
  for (let opposite = 0; opposite < 3; opposite++) {
    const edge = meshEdge(geometry, cut.frame, opposite);
    const entries = seams.get(edge.key);
    if (!entries) continue;
    const start = cut.corners[(opposite + 1) % 3];
    const end = cut.corners[(opposite + 2) % 3];
    for (const entry of entries) {
      if (cut.pointSet.all.some(point => point.seam === entry)) continue;
      const along = edge.forward ? entry.along : 1 - entry.along;
      const point = cut.pointSet.between(start, end, along);
      if (point.seam || point.vertex >= 0) continue;
      point.seam = entry;
      point.position = entry.position;
    }
  }
}

// The points of a piece with every other point of the triangle that lies on one of its sides put in between, so the piece
// and its neighbours have the same vertices along the side they share.
function withPointsOnSides(piece, pointSet) {
  const own = new Set(piece.points);
  const ring = [];
  for (let index = 0; index < piece.points.length; index++) {
    const start = piece.points[index];
    const end = piece.points[(index + 1) % piece.points.length];
    const length = Math.hypot(end.u - start.u, end.v - start.v);
    ring.push(start);
    if (!(length > 0)) continue;
    const onSide = [];
    for (const point of pointSet.all) {
      if (own.has(point)) continue;
      const along = ((point.u - start.u) * (end.u - start.u) + (point.v - start.v) * (end.v - start.v)) / length;
      if (along <= pointSet.tolerance || along >= length - pointSet.tolerance) continue;
      const away = Math.abs((end.u - start.u) * (point.v - start.v) - (end.v - start.v) * (point.u - start.u)) / length;
      if (away <= pointSet.tolerance) onSide.push({ point, along });
    }
    onSide.sort((one, other) => one.along - other.along);
    for (const { point } of onSide) ring.push(point);
  }
  return ring;
}

function hasPointOnSide(ring, tolerance) {
  return ring.some((point, index) => {
    const previous = ring[(index + ring.length - 1) % ring.length];
    const following = ring[(index + 1) % ring.length];
    const length = Math.hypot(following.u - previous.u, following.v - previous.v);
    return Math.abs((following.u - previous.u) * (point.v - previous.v) - (following.v - previous.v) * (point.u - previous.u)) <= tolerance * length;
  });
}

// A convex ring as triangles. A ring with points along its sides is fanned from its middle: a fan from a corner would
// leave those points beside a long edge, held only by a triangle with no area.
function fanRing(ring, pointSet) {
  if (!hasPointOnSide(ring, pointSet.tolerance)) return ring.slice(1, -1).map((point, index) => [ring[0], point, ring[index + 2]]);
  const middle = pointSet.add(
    ring.reduce((sum, point) => sum + point.u, 0) / ring.length,
    ring.reduce((sum, point) => sum + point.v, 0) / ring.length,
    [0, 1, 2].map(corner => ring.reduce((sum, point) => sum + point.weights[corner], 0) / ring.length),
  );
  return ring.map((point, index) => [middle, point, ring[(index + 1) % ring.length]]);
}

// Every per-vertex array grown by the new vertices, each the weighted mix of the three corners of the triangle it was cut
// from. A vertex on a seam takes the position the seam holds, so both sides of the seam get the same bits.
function extendVertexArrays(geometry, added) {
  const vertexCount = geometry.positions.length / 3;
  const extended = {};
  for (const field of PER_VERTEX_FIELDS) {
    const values = geometry[field];
    if (!values) continue;
    const stride = values.length / vertexCount;
    const grown = new values.constructor(values.length + added.length * stride);
    grown.set(values);
    added.forEach(({ corners, point }, vertex) => {
      const target = values.length + vertex * stride;
      if (field === 'positions' && point.position) {
        grown.set(point.position, target);
        return;
      }
      for (let component = 0; component < stride; component++) {
        grown[target + component] = values[corners[0] * stride + component] * point.weights[0]
          + values[corners[1] * stride + component] * point.weights[1]
          + values[corners[2] * stride + component] * point.weights[2];
      }
    });
    extended[field] = grown;
  }
  return extended;
}

function clipGeometry(geometry, cuts, coordinateStep) {
  const { indices } = geometry;
  const triangleCount = indices.length / 3;
  const vertexCount = geometry.positions.length / 3;
  const cutCount = cuts.length / FLUSH_CUT_STRIDE;
  const cutTriangles = new Map();
  const seams = new Map();
  let cut = 0;
  for (let triangle = 0; triangle < triangleCount && cut < cutCount; triangle++) {
    const cutStart = cut;
    while (cut < cutCount && cuts[cut * FLUSH_CUT_STRIDE] === triangle) cut++;
    if (cut === cutStart) continue;
    const result = cutTriangle(geometry, triangle, cuts, cutStart, cut, coordinateStep);
    if (!result) continue;
    cutTriangles.set(triangle, result);
    noteSeamPoints(geometry, result, seams);
  }
  if (cutTriangles.size === 0) return { geometry, sources: null };
  const clippedIndices = [];
  const sources = [];
  const added = [];
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    let result = cutTriangles.get(triangle);
    if (!result && seams.size > 0) {
      // An uncut triangle on a seam is split at the seam's vertices too.
      const frame = triangleFrame(geometry, triangle);
      if ([0, 1, 2].some(opposite => seams.has(meshEdge(geometry, frame, opposite).key))) {
        const pointSet = createPointSet(Math.max(coordinateStep, float32Step(frame.largest)));
        const corners = cornerPoints(geometry, frame, pointSet);
        result = { frame, pointSet, pieces: [createPiece(corners)], corners };
      }
    }
    if (!result) {
      clippedIndices.push(indices[triangle * 3], indices[triangle * 3 + 1], indices[triangle * 3 + 2]);
      sources.push(triangle);
      continue;
    }
    addSeamPoints(geometry, result, seams);
    const corners = [indices[triangle * 3], indices[triangle * 3 + 1], indices[triangle * 3 + 2]];
    for (const piece of result.pieces) {
      const ring = withPointsOnSides(piece, result.pointSet);
      for (const fan of fanRing(ring, result.pointSet)) {
        for (const point of fan) {
          if (point.vertex >= 0) continue;
          point.vertex = vertexCount + added.length;
          added.push({ corners, point });
        }
        clippedIndices.push(fan[0].vertex, fan[1].vertex, fan[2].vertex);
        sources.push(triangle);
      }
    }
  }
  return {
    geometry: { ...geometry, ...extendVertexArrays(geometry, added), indices: new Uint32Array(clippedIndices) },
    sources: new Uint32Array(sources),
  };
}

/**
 * Cuts the hidden part out of the triangles of `geometry`. `cuts` is a Float64Array of FLUSH_CUT_STRIDE numbers per cut,
 * sorted by the triangle that is cut: that triangle's number, then the corners of the triangle that covers it, in the
 * geometry's own space. `coordinateStep` is the float32 step of the coordinates the part is drawn at, in the geometry's
 * units; a cut stops a few of those steps (or of the geometry's own, when larger) inside the winner. Returns
 * `{ geometry, sources }`: a new geometry with every per-vertex array interpolated for the new vertices and `sources[n]`
 * the uncut triangle that clipped triangle n came from; or the same `geometry` and `sources: null` when nothing was cut.
 * A fully covered triangle is dropped. The result is kept per geometry, so the same cuts return the same object.
 */
export function clipFlushOverlaps(geometry, cuts, coordinateStep = 0) {
  if (cuts.length === 0) return { geometry, sources: null };
  const cached = clippedByGeometry.get(geometry) ?? [];
  clippedByGeometry.set(geometry, cached);
  let entry = cached.find(candidate => sameNumbers(candidate.cuts, cuts));
  if (!entry) {
    entry = { cuts, clipped: clipGeometry(geometry, cuts, coordinateStep) };
    cached.push(entry);
    if (cached.length > CACHED_CUTS_PER_GEOMETRY) cached.shift();
  }
  return entry.clipped;
}
