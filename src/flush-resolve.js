// Settles the pairs of flush-search.js (issue #751). Two faces on one plane: the hidden one is cut away where the other
// covers it (flush-clip.js), so nothing is left to fight. Two faces a small gap apart: the one in front along the shared
// normal gets the higher draw rank, and the renderer pulls each rank a little closer in depth only, so the same triangle
// wins every frame and at every distance. Ranks are per triangle, not per part: a whole-part offset moved faces that had
// no conflict and made things worse (issue #593).
import { depthLayerOf, MAXIMUM_FLUSH_RANK, setFlushOrder } from './depth-layer.js';
import { clipFlushOverlaps, FLUSH_CUT_MINIMUM_AREA, FLUSH_CUT_STRIDE, sameNumbers } from './flush-clip.js';
import { findFlushPairs, float32Step, worldBounds } from './flush-search.js';
import { invertAffine } from './path-tracer-reprojection.js';

// A 2 cm slab 400 m wide is a ground, not a collapse (issue #1216): only an axis a millionth of the longest one is scaled to nothing.
const COLLAPSED_AXIS_SHARE = 1e-6;
const CACHED_ORDERS_PER_GEOMETRY = 8;
// A face this close in front of another, facing the same way, is cut like a flush one. Seen at a grazing angle, the cut
// can open a strip no wider than the gap at the front face's edge: a thousandth of the shared face, never less than a
// millimetre and never more than a centimetre, does not show. A wider gap, such as a sign standing off a wall, is ranked
// instead. Without the cut, assets built as stacked blocks nest facades a few millimetres apart deeper than the 16 ranks
// (the Melbourne city model nests 17).
const NEAR_FLUSH_CUT_GAP_SHARE = 1e-3;
const NEAR_FLUSH_CUT_MINIMUM_GAP = 1e-3;
const NEAR_FLUSH_CUT_MAXIMUM_GAP = 1e-2;

function nearFlushCutGap(sharedArea) {
  const relative = NEAR_FLUSH_CUT_GAP_SHARE * Math.sqrt(sharedArea);
  return Math.min(NEAR_FLUSH_CUT_MAXIMUM_GAP, Math.max(NEAR_FLUSH_CUT_MINIMUM_GAP, relative));
}

// Kept between runs, so a part whose ranks and cuts did not change keeps its order object and the renderer keeps its batch.
const ordersByGeometry = new WeakMap();

// Which triangle of a pair draws in front. A real gap decides; on one plane the smaller triangle is the detail (a plaque,
// a trim, a duplicate face) and wins, then the later one.
function frontOf(pair, areas) {
  if (!pair.flush) return pair.gap > 0 ? pair.second : pair.first;
  if (areas[pair.first] !== areas[pair.second]) return areas[pair.first] < areas[pair.second] ? pair.first : pair.second;
  return pair.second;
}

// Lifts the front triangle of every pair above its back triangle, once. Returns whether a rank moved.
function liftFronts(ranks, edges, overflow) {
  let moved = false;
  for (let edge = 0; edge < edges.length; edge += 2) {
    const front = edges[edge + 1];
    const wanted = ranks[edges[edge]] + 1;
    if (wanted <= ranks[front]) continue;
    if (wanted > MAXIMUM_FLUSH_RANK) {
      if (overflow) overflow[front] = 1;
      continue;
    }
    ranks[front] = wanted;
    moved = true;
  }
  return moved;
}

// Rank = the longest chain of triangles behind this one. A chain longer than the top rank (or a cycle of slightly tilted
// planes) stops there and is marked. `seamEdges` are pairs that were cut: what is left of them shares only the hair of
// overlap a cut leaves, so they take a rank where one is free and are dropped without a mark where the ranks ran out.
function rankTriangles(count, edges, seamEdges) {
  const ranks = new Uint8Array(count);
  const overflow = new Uint8Array(count);
  for (let pass = 0; pass <= MAXIMUM_FLUSH_RANK + 1 && liftFronts(ranks, edges, overflow); pass++);
  for (let pass = 0; pass <= MAXIMUM_FLUSH_RANK + 1; pass++) {
    const seamMoved = liftFronts(ranks, seamEdges, null);
    const moved = liftFronts(ranks, edges, null);
    if (!seamMoved && !moved) break;
  }
  return { ranks, overflow };
}

// Whether the back triangle of a pair can be cut away under the front one: they lie on one plane, or within
// nearFlushCutGap of it, and face the same way, the front one hides what is under it, and no side of the back one stays
// in view where the front one is culled.
function canCut(pair, frontPart, backPart) {
  if (pair.opposite || pair.area < FLUSH_CUT_MINIMUM_AREA) return false;
  if (!pair.flush && !(Math.abs(pair.gap) <= nearFlushCutGap(pair.area))) return false;
  if ((frontPart.material?.alphaMode ?? 'opaque') !== 'opaque') return false;
  return backPart.material?.doubleSided !== true || frontPart.material?.doubleSided === true;
}

