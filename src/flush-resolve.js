// Turns the pairs of flush-search.js into a draw rank per triangle (issue #751). The triangle in front along the shared
// normal gets the higher rank, and the renderer pulls each rank a little closer in depth only, so the same triangle wins
// every frame and at every distance. Ranks are per triangle, not per part: a whole-part offset moved faces that had no
// conflict and made things worse (issue #593).
import { depthLayerOf, MAXIMUM_FLUSH_RANK, setFlushOrder } from './depth-layer.js';
import { findFlushPairs } from './flush-search.js';

const COLLAPSED_AXIS_SHARE = 1e-3;

// Which triangle of a pair draws in front. A real gap decides; on one plane the smaller triangle is the detail (a plaque,
// a trim, a duplicate face) and wins, then the later one.
function frontOf(pair, areas) {
  if (!pair.flush) return pair.gap > 0 ? pair.second : pair.first;
  if (areas[pair.first] !== areas[pair.second]) return areas[pair.first] < areas[pair.second] ? pair.first : pair.second;
  return pair.second;
}

// Rank = the longest chain of triangles behind this one. Each pass lifts the front triangle of every pair above its back
// triangle; a chain longer than the top rank (or a cycle of slightly tilted planes) stops there and is marked.
function rankTriangles(count, edges) {
  const ranks = new Uint8Array(count);
  const overflow = new Uint8Array(count);
  let moved = true;
  for (let pass = 0; moved && pass <= MAXIMUM_FLUSH_RANK + 1; pass++) {
    moved = false;
    for (let edge = 0; edge < edges.length; edge += 2) {
      const front = edges[edge + 1];
      const wanted = ranks[edges[edge]] + 1;
      if (wanted <= ranks[front]) continue;
      if (wanted > MAXIMUM_FLUSH_RANK) {
        overflow[front] = 1;
        continue;
      }
      ranks[front] = wanted;
      moved = true;
    }
  }
  return { ranks, overflow };
}

function sameRanks(first, second) {
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index++) {
    if (first[index] !== second[index]) return false;
  }
  return true;
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
 * Finds the near-coplanar triangles of `parts` and stores a ranked draw order beside every part that needs one
 * (`flushOrderOf(part)` in depth-layer.js); parts, geometries and matrices are left as they are. Parts that share a geometry
 * and agree on every rank share one order, so they still batch. Returns `{ ranked, leftovers }`: the number of parts with an
 * order, and what could not be settled as `{ reason, part, triangles }` with reason `rank-overflow` (a stack deeper than 15
 * faces), `double-sided-gap`, `unchecked` (past the search budget) or `collapsed-node` (an axis scaled to nothing).
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
    edges.push(front === pair.first ? pair.second : pair.first, front);
  }
  const { ranks, overflow } = rankTriangles(count, edges);
  const partRanks = found.parts.map(() => null);
  for (let id = 0; id < count; id++) {
    if (overflow[id]) note('rank-overflow', found.parts[owner[id]]);
    if (ranks[id] === 0) continue;
    partRanks[owner[id]] ??= new Uint8Array(found.parts[owner[id]].geometry.indices.length / 3);
    partRanks[owner[id]][local[id]] = ranks[id];
  }
  const ordersByGeometry = new Map();
  const searched = new Map(found.parts.map((part, index) => [part, index]));
  let ranked = 0;
  for (const part of parts) {
    const triangleRanks = searched.has(part) ? partRanks[searched.get(part)] : null;
    if (!triangleRanks) {
      setFlushOrder(part, null);
      continue;
    }
    const orders = ordersByGeometry.get(part.geometry) ?? [];
    ordersByGeometry.set(part.geometry, orders);
    let order = orders.find(candidate => sameRanks(candidate.triangleRanks, triangleRanks));
    if (!order) {
      order = createFlushOrder(part.geometry.indices, triangleRanks);
      orders.push(order);
    }
    setFlushOrder(part, order);
    ranked++;
  }
  for (const part of found.unchecked) note('unchecked', part, part.geometry.indices.length / 3);
  if (found.truncated) note('unchecked', { name: 'scene' }, 0);
  for (const part of parts) {
    if (part.matrix && part.geometry?.indices?.length && hasCollapsedAxis(part.matrix)) note('collapsed-node', part, part.geometry.indices.length / 3);
  }
  return { ranked, leftovers: [...leftovers.values()] };
}
