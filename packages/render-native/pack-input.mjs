// Packs a trace scene into the tables the native kernel reads. It imports nothing from Node, so the job page can run it too.
// 16 vectors: the 12 of the camera, lights and seed, the fog box and medium, and the subsurface table's first vector index.
const PARAMETER_BYTES = 16 * 16;
const SUN_CONE_COSINE = Math.cos(Math.PI / 360);

// A thin lens rides in the unused fourth float of the four camera vectors: aperture radius (eye), focus distance (forward),
// aperture blades (right) and aperture rotation in radians (above). The legacy kernel reads only xyz of those vectors, so it
// draws a pinhole as before; the "cycles" kernel gets them when the input is upgraded to FORMAT-v2. A pinhole leaves all four 0.
export const THIN_LENS_FLOAT_INDEXES =Object.freeze({ apertureRadius: 3, focalDistance: 7, apertureBlades: 11, apertureRotation: 15 });

function writeThinLens(floats, camera) {
  if (!(camera.apertureRadius > 0)) {
    return;
  }
  for (const [fieldName, floatIndex] of Object.entries(THIN_LENS_FLOAT_INDEXES)) {
    floats[floatIndex] = Number(camera[fieldName] ?? 0);
  }
}

function writeParameters(scene, camera, options, lightCount, atlasWidth, subsurfaceOffset) {
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
  writeThinLens(floats, camera);
  floats.set([...(sun?.direction ?? [0, 1, 0]), 0], 16);
  floats.set([...(sun?.color ?? [0, 0, 0]), SUN_CONE_COSINE], 20);
  floats.set([environment?.width ?? 1, environment?.height ?? 1, environment?.intensity ?? 1, environment?.total ?? 1], 24);
  floats.set([environment?.cosine ?? 1, environment?.sine ?? 0, scene.surfaceOffset, scene.farDistance], 28);
  // The fourth float is the noise threshold: pixels under it stop early, and 0 draws every sample.
  floats.set([camera.halfWidth, camera.halfHeight, options.fireflyClamp ?? 20, options.noiseThreshold ?? 0], 32);
  integers.set([options.width, options.height, options.bounces, lightCount], 36);
  integers.set([(sun ? 1 : 0) + lightCount + (environment ? 1 : 0), sun ? 1 : 0, environment ? 1 : 0, 0], 40);
  words.set([options.seed >>> 0, atlasWidth, 0, 0], 44);
  const { volume } = scene;
  floats.set([...(volume?.minimum ?? [0, 0, 0]), volume?.density ?? 0], 48);
  floats.set([...(volume?.maximum ?? [0, 0, 0]), volume?.anisotropy ?? 0], 52);
  floats.set([...(volume?.albedo ?? [1, 1, 1]), volume?.maxDistance ?? 0], 56);
  words.set([subsurfaceOffset, 0, 0, 0], 60);
  // Word 61 carries `environment.cameraIntensity` for the "cycles" kernel upgrade; all bits zero means none, so a strength of 0 is stored as -0.
  // The legacy kernel does not read it.
  if (environment?.cameraIntensity !== undefined) {
    floats[61] = environment.cameraIntensity === 0 ? -0 : environment.cameraIntensity;
  }
  return new Uint8Array(buffer);
}

/**
 * Packs a trace scene (from `buildTraceScene`) and its camera into the tables the kernel reads.
 * `pack` is the module `src/path-tracer-gpu-pack.js`, passed in so this package never imports the engine's source.
 */
export function buildNativeInput(scene, camera, options, pack) {
  if (scene.partRayVisibility) {
    throw new TypeError('A part sets rayVisibility to hide from a ray kind, which the v1 tables of kernel "legacy" cannot carry. Pack the scene for kernel "cycles" with buildFlattenedJobNativeInput (or build it with { instancing: true } and use buildJobNativeInput), or drop the rayVisibility of the part.');
  }
  return buildNativeV1Tables(scene, camera, options, pack);
}

