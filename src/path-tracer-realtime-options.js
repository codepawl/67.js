import { normalizePathTracerOptions } from './path-tracer.js';

// What both backends of the real-time tracer (path-tracer-realtime.js, path-tracer-realtime-webgpu.js) read from the options.

export const REALTIME_BACKENDS = ['gpu', 'webgpu'];
const DEFAULT_BOUNCES = 2;
const DEFAULT_RESOLUTION_DIVISOR = 2;
const CACHE_CELLS_ACROSS_SCENE = 200;
const CACHE_LEVEL_CELLS = 64;
const SCENE_EXTENT_SCALE = 1e4;

/** The output and tracing sizes and the normalized tracer options of `createRealtimeTracer`'s raw options. */
export function resolveRealtimeOptions(rawOptions) {
  const resolutionDivisor = rawOptions.resolutionDivisor ?? DEFAULT_RESOLUTION_DIVISOR;
  const outputWidth = rawOptions.width ?? 960;
  const outputHeight = rawOptions.height ?? 540;
  const traceWidth = Math.max(1, Math.ceil(outputWidth / resolutionDivisor));
  const traceHeight = Math.max(1, Math.ceil(outputHeight / resolutionDivisor));
  const backend = rawOptions.backend ?? 'gpu';
  if (!REALTIME_BACKENDS.includes(backend)) throw new RangeError(`The real-time path tracer backend must be one of ${REALTIME_BACKENDS.join(', ')}.`);
  const options = normalizePathTracerOptions({
    seed: rawOptions.seed, lightSelection: rawOptions.lightSelection ?? 'importance', bounces: rawOptions.bounces ?? DEFAULT_BOUNCES,
    width: traceWidth, height: traceHeight, samples: 1, backend: 'gpu', denoise: false,
  });
  options.radianceCache = true;
  return {
    backend, outputWidth, outputHeight, traceWidth, traceHeight, options,
    historyLimit: rawOptions.historyLimit, filterIterations: rawOptions.filterIterations, cacheCellSize: rawOptions.cacheCellSize,
  };
}

/** The cache cell size and the distance at which cells start to grow, for a scene of `farDistance`. */
export function cacheCellSizes(traceScene, cacheCellSize) {
  const extent = traceScene.farDistance / SCENE_EXTENT_SCALE;
  const cellSize = cacheCellSize ?? extent / CACHE_CELLS_ACROSS_SCENE;
  return { cellSize, levelDistance: cellSize * CACHE_LEVEL_CELLS };
}

/** True when two cameras (as `createCamera` returns them) look the same way. */
export function viewsMatch(first, second) {
  if (!first || !second) return false;
  const keys = ['eye', 'forward', 'right', 'above'];
  return keys.every(key => first[key].every((value, axis) => value === second[key][axis])) && first.halfWidth === second.halfWidth && first.halfHeight === second.halfHeight;
}
