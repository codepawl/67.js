// The FORMAT-v2 input a native render job sends to the `cycles` kernel. The v1 material tables keep fewer fields than a
// FORMAT-v2 material record holds, so the job takes what the tables carry from the tables (a scene that uses nothing else packs
// to the bytes it always did) and lays the rest of the material over it: blend opacity, sheen, specular, anisotropy,
// iridescence, attenuation and the layer textures. A flattened scene and an instanced one go through the same records, so a
// part looks the same whether or not other geometry in the scene is shared.
import { buildNativeInput, packNativeMaterialTables } from './pack-input.mjs';
import { buildNativeInputV2, reduceV1MaterialTable, upgradeNativeInputV1ToV2 } from './pack-input-v2.mjs';

const ALL_LIGHT_GROUPS = 0xffffffff;

// Glossy iridescence defaults of glTF (KHR_materials_iridescence), which the 67js material layers follow.
const DEFAULT_IRIDESCENCE_IOR = 1.3;
const DEFAULT_IRIDESCENCE_THICKNESS = 400;

// Record fields a material may set by their record names; a material that leaves one out keeps the record default.
const RECORD_FIELDS = Object.freeze([
  'specularIorLevel', 'diffuseRoughness', 'f82Tint', 'f82Metallic', 'coatTint', 'coatIor', 'coatNormalScale', 'bumpDistance',
  'thinWalled', 'multiscatterGgx', 'transparentShadow', 'emissiveMis',
]);

function isWhite(color) {
  return Array.from(color).every(channel => channel === 1);
}

function hasColor(color) {
  return color !== undefined && Array.from(color).some(channel => channel !== 0);
}

function blendFields(material, resolved) {
  // A cutout (mask, or a graph opacity cut at one half) keeps the cutoff the tables carry.
  if (material.alphaMode !== 'blend' || resolved.alphaCutoff > 0) return {};
  const opacity = material.opacity ?? 1;
  // Blending at full opacity with no texture changes no pixel; leaving it opaque keeps the faster opaque path.
  if (!(opacity < 1) && !resolved.texture) return {};
  return { alphaMode: 'blend', opacity };
}

function layerFields(material) {
  const fields = {};
  if (material.specular !== undefined) fields.specular = material.specular;
  if (material.specularColor !== undefined && !isWhite(material.specularColor)) fields.specularColor = material.specularColor;
  if (material.anisotropy > 0) {
    fields.anisotropy = material.anisotropy;
    fields.anisotropyRotation = material.anisotropyRotation ?? 0;
  }
  if (material.iridescence > 0) {
    fields.iridescence = material.iridescence;
    fields.iridescenceIor = material.iridescenceIor ?? DEFAULT_IRIDESCENCE_IOR;
    fields.iridescenceThickness = material.iridescenceThickness ?? DEFAULT_IRIDESCENCE_THICKNESS;
  }
  if (hasColor(material.sheenColor)) {
    fields.sheenColor = material.sheenColor;
    fields.sheenRoughness = material.sheenRoughness ?? 0;
  }
  if (material.attenuationDistance > 0 && Number.isFinite(material.attenuationDistance)) {
    fields.attenuationDistance = material.attenuationDistance;
    fields.attenuationColor = material.attenuationColor ?? [1, 1, 1];
  }
  for (const name of RECORD_FIELDS) {
    if (material[name] !== undefined) fields[name] = material[name];
  }
  return fields;
}

// A layer texture only matters while its layer is on, so a texture on a layer that is off stays out of the record.
function layerTextures(material, resolved, resolveTexture) {
  const textures = {};
  const keep = (slot, image) => {
    if (image) textures[slot] = image;
  };
  if (resolved.transmission > 0) keep('transmission', resolved.transmissionTexture);
  if (resolved.clearcoat > 0) {
    keep('coatWeightRoughness', resolved.clearcoatTexture);
    keep('coatNormal', resolveTexture(material.layerMaps?.clearcoatNormalTexture));
  }
  if (material.anisotropy > 0) keep('anisotropy', resolveTexture(material.layerMaps?.anisotropyTexture));
  if (hasColor(material.sheenColor)) keep('sheenColorRoughness', resolveTexture(material.layerMaps?.sheenColorTexture));
  if (material.bumpDistance > 0) keep('bump', resolveTexture(material.bumpMap));
  return textures;
}

