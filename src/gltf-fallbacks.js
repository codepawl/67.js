// Rewrites the parts of a glTF document that common Sketchfab files get wrong, so that they load instead of throwing.
// parseGltf imports this module only when a file needs it, so it adds nothing to a scene that loads a clean file.

const SPECULAR_GLOSSINESS = 'KHR_materials_pbrSpecularGlossiness';

/** Paths (as arrays of keys) to every texture reference of a material that reads the given UV set. */
function collectTextureKeys(value, uvSet, path = [], found = []) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    if (!child || typeof child !== 'object') continue;
    const isTextureReference = Number.isInteger(child.index) && (child.texCoord ?? 0) === uvSet;
    if (isTextureReference) found.push([...path, key]);
    else collectTextureKeys(child, uvSet, [...path, key], found);
  }
  return found;
}

function referenceAt(root, path) {
  return path.reduce((node, key) => node[key], root);
}

// The shader samples only these slots with the second UV set; the base color map and the layer maps read the first.
const SECOND_SET_SLOTS = new Set(['normalTexture', 'metallicRoughnessTexture', 'occlusionTexture', 'emissiveTexture']);

/**
 * KHR_materials_pbrSpecularGlossiness to metallic-roughness, the way Blender's importer approximates it: the diffuse
 * color becomes the base color, the surface is dielectric, and roughness is 1 minus the glossiness factor. The specular
 * color and the specularGlossinessTexture are dropped, because reading them needs a pass over the image pixels.
 */
function convertSpecularGlossiness(document, warnings) {
  const converted = [];
  document.materials?.forEach((material, index) => {
    const specularGlossiness = material?.extensions?.[SPECULAR_GLOSSINESS];
    if (!specularGlossiness) return;
    const pbr = { metallicFactor: 0, roughnessFactor: 1 - (specularGlossiness.glossinessFactor ?? 1) };
    if (specularGlossiness.diffuseFactor) pbr.baseColorFactor = specularGlossiness.diffuseFactor;
    if (specularGlossiness.diffuseTexture) pbr.baseColorTexture = specularGlossiness.diffuseTexture;
    material.pbrMetallicRoughness = pbr;
    delete material.extensions[SPECULAR_GLOSSINESS];
    if (!Object.keys(material.extensions).length) delete material.extensions;
    const dropped = specularGlossiness.specularGlossinessTexture ? ' and its specularGlossinessTexture' : '';
    converted.push(`${material.name ?? `material ${index}`}${dropped}`);
  });
  if (!converted.length) return;
  document.extensionsUsed = document.extensionsUsed?.filter(name => name !== SPECULAR_GLOSSINESS);
  document.extensionsRequired = document.extensionsRequired?.filter(name => name !== SPECULAR_GLOSSINESS);
  warnings.push(`${SPECULAR_GLOSSINESS} converted to metallic-roughness (diffuse color as base color, metallic 0, roughness 1 - glossiness, specular color not read) in ${converted.join(', ')}.`);
}

/**
 * A base color or layer map on TEXCOORD_1 cannot be sampled. When every map of the material reads TEXCOORD_1 (Blender
 * writes this for a material whose only UV map is the second one), the primitives get that set as TEXCOORD_0 and the maps
 * move with it. When the material also has maps on TEXCOORD_0, the maps that cannot read TEXCOORD_1 are dropped.
 */
function moveSecondSetTextures(document, warnings) {
  const movedMaterials = new Set();
  const movedNames = [];
  const droppedNames = [];
  document.materials?.forEach((material, index) => {
    const secondSet = collectTextureKeys(material, 1);
    const unsupported = secondSet.filter(path => !SECOND_SET_SLOTS.has(path.at(-1)));
    if (!unsupported.length) return;
    const name = material.name ?? `material ${index}`;
    if (collectTextureKeys(material, 0).length === 0) {
      for (const path of secondSet) {
        const reference = referenceAt(material, path);
        delete reference.texCoord;
        // A KHR_texture_transform texCoord override of 1 would otherwise contradict the promoted set.
        if (reference.extensions?.KHR_texture_transform) delete reference.extensions.KHR_texture_transform.texCoord;
      }
      movedMaterials.add(index);
      movedNames.push(name);
      return;
    }
    for (const path of unsupported) {
      delete referenceAt(material, path.slice(0, -1))[path.at(-1)];
      droppedNames.push(`${path.at(-1)} of ${name}`);
    }
  });
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if (!movedMaterials.has(primitive.material) || !primitive.attributes) continue;
      const secondSetAccessor = primitive.attributes.TEXCOORD_1;
      delete primitive.attributes.TEXCOORD_1;
      if (secondSetAccessor === undefined) delete primitive.attributes.TEXCOORD_0;
      else primitive.attributes.TEXCOORD_0 = secondSetAccessor;
    }
  }
  if (movedNames.length) warnings.push(`Read the textures of ${movedNames.join(', ')} from TEXCOORD_1 as the first UV set, because the base color and layer maps can only read the first.`);
  if (droppedNames.length) warnings.push(`Dropped ${droppedNames.join(', ')}: a base color or layer map on TEXCOORD_1 cannot be sampled beside maps on TEXCOORD_0.`);
}