/** The v1 tables of a flattened scene without the refusal above, which leave `scene.partRayVisibility` out: a light bake, and a job that reads it itself. */
export function buildNativeV1Tables(scene, camera, options, pack) {
  if (scene.instances) {
    throw new TypeError('buildNativeInput packs flattened scenes for kernel "legacy" and cannot read instances: build the scene without { instancing: true }, or pack it with buildNativeInputV2 and trace with kernel "cycles".');
  }
  const materialTables = packNativeMaterialTables(scene.materials, scene.shadowOnlyParts, pack);
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
    materials: materialTables.materials,
    lights: lights.table.data,
    atlas: materialTables.atlas,
    ...(materialTables.virtualTextures ? { virtualTextures: materialTables.virtualTextures } : {}),
    environmentColors: environment?.colors ?? new Float32Array(4),
    environmentTables,
    parameters: writeParameters(scene, camera, options, lights.count, materialTables.atlasWidth, materialTables.subsurfaceVec4Offset),
  };
}

/**
 * The v1 material tables of resolved trace materials: the material table with the subsurface table after it (its offset is 0
 * when no material scatters light under its surface, which keeps the walk out of the kernel), the texture atlas and its width.
 */
export function packNativeMaterialTables(materials, shadowOnlyParts, pack) {
  const atlas = pack.packAtlas(materials);
  const virtualTextures = atlas.virtualTextures ? { virtualTextures: atlas.virtualTextures } : {};
  const materialData = pack.packMaterials(materials, atlas, shadowOnlyParts).data;
  const usesSubsurface = pack.sceneUsesSubsurface(materials);
  const subsurfaceData = usesSubsurface ? pack.packSubsurface(materials).data : new Float32Array(0);
  const combined = new Float32Array(materialData.length + subsurfaceData.length);
  combined.set(materialData);
  combined.set(subsurfaceData, materialData.length);
  return {
    materials: combined,
    atlas: new Uint32Array(atlas.data.buffer, atlas.data.byteOffset, Math.floor(atlas.data.byteLength / 4)),
    atlasWidth: atlas.width,
    subsurfaceVec4Offset: usesSubsurface ? materialData.length / 4 : 0,
    ...virtualTextures,
  };
}

const MATERIAL_TEXTURE_FIELDS = Object.freeze(['texture', 'normalTexture', 'surfaceTexture', 'emissiveTexture']);

/**
 * A stand-in for `packAtlas` that copies no pixel. Each distinct texture gets the rectangle `{ x: its number, y: 0 }` in the
 * material table, and `virtualTextures[number]` holds the texture itself. The FORMAT-v2 job packs read the maps from there
 * straight into the texture pool, so the maps are limited by the pool (`TEXTURE_POOL_MAX_BYTES`) and not by the 4096 x 16384
 * texels of the v1 atlas.
 */
export function packVirtualAtlas(materials) {
  const placements = new Map();
  const virtualTextures = [];
  for (const material of materials) {
    for (const field of MATERIAL_TEXTURE_FIELDS) {
      const texture = material[field];
      if (!texture || placements.has(texture.data)) continue;
      placements.set(texture.data, { x: virtualTextures.length, y: 0 });
      virtualTextures.push(texture);
    }
  }
  return { placements, width: 1, height: 1, data: new Uint8Array(4), virtualTextures };
}

/** `pack` with the atlas step replaced by `packVirtualAtlas`; the tables it packs carry `virtualTextures`. */
export function withVirtualAtlas(pack) {
  return { ...pack, packAtlas: packVirtualAtlas };
}

// The words of the parameter block the texel entry reads: the texel count where an image holds its width, and the sample
// count in the third word after the seed and the atlas width.
const TEXEL_SAMPLES_WORD = 46;
const NO_CAMERA = { eye: [0, 0, 0], forward: [0, 0, -1], right: [1, 0, 0], above: [0, 1, 0], halfWidth: 1, halfHeight: 1 };

/**
 * The tables of a light bake: the scene without a camera, with the texel count and the sample count in the parameter block.
 * `options` holds `texelCount`, `samples`, `bounces`, `seed` and `fireflyClamp`; `pack` is as for `buildNativeInput`. A bake ignores
 * a part's `rayVisibility`: its v1 tables carry no visibility.
 */
export function buildNativeTexelInput(scene, options, pack) {
  // The bake's `bounces` counts the leg that leaves the texel; the kernel counts the bounces after its first hit.
  const input = buildNativeV1Tables(scene, NO_CAMERA, { ...options, bounces: options.bounces - 1, width: options.texelCount, height: 1 }, pack);
  const words = new Uint32Array(input.parameters.buffer, input.parameters.byteOffset, input.parameters.byteLength / 4);
  words[TEXEL_SAMPLES_WORD] = options.samples;
  return input;
}