function columnLength(matrix, column) {
  return Math.hypot(matrix[column], matrix[column + 1], matrix[column + 2]);
}

// The float32 step of the world coordinates a part is drawn at, in the units of its geometry.
function coordinateStep(part) {
  const largest = worldBounds(part).reduce((most, value) => Math.max(most, Math.abs(value)), 0);
  return float32Step(largest) / Math.min(columnLength(part.matrix, 0), columnLength(part.matrix, 4), columnLength(part.matrix, 8));
}

// The cuts of one part for clipFlushOverlaps, sorted by the triangle that is cut; null when the part's matrix has no inverse.
// A winner in the same part is read from the geometry, so instances of one geometry get the same cuts and share the result.
function cutRecords(found, partIndex, cutPairs) {
  const part = found.parts[partIndex];
  const { positions, indices } = part.geometry;
  const inverse = invertAffine(part.matrix);
  if (!inverse) return null;
  cutPairs.sort((one, other) => found.local[one.back] - found.local[other.back] || one.front - other.front);
  const cuts = new Float64Array(cutPairs.length * FLUSH_CUT_STRIDE);
  cutPairs.forEach(({ back, front }, index) => {
    const offset = index * FLUSH_CUT_STRIDE;
    cuts[offset] = found.local[back];
    for (let corner = 0; corner < 3; corner++) {
      const target = offset + 1 + corner * 3;
      if (found.owner[front] === partIndex) {
        const vertex = indices[found.local[front] * 3 + corner] * 3;
        cuts.set(positions.subarray(vertex, vertex + 3), target);
        continue;
      }
      const x = found.corners[front * 9 + corner * 3];
      const y = found.corners[front * 9 + corner * 3 + 1];
      const z = found.corners[front * 9 + corner * 3 + 2];
      cuts[target] = inverse[0] * x + inverse[4] * y + inverse[8] * z + inverse[12];
      cuts[target + 1] = inverse[1] * x + inverse[5] * y + inverse[9] * z + inverse[13];
      cuts[target + 2] = inverse[2] * x + inverse[6] * y + inverse[10] * z + inverse[14];
    }
  });
  return cuts;
}

// A part's geometry with its hidden flush faces cut away, as `{ geometry, sources }` of clipFlushOverlaps. A part that
// cannot be cut, or that would lose every triangle, keeps its geometry and its pairs are ranked instead. A pair whose back
// triangle is still partly there goes to `seamEdges`.
function clipPart(found, partIndex, cutPairs, edges, seamEdges) {
  const part = found.parts[partIndex];
  const uncut = { geometry: part.geometry, sources: null };
  if (cutPairs.length === 0) return uncut;
  const cuts = cutRecords(found, partIndex, cutPairs);
  const clipped = cuts ? clipFlushOverlaps(part.geometry, cuts, coordinateStep(part)) : uncut;
  if (!cuts || clipped.geometry.indices.length === 0) {
    for (const { back, front } of cutPairs) edges.push(back, front);
    return uncut;
  }
  if (!clipped.sources) return clipped;
  const left = new Uint8Array(part.geometry.indices.length / 3);
  for (const source of clipped.sources) left[source] = 1;
  for (const { back, front } of cutPairs) {
    if (left[found.local[back]]) seamEdges.push(back, front);
  }
  return clipped;
}

// The order a part draws with, or null when it has neither a cut nor a rank. `triangleRanks` counts the uncut triangles.
function flushOrderFor({ geometry, sources }, triangleRanks) {
  if (!sources && !triangleRanks) return null;
  let drawnRanks = triangleRanks;
  if (sources) drawnRanks = triangleRanks ? Uint8Array.from(sources, source => triangleRanks[source]) : new Uint8Array(sources.length);
  const orders = ordersByGeometry.get(geometry) ?? [];
  ordersByGeometry.set(geometry, orders);
  let order = orders.find(candidate => sameNumbers(candidate.triangleRanks, drawnRanks));
  if (!order) {
    order = createFlushOrder(geometry.indices, drawnRanks);
    // A cut part draws its cut vertices; the order's indices are that geometry's triangles, sorted by rank.
    if (sources) order.geometry = { ...geometry, indices: order.indices };
    orders.push(order);
    if (orders.length > CACHED_ORDERS_PER_GEOMETRY) orders.shift();
  }
  return order;
}

