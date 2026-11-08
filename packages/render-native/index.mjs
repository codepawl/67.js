// Hardware ray traced stills for 67js: loads the native addon built by `npm run build` and traces a packed scene on the
// GPU with Vulkan ray queries. The addon is not in this package; without it `findNativeAddon()` returns null.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ADDON_PATH = join(PACKAGE_DIRECTORY, 'build', 'render-native.node');
const PARAMETER_BYTES = 12 * 16;
const SUN_CONE_COSINE = Math.cos(Math.PI / 360);

/** The path of the built addon, or null when `npm run build` has not run. */
export function findNativeAddon() {
  return existsSync(ADDON_PATH) ? ADDON_PATH : null;
}

function writeParameters(scene, camera, options, lightCount, atlasWidth) {
  const buffer = new ArrayBuffer(PARAMETER_BYTES);
  const floats = new Float32Array(buffer);
  const integers = new Int32Array(buffer);
  const words = new Uint32Array(buffer);
  const { sun } = scene.lights;
  const { environment } = scene;
  floats.set([...camera.eye, 0], 0);
  floats.set([...camera.forward, 0], 4);
  floats.set([...camera.right, 0], 8);
  floats.set([...camera.above, 0], 12);
  floats.set([...(sun?.direction ?? [0, 1, 0]), 0], 16);
  floats.set([...(sun?.color ?? [0, 0, 0]), SUN_CONE_COSINE], 20);
  floats.set([environment?.width ?? 1, environment?.height ?? 1, environment?.intensity ?? 1, environment?.total ?? 1], 24);
  floats.set([environment?.cosine ?? 1, environment?.sine ?? 0, scene.surfaceOffset, scene.farDistance], 28);
  floats.set([camera.halfWidth, camera.halfHeight, options.fireflyClamp ?? 20, 0], 32);
  integers.set([options.width, options.height, options.bounces, lightCount], 36);
  integers.set([(sun ? 1 : 0) + lightCount + (environment ? 1 : 0), sun ? 1 : 0, environment ? 1 : 0, 0], 40);
  words.set([options.seed >>> 0, atlasWidth, 0, 0], 44);
  return new Uint8Array(buffer);
}

/**
 * Packs a trace scene (from `buildTraceScene`) and its camera into the tables the kernel reads.
 * `pack` is the module `src/path-tracer-gpu-pack.js`, passed in so this package never imports the engine's source.
 */
export function buildNativeInput(scene, camera, options, pack) {
  const atlas = pack.packAtlas(scene.materials);
  const lights = pack.packLights(scene.lights);
  const environment = pack.packEnvironment(scene.environment);
  const environmentTables = new Float32Array(environment ? environment.height + environment.width * environment.height : 4);
  if (environment) {
    environmentTables.set(environment.rows.data.subarray(0, environment.height), 0);
    environmentTables.set(environment.pixels.data.subarray(0, environment.width * environment.height), environment.height);
  }
  return {
    triangles: pack.packTriangles(scene).data,
    triangleCount: scene.bvh.triangleOrder.length,
    materials: pack.packMaterials(scene.materials, atlas).data,
    lights: lights.table.data,
    atlas: new Uint32Array(atlas.data.buffer, atlas.data.byteOffset, Math.floor(atlas.data.byteLength / 4)),
    environmentColors: environment?.colors ?? new Float32Array(4),
    environmentTables,
    parameters: writeParameters(scene, camera, options, lights.count, atlas.width),
  };
}

/**
 * Traces the input on the GPU and resolves linear RGBA float data (`rgba`, width * height * 4, rows from the top, the
 * average of `samples` paths) with the adapter name and timings in seconds.
 */
export function traceNative(input, { width, height, samples }) {
  const addonPath = findNativeAddon();
  if (!addonPath) throw new Error('The native tracer is not built. Run `npm run build` in packages/render-native.');
  const addon = createRequire(import.meta.url)(addonPath);
  return addon.traceScene(input, { width, height, samples });
}
