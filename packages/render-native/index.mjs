// Hardware ray traced stills for 67js: loads the native addon built by `npm run build` and traces a packed scene on the
// GPU with Vulkan ray queries. The addon is not in this package; without it `findNativeAddon()` returns null.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export { buildNativeInput, buildNativeTexelInput } from './pack-input.mjs';

const PACKAGE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ADDON_PATH = join(PACKAGE_DIRECTORY, 'build', 'render-native.node');

/** The path of the built addon, or null when `npm run build` has not run. */
export function findNativeAddon() {
  return existsSync(ADDON_PATH) ? ADDON_PATH : null;
}

/**
 * Traces the input on the GPU and resolves linear RGBA float data (`rgba`, width * height * 4, rows from the top, the
 * average of `samples` paths) with the adapter name and timings in seconds. `maxSeconds` makes the trace fail once it has
 * run that long.
 */
export function traceNative(input, { width, height, samples, maxSeconds }) {
  return loadAddon().traceScene(input, { width, height, samples, maxSeconds });
}

/**
 * The light bake: traces `samples` cosine weighted paths from every texel of `texels` (`count`, `points`, `normals`) and
 * returns the mean `radiance` (three floats per texel) and the share of first rays that `escaped`. The input comes from
 * `buildNativeTexelInput`.
 */
export function traceNativeTexels(input, texels, { samples, maxSeconds }) {
  return loadAddon().traceTexels(input, texels, { samples, maxSeconds });
}

function loadAddon() {
  const addonPath = findNativeAddon();
  if (!addonPath) throw new Error('The native tracer is not built. Run `npm run build` in packages/render-native.');
  return createRequire(import.meta.url)(addonPath);
}
