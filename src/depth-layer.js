/** Highest depth layer; the draw-time polygon offset grows with the layer. */
export const MAXIMUM_DEPTH_LAYER = 4;

// Layers the renderer gave to parts that draw the same plane as a larger part (coplanar-overlap.js), kept beside the part
// so the part object, and its identity for updateParts, stay as the caller made it.
const flushDepthLayers = new WeakMap();

export function setFlushDepthLayers(layers) {
  for (const [part, layer] of layers) flushDepthLayers.set(part, layer);
}

/** The layer a part draws on: `depthLayer` if set, else 1 for `decal: true`, else the flush layer found for it, else 0. */
export function depthLayerOf(part) {
  return part.depthLayer ?? (part.decal ? 1 : flushDepthLayers.get(part) ?? 0);
}