/**
 * A primitive without the UV set a texture reads cannot sample it. Such a primitive gets its own copy of the material
 * without those textures, and the original stays for the primitives that do have UVs.
 */
function dropTexturesWithoutUvs(document, warnings) {
  const copiesByKey = new Map();
  const dropped = new Set();
  const missingAttributes = new Set();
  const materialNames = new Set();
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const material = document.materials?.[primitive.material];
      if (!material) continue;
      const missingSets = [0, 1].filter(uvSet => primitive.attributes?.[`TEXCOORD_${uvSet}`] === undefined);
      const paths = missingSets.flatMap(uvSet => collectTextureKeys(material, uvSet));
      if (!paths.length) continue;
      const key = `${primitive.material}:${missingSets.join()}`;
      if (!copiesByKey.has(key)) {
        const copy = structuredClone(material);
        for (const path of paths) {
          delete referenceAt(copy, path.slice(0, -1))[path.at(-1)];
          dropped.add(path.at(-1));
        }
        document.materials.push(copy);
        copiesByKey.set(key, document.materials.length - 1);
      }
      for (const uvSet of missingSets) missingAttributes.add(`TEXCOORD_${uvSet}`);
      materialNames.add(material.name ?? `material ${primitive.material}`);
      primitive.material = copiesByKey.get(key);
    }
  }
  if (!dropped.size) return;
  warnings.push(`Dropped ${[...dropped].sort().join(', ')} from primitives without ${[...missingAttributes].sort().join(' or ')}, which cannot sample a texture (material ${[...materialNames].sort().join(', ')}).`);
}

/** Paths to every texture reference whose texCoord the test refuses: a negative number, or a set above the two Crucible reads. */
function collectTexCoordKeys(value, isUnreadable, path = [], found = []) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    if (!child || typeof child !== 'object') continue;
    if (Number.isInteger(child.index) && typeof child.texCoord === 'number' && isUnreadable(child.texCoord)) found.push([...path, key]);
    else collectTexCoordKeys(child, isUnreadable, [...path, key], found);
  }
  return found;
}

/**
 * Blender writes texCoord -1 for a map on a primitive that has no UVs, and some exporters write a roughness of 2. The
 * spec forbids both, and three.js draws the file anyway: the map is skipped and the factor is clamped. This does the same
 * and says so, so one bad value does not refuse the whole file.
 */
function repairOutOfSpecMaterialValues(document, warnings) {
  const droppedNames = [];
  const clampedNames = [];
  const highSetNames = [];
  document.materials?.forEach((material, index) => {
    if (!material || typeof material !== 'object') return;
    const name = material.name ?? `material ${index}`;
    for (const path of collectTexCoordKeys(material, texCoord => texCoord < 0)) {
      delete referenceAt(material, path.slice(0, -1))[path.at(-1)];
      droppedNames.push(`${path.at(-1)} of ${name}`);
    }
    for (const path of collectTexCoordKeys(material, texCoord => texCoord > 1)) {
      delete referenceAt(material, path.slice(0, -1))[path.at(-1)];
      highSetNames.push(`${path.at(-1)} of ${name}`);
    }
    const pbr = material.pbrMetallicRoughness;
    if (!pbr || typeof pbr !== 'object') return;
    for (const field of ['metallicFactor', 'roughnessFactor']) {
      const value = pbr[field];
      if (!Number.isFinite(value) || (value >= 0 && value <= 1)) continue;
      pbr[field] = Math.min(1, Math.max(0, value));
      clampedNames.push(`${field} ${value} of ${name}`);
    }
  });
  if (droppedNames.length) warnings.push(`Dropped ${droppedNames.join(', ')}: a negative texCoord names no UV set.`);
  if (highSetNames.length) warnings.push(`Dropped ${highSetNames.join(', ')}: Crucible reads only TEXCOORD_0 and TEXCOORD_1, and the texCoord names a later set.`);
  if (clampedNames.length) warnings.push(`Clamped ${clampedNames.join(', ')} to 0..1.`);
}

/** Rewrites the document in place and returns the warnings that tell the caller what changed. */
export function applyGltfFallbacks(document) {
  const warnings = [];
  repairOutOfSpecMaterialValues(document, warnings);
  convertSpecularGlossiness(document, warnings);
  moveSecondSetTextures(document, warnings);
  dropTexturesWithoutUvs(document, warnings);
  return warnings;
}

