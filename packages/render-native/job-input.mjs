// The FORMAT-v2 input a native render job sends for an instanced scene. A job without shared geometry sends v1 tables, whose
// material tables keep fewer fields than FORMAT-v2 materials do. An instanced job reduces its materials the same way, so a
// part looks the same whether or not other geometry in the scene is shared.
import { packNativeMaterialTables } from './pack-input.mjs';
import { buildNativeInputV2, reduceV1MaterialTable } from './pack-input-v2.mjs';

const ALL_LIGHT_GROUPS = 0xffffffff;

/**
 * Packs an instanced trace scene (`buildTraceScene` with `{ instancing: true }`) for the `cycles` kernel with the materials,
 * light masks and textures of the v1 job tables. `pack` is `src/path-tracer-gpu-pack.js`; `options` are those of the job.
 */
export function buildJobNativeInput(scene, camera, options, pack) {
  if (!scene?.instances || !scene.traceMaterials) {
    throw new TypeError('buildJobNativeInput packs an instanced scene: build it with buildTraceScene(parts, environment, { instancing: true }) and share a geometry between two parts.');
  }
  const tables = packNativeMaterialTables(scene.traceMaterials, null, pack);
  const reducedMaterials = reduceV1MaterialTable({
    materials: tables.materials,
    atlas: tables.atlas,
    atlasWidth: tables.atlasWidth,
    subsurfaceVec4Offset: tables.subsurfaceVec4Offset,
    materialCount: scene.traceMaterials.length,
  });
  const instances = scene.instances.map(instance => {
    const lightMask = reducedMaterials.materialLightMasks[instance.materialIndex] ?? ALL_LIGHT_GROUPS;
    return { ...instance, lightMask, lightMaskHi: lightMask === ALL_LIGHT_GROUPS ? ALL_LIGHT_GROUPS : 0 };
  });
  const { fireflyClamp, ...packOptions } = options;
  return buildNativeInputV2(scene, camera, { ...packOptions, instances, reducedMaterials });
}
