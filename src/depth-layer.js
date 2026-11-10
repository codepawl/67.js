/** Highest depth layer a part can ask for with `depthLayer`. */
export const MAXIMUM_DEPTH_LAYER = 4;
/** Draw ranks one depth layer spans: ranks 0 to 15 order near-coplanar triangles, and a layer clears all of them. */
export const RANKS_PER_LAYER = 16;
/** Highest rank the flush search gives a triangle; a deeper stack is reported as `rank-overflow`. */
export const MAXIMUM_FLUSH_RANK = RANKS_PER_LAYER - 1;

// The draw order flush-resolve.js found for a part: `{ indices, ranges: [{ start, count, rank }] }`, the part's triangles
// sorted by rank. It is kept beside the part so the part object, its geometry and its identity for updateParts stay as the
// caller made them.
const flushOrders = new WeakMap();

export function setFlushOrder(part, order) {
  if (order) flushOrders.set(part, order);
  else flushOrders.delete(part);
}

/** The ranked index order of a part, or null when none of its triangles needs a rank. */
export function flushOrderOf(part) {
  return flushOrders.get(part) ?? null;
}

/** The layer a part draws on: `depthLayer` if set, else 1 for `decal: true`, else 0. */
export function depthLayerOf(part) {
  return part.depthLayer ?? (part.decal ? 1 : 0);
}