// The geometry's indices sorted by rank (triangles of one rank keep their order) and the index range of each rank.
function createFlushOrder(indices, triangleRanks) {
  const counts = new Uint32Array(MAXIMUM_FLUSH_RANK + 1);
  for (const rank of triangleRanks) counts[rank]++;
  const starts = new Uint32Array(MAXIMUM_FLUSH_RANK + 1);
  const ranges = [];
  let start = 0;
  for (let rank = 0; rank <= MAXIMUM_FLUSH_RANK; rank++) {
    starts[rank] = start;
    if (counts[rank] > 0) ranges.push({ start: start * 3, count: counts[rank] * 3, rank });
    start += counts[rank];
  }
  const ordered = new Uint32Array(indices.length);
  for (let triangle = 0; triangle < triangleRanks.length; triangle++) {
    const target = starts[triangleRanks[triangle]]++ * 3;
    ordered[target] = indices[triangle * 3];
    ordered[target + 1] = indices[triangle * 3 + 1];
    ordered[target + 2] = indices[triangle * 3 + 2];
  }
  return { indices: ordered, ranges, triangleRanks };
}

function hasCollapsedAxis(matrix) {
  const lengths = [0, 4, 8].map(column => Math.hypot(matrix[column], matrix[column + 1], matrix[column + 2]));
  return Math.min(...lengths) < COLLAPSED_AXIS_SHARE * Math.max(...lengths);
}

/**
 * Finds the near-coplanar triangles of `parts` and stores a draw order beside every part that needs one (`flushOrderOf(part)`
 * in depth-layer.js); parts, geometries and matrices are left as they are. An order holds the triangles sorted by rank and,
 * for a part with faces cut away, the cut `geometry` they index. Parts that share a geometry and agree on every cut and rank
 * share one order, so they still batch. Returns `{ ranked, leftovers }`: the number of parts with an order, and what
 * could not be settled as `{ reason, part, triangles }` with reason
 * `rank-overflow` (more than 16 faces a small gap apart), `double-sided-gap`, `unchecked` (past the search budget) or
 * `collapsed-node` (an axis scaled to nothing).
 */
export function resolveFlush(parts, options) {
  const found = findFlushPairs(parts, options);
  const { owner, local, areas, pairs, count } = found;
  const leftovers = new Map();
  const note = (reason, part, triangles = 1) => {
    const key = `${reason}\n${part.name}`;
    const entry = leftovers.get(key) ?? { reason, part: part.name, triangles: 0 };
    entry.triangles += triangles;
    leftovers.set(key, entry);
  };
  const edges = [];
  const seamEdges = [];
  const cutPairs = found.parts.map(() => []);
  for (const pair of pairs) {
    const firstPart = found.parts[owner[pair.first]];
    const secondPart = found.parts[owner[pair.second]];
    // Parts on different layers are already a whole layer of ranks apart.
    if (depthLayerOf(firstPart) !== depthLayerOf(secondPart)) continue;
    if (pair.opposite && !pair.flush) {
      // Which of the two is in front depends on the side the camera is on, so no fixed rank is right.
      note('double-sided-gap', secondPart);
      continue;
    }
    const front = frontOf(pair, areas);
    const back = front === pair.first ? pair.second : pair.first;
    if (canCut(pair, found.parts[owner[front]], found.parts[owner[back]])) cutPairs[owner[back]].push({ back, front });
    else edges.push(back, front);
  }
  const clippedParts = found.parts.map((part, partIndex) => clipPart(found, partIndex, cutPairs[partIndex], edges, seamEdges));
  const { ranks, overflow } = rankTriangles(count, edges, seamEdges);
  const partRanks = found.parts.map(() => null);
  for (let id = 0; id < count; id++) {
    if (overflow[id]) note('rank-overflow', found.parts[owner[id]]);
    if (ranks[id] === 0) continue;
    partRanks[owner[id]] ??= new Uint8Array(found.parts[owner[id]].geometry.indices.length / 3);
    partRanks[owner[id]][local[id]] = ranks[id];
  }
  const searched = new Map(found.parts.map((part, index) => [part, index]));
  let ranked = 0;
  for (const part of parts) {
    const partIndex = searched.get(part);
    const order = partIndex === undefined ? null : flushOrderFor(clippedParts[partIndex], partRanks[partIndex]);
    setFlushOrder(part, order);
    if (order) ranked++;
  }
  for (const part of found.unchecked) note('unchecked', part, part.geometry.indices.length / 3);
  if (found.truncated) note('unchecked', { name: found.truncatedAt ?? 'scene' }, 0);
  for (const part of parts) {
    if (part.matrix && part.geometry?.indices?.length && hasCollapsedAxis(part.matrix)) note('collapsed-node', part, part.geometry.indices.length / 3);
  }
  return { ranked, leftovers: [...leftovers.values()] };
}
