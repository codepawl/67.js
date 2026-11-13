// The FORMAT-v2 input a native render job sends to the `cycles` kernel. The v1 material tables keep fewer fields than a
// FORMAT-v2 material record holds, so the job takes what the tables carry from the tables (a scene that uses nothing else packs
// to the bytes it always did) and lays the rest of the material over it: blend opacity, sheen, specular, anisotropy,
// iridescence, attenuation and the layer textures. A flattened scene and an instanced one go through the same records, so a
// part looks the same whether or not other geometry in the scene is shared. The maps go from the materials into the FORMAT-v2
// texture pool without the v1 atlas, so the pool (1 GiB) is the limit on them, not the atlas (4096 x 16384 texels).
import { buildNativeV1Tables, packNativeMaterialTables, withVirtualAtlas } from './pack-input.mjs';
import { buildNativeInputV2, reduceV1MaterialTable, upgradeNativeInputV1ToV2, validateDiffuseTransmission } from './pack-input-v2.mjs';

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

// The kernel reads anisotropy as the Cycles Principled parameters: a strength from 0 to 1 that stretches the roughness, and the
// rotation in turns. A 67js material (glTF KHR_materials_anisotropy) gives a strength that sets the tangent roughness and a
// rotation in radians. This is the same conversion bench/cycles-parity/render-cycles.py applies for Blender, so the kernel
// draws the lobe Cycles draws for the material.
function cyclesAnisotropyFields(material, roughness) {
  const alpha = roughness * roughness;
  const tangentAlpha = alpha + (1 - alpha) * material.anisotropy * material.anisotropy;
  return {
    anisotropy: Math.min((1 - alpha / tangentAlpha) / 0.9, 1),
    anisotropyRotation: (material.anisotropyRotation ?? 0) / (2 * Math.PI),
    roughness: (alpha * tangentAlpha) ** 0.25,
  };
}

// A thin sheet that lets diffuse light through (a curtain, a leaf, a lampshade): the share of the diffuse layer that leaves
// through the far side, and the colour of that light (the base colour when it is left out). The ranges follow the other layers
// of material-layers.js: a weight between 0 and 1, a linear colour with each channel between 0 and 1.
function diffuseTransmissionFields(material) {
  validateDiffuseTransmission(material);
  const { diffuseTransmission, diffuseTransmissionColor } = material;
  if (!(diffuseTransmission > 0)) return {};
  const fields = { diffuseTransmission };
  if (diffuseTransmissionColor !== undefined) fields.diffuseTransmissionColor = Array.from(diffuseTransmissionColor);
  return fields;
}

function layerFields(material, resolved) {
  const fields = { ...diffuseTransmissionFields(material) };
  if (material.specular !== undefined) fields.specular = material.specular;
  if (material.specularColor !== undefined && !isWhite(material.specularColor)) fields.specularColor = material.specularColor;
  if (material.anisotropy > 0) Object.assign(fields, cyclesAnisotropyFields(material, resolved.roughness));
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
    if (material[name] === undefined) continue;
    if (!isRecordValue(material[name])) {
      throw new TypeError(`Material field ${name} must be a finite number, a boolean or an array of finite numbers; got ${String(material[name])}.`);
    }
    fields[name] = material[name];
  }
  return fields;
}

function isRecordValue(value) {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return false;
  return Array.from(value).every(channel => typeof channel === 'number' && Number.isFinite(channel));
}

function sharesImage(firstDescriptor, secondDescriptor) {
  return Boolean(firstDescriptor?.image) && firstDescriptor.image === secondDescriptor?.image;
}

// The kernel reads a coat's weight and roughness from the red and green channels of one map, and a sheen's tint and
// roughness from the colour and alpha of one map. A 67js material (glTF) keeps each roughness in a map of its own. So the
// weight or tint map is carried only when its other channel cannot change the roughness: the roughness factor is 0, or the
// material's roughness map is the same image.
function coatMapFitsTheSlot(material, resolved) {
  return !(resolved.clearcoatRoughness > 0) || sharesImage(material.layerMaps?.clearcoatTexture, material.layerMaps?.clearcoatRoughnessTexture);
}

function sheenMapFitsTheSlot(material) {
  return !(material.sheenRoughness > 0) || sharesImage(material.layerMaps?.sheenColorTexture, material.layerMaps?.sheenRoughnessTexture);
}

// A layer texture only matters while its layer is on, so a texture on a layer that is off stays out of the record.
function layerTextures(material, resolved, resolveTexture) {
  const textures = {};
  const keep = (slot, image) => {
    if (image) textures[slot] = image;
  };
  if (resolved.transmission > 0) keep('transmission', resolved.transmissionTexture);
  if (resolved.clearcoat > 0) {
    if (coatMapFitsTheSlot(material, resolved)) keep('coatWeightRoughness', resolved.clearcoatTexture);
    keep('coatNormal', resolveTexture(material.layerMaps?.clearcoatNormalTexture));
  }
  if (material.anisotropy > 0) keep('anisotropy', resolveTexture(material.layerMaps?.anisotropyTexture));
  if (hasColor(material.sheenColor) && sheenMapFitsTheSlot(material)) keep('sheenColorRoughness', resolveTexture(material.layerMaps?.sheenColorTexture));
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
  const fields = { ...blendFields(material, resolved), ...layerFields(material, resolved) };
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
  const tables = packNativeMaterialTables(scene.traceMaterials, null, withVirtualAtlas(pack));
  const reducedMaterials = reduceV1MaterialTable({
    materials: tables.materials,
    atlas: tables.atlas,
    atlasWidth: tables.atlasWidth,
    virtualTextures: tables.virtualTextures,
    subsurfaceVec4Offset: tables.subsurfaceVec4Offset,
    materialCount: scene.traceMaterials.length,
    carriedFields: carriedMaterialFieldsOfScene(scene, resolveTexture),
    textureMips: options.textureMips,
    texturePoolMaxBytes: options.texturePoolMaxBytes,
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
  const upgradeOptions = {
    ...(options.samples === undefined ? {} : { samples: options.samples }),
    ...(options.textureMips === undefined ? {} : { textureMips: options.textureMips }),
    ...(options.texturePoolMaxBytes === undefined ? {} : { texturePoolMaxBytes: options.texturePoolMaxBytes }),
  };
  return upgradeNativeInputV1ToV2(buildNativeV1Tables(scene, camera, options, withVirtualAtlas(pack)), upgradeOptions, carriedFields, scene.partRayVisibility ?? null);
}