/**
 * What a part's material sets beyond the v1 job tables, named as `packMaterialRecordV2` reads it: blend opacity, specular and
 * its tint, anisotropy, iridescence, sheen, attenuation, the rest of the record and the layer textures (`textures`, images
 * the collector can take). `material` is the part's own material, `resolved` its resolved trace material and
 * `resolveTexture` turns a texture descriptor into such an image (`resolveTexture` of src/path-tracer-scene.js). A material
 * that sets none of these gives an empty object, which packs to the record the v1 tables give.
 */
export function carriedMaterialFields(material, resolved, resolveTexture) {
  const fields = { ...blendFields(material, resolved), ...layerFields(material) };
  const textures = layerTextures(material, resolved, resolveTexture);
  if (Object.keys(textures).length > 0) fields.textures = textures;
  return fields;
}

/**
 * The carried fields of every material of a trace scene, in the order of its material table: an instanced scene holds the
 * parts' own materials in `materials` and the resolved ones in `traceMaterials`; a flattened scene holds the resolved ones
 * in `materials` and the parts' own in `partMaterials`.
 */
export function carriedMaterialFieldsOfScene(scene, resolveTexture) {
  const ownMaterials = scene.instances ? scene.materials : scene.partMaterials;
  const resolvedMaterials = scene.instances ? scene.traceMaterials : scene.materials;
  if (!Array.isArray(ownMaterials) || !Array.isArray(resolvedMaterials)) {
    throw new TypeError('carriedMaterialFieldsOfScene reads a scene from buildTraceScene (instanced, or flattened with partMaterials).');
  }
  if (typeof resolveTexture !== 'function') {
    throw new TypeError('carriedMaterialFieldsOfScene needs `resolveTexture`, the function of that name in src/path-tracer-scene.js.');
  }
  return resolvedMaterials.map((resolved, index) => carriedMaterialFields(ownMaterials[index] ?? {}, resolved, resolveTexture));
}

/**
 * Packs an instanced trace scene (`buildTraceScene` with `{ instancing: true }`) for the `cycles` kernel with the materials,
 * light masks and textures of the job. `pack` is `src/path-tracer-gpu-pack.js`; `options` are those of the job.
 */
export function buildJobNativeInput(scene, camera, options, pack, resolveTexture) {
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
    carriedFields: carriedMaterialFieldsOfScene(scene, resolveTexture),
  });
  const instances = scene.instances.map(instance => {
    const lightMask = reducedMaterials.materialLightMasks[instance.materialIndex] ?? ALL_LIGHT_GROUPS;
    return { ...instance, lightMask, lightMaskHi: lightMask === ALL_LIGHT_GROUPS ? ALL_LIGHT_GROUPS : 0 };
  });
  const { fireflyClamp, ...packOptions } = options;
  return buildNativeInputV2(scene, camera, { ...packOptions, instances, reducedMaterials });
}

/**
 * Packs a flattened trace scene for the `cycles` kernel the way the kernel upgrades v1 tables, with the carried material
 * fields added: the geometry, lights and environment are those of `buildNativeInput`, so a scene that sets no carried field
 * gives the input the kernel builds from the v1 tables itself.
 */
export function buildFlattenedJobNativeInput(scene, camera, options, pack, resolveTexture) {
  const carriedFields = carriedMaterialFieldsOfScene(scene, resolveTexture);
  // The sample count goes into the kernel parameters, as it does when the kernel upgrades the tables itself.
  const upgradeOptions = options.samples === undefined ? {} : { samples: options.samples };
  return upgradeNativeInputV1ToV2(buildNativeInput(scene, camera, options, pack), upgradeOptions, carriedFields);
}
