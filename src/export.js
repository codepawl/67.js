import { validateMorphGeometry, validateMorphPose } from './morph.js';
import { gltfExtensionsFromLayers, LAYER_TEXTURE_SLOTS } from './gltf-layers.js';
import { validateSkinGeometry } from './skinning.js';
import { boxProjectedGeometry, columnLengths } from './export-box-uv.js';
import { createTextureWriter } from './export-textures.js';
import { createGlbWriter } from './export-writer.js';
import { buildHierarchy, decomposeMatrix, hierarchyNodeFields, hostOfPart, normalizedWeights, relativeMatrix, writeAnimations, writeSkin } from './export-skeleton.js';

const EMISSIVE_STRENGTH = 'KHR_materials_emissive_strength';

function validateFloatChannel(values, length, label, bounded = false) {
  if (!(values instanceof Float32Array) || values.length !== length) {
    throw new TypeError(`${label} requires a Float32Array matching the vertex count.`);
  }
  for (const value of values) {
    if (!Number.isFinite(value) || (bounded && (value < 0 || value > 1))) {
      throw new RangeError(`${label} requires finite values${bounded ? ' within [0,1]' : ''}.`);
    }
  }
}

// glTF has no additive blending, so an add material is written as BLEND and loads back as blend.
const GLTF_ALPHA_MODES = { mask: 'MASK', blend: 'BLEND', add: 'BLEND' };

function writeAlphaFields(gltfMaterial, material) {
  const alphaMode = material.alphaMode ?? 'opaque';
  if (alphaMode !== 'opaque') {
    if (!Object.hasOwn(GLTF_ALPHA_MODES, alphaMode)) throw new Error("alphaMode must be 'opaque', 'mask', 'blend' or 'add'.");
    gltfMaterial.alphaMode = GLTF_ALPHA_MODES[alphaMode];
    validateFactor(material.opacity ?? 1, 'opacity');
    gltfMaterial.pbrMetallicRoughness.baseColorFactor[3] = material.opacity ?? 1;
  }
  if (alphaMode === 'mask') {
    validateFactor(material.alphaCutoff ?? 0.5, 'alphaCutoff');
    gltfMaterial.alphaCutoff = material.alphaCutoff ?? 0.5;
  }
  if (material.doubleSided === true) gltfMaterial.doubleSided = true;
}

function validateFactor(value, label, maximum = 1) {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || value < 0 || value > maximum) {
    throw new RangeError(`${label} requires a finite nonnegative Float32 value${maximum === 1 ? ' within [0,1]' : ''}.`);
  }
}

function validateColor(values, label) {
  if (!values || values.length !== 3) throw new TypeError(`${label} requires three linear RGB components.`);
  for (const value of values) validateFactor(value, label);
}

function validateGeometry(geometry) {
  const count = geometry?.positions?.length;
  if (!Number.isSafeInteger(count) || count < 3 || count % 3 !== 0) {
    throw new TypeError('GLB positions require a nonempty array of XYZ vertices.');
  }
  validateFloatChannel(geometry.positions, count, 'GLB positions');
  validateFloatChannel(geometry.normals, count, 'GLB normals');
  for (let offset = 0; offset < count; offset += 3) {
    const length = Math.hypot(geometry.normals[offset], geometry.normals[offset + 1], geometry.normals[offset + 2]);
    if (Math.abs(length - 1) > 0.001) throw new RangeError('GLB normals require unit vectors.');
  }
  if (geometry.colors !== undefined) validateFloatChannel(geometry.colors, count, 'GLB colors', true);
  if (geometry.uvs !== undefined) validateFloatChannel(geometry.uvs, count / 3 * 2, 'GLB UVs');
  if (!(geometry.indices instanceof Uint32Array) || geometry.indices.length === 0 || geometry.indices.length % 3 !== 0) {
    throw new TypeError('GLB indices require a nonempty Uint32Array of triangles.');
  }
  for (const index of geometry.indices) {
    if (index >= count / 3) throw new RangeError('GLB index exceeds the vertex count.');
  }
}

// A skinned part takes its pose from its joints, so only parts with a node transform need a valid matrix.
function validateMatrix(matrix) {
  if (!matrix || matrix.length !== 16 || Array.from(matrix).some(value => !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))) {
    throw new RangeError('GLB matrix requires 16 finite components.');
  }
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) {
    throw new RangeError('GLB matrix requires an affine transform.');
  }
  validateTransformColumns(matrix);
}

function validatePart(part) {
  const material = part.material;
  if (!material || typeof material !== 'object') throw new TypeError('GLB parts require a material.');
  validateColor(material.color, 'GLB base color');
  validateColor(material.emissiveColor ?? material.color, 'GLB emissive color');
  validateFactor(material.metallic, 'GLB metallic factor');
  validateFactor(material.roughness, 'GLB roughness factor');
  validateFactor(material.emission ?? 0, 'GLB emission', Infinity);
}

function validateTransformColumns(matrix) {
  const columns = [0, 4, 8].map(offset => {
    const values = [Math.fround(matrix[offset]), Math.fround(matrix[offset + 1]), Math.fround(matrix[offset + 2])];
    const length = Math.hypot(...values);
    // Three's matrix decomposition divides by scale, so zero scales cannot roundtrip.
    if (length === 0) throw new RangeError('GLB matrix requires nonzero scales.');
    return values.map(value => value / length);
  });
  // Normalized column products remove scale dependence and allow Float32 TRS roundoff.
  const tolerance = 8 * 2 ** -23;
  for (let first = 0; first < 3; first++) {
    for (let second = first + 1; second < 3; second++) {
      let dot = 0;
      for (let axis = 0; axis < 3; axis++) dot += columns[first][axis] * columns[second][axis];
      if (Math.abs(dot) > tolerance) throw new RangeError('GLB matrix cannot preserve shear. Use a transform with orthogonal rotation and scale columns.');
    }
  }
}

const TEXTURE_CHANNELS = ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap'];
const OPTION_NAMES = ['clips', 'nodes', 'maxTextureSize'];

function validateOptions(options) {
  if (!options || typeof options !== 'object') throw new TypeError('GLB export options must be an object.');
  for (const name of Object.keys(options)) {
    if (!OPTION_NAMES.includes(name)) throw new TypeError(`GLB export does not take ${name}. Options: ${OPTION_NAMES.join(', ')}.`);
  }
  if (options.clips !== undefined && !Array.isArray(options.clips)) throw new TypeError('GLB export clips must be an array.');
  if (options.nodes !== undefined && !Array.isArray(options.nodes)) throw new TypeError('GLB export nodes must be an array.');
}

function validateSkinnedPart(part) {
  validateSkinGeometry(part.geometry, part.skin);
}

function createIdentityTracker() {
  const identities = new WeakMap();
  let next = 0;
  return object => {
    if (!identities.has(object)) identities.set(object, next++);
    return identities.get(object);
  };
}

function materialKeyOf(material, identify) {
  const textures = [...TEXTURE_CHANNELS, 'lightMap'].map(channel => material[channel] ? identify(material[channel]) : null);
  const layerTextures = Object.entries(material.layerMaps ?? {}).map(([name, descriptor]) => [name, identify(descriptor)]);
  const fields = { ...material };
  for (const channel of [...TEXTURE_CHANNELS, 'lightMap', 'layerMaps', 'pattern', 'boxMapScale', 'boxMapAxis']) delete fields[channel];
  return JSON.stringify([fields, textures, layerTextures, material.boxMapScale ?? 0, material.boxMapAxis ?? 1]);
}

/** Adds the layer textures to the KHR_materials_* objects, creating an extension that only has textures to carry. */
function writeLayerTextures(writer, textureWriter, material, layerExtensions) {
  for (const [extensionName, property] of LAYER_TEXTURE_SLOTS) {
    const descriptor = material.layerMaps?.[property];
    if (!descriptor) continue;
    if (!layerExtensions[extensionName]) {
      layerExtensions[extensionName] = {};
      writer.addExtension(extensionName);
    }
    layerExtensions[extensionName][property] = textureReference(textureWriter, descriptor, property);
  }
}

function textureReference(textureWriter, descriptor, channel) {
  const reference = { index: textureWriter.textureIndex(descriptor, channel) };
  if (descriptor.uvChannel === 1) reference.texCoord = 1;
  return reference;
}

/**
 * glTF has no light map slot, so a baked light map goes out as the emissive texture on TEXCOORD_1: the light that
 * arrives, tinted by the base colour factor and not by a base color texture. Parts with their own emission keep it.
 */
function writeLightMap(writer, textureWriter, material, gltfMaterial) {
  if (!material.lightMap || material.emissiveMap || (material.emission ?? 0) !== 0) return;
  const tint = material.color.map(channel => channel * (1 - material.metallic));
  gltfMaterial.emissiveFactor = tint;
  gltfMaterial.emissiveTexture = { index: textureWriter.textureIndex(material.lightMap, 'lightMap'), texCoord: 1 };
  const strength = material.lightMapScale ?? 1;
  if (strength !== 1) {
    gltfMaterial.extensions = { ...gltfMaterial.extensions, [EMISSIVE_STRENGTH]: { emissiveStrength: strength } };
    writer.addExtension(EMISSIVE_STRENGTH, { required: true });
  }
}

function writeMaterial(writer, textureWriter, material) {
  const pbr = { baseColorFactor: [...material.color, 1], metallicFactor: material.metallic, roughnessFactor: material.roughness };
  const gltfMaterial = {
    pbrMetallicRoughness: pbr,
    emissiveFactor: (material.emission ?? 0) === 0 ? [0, 0, 0] : Array.from(material.emissiveColor ?? material.color),
  };
  writeAlphaFields(gltfMaterial, material);
  const layerExtensions = gltfExtensionsFromLayers(material);
  for (const extensionName of Object.keys(layerExtensions)) writer.addExtension(extensionName);
  writeLayerTextures(writer, textureWriter, material, layerExtensions);
  if (Object.keys(layerExtensions).length > 0) gltfMaterial.extensions = layerExtensions;
  const strength = material.emission ?? 0;
  if (strength !== 0 && strength !== 1) {
    gltfMaterial.extensions = { ...gltfMaterial.extensions, [EMISSIVE_STRENGTH]: { emissiveStrength: strength } };
    writer.addExtension(EMISSIVE_STRENGTH, { required: true });
  }
  const textureOf = channel => textureReference(textureWriter, material[channel], channel);
  if (material.map) pbr.baseColorTexture = textureOf('map');
  if (material.metallicRoughnessMap) pbr.metallicRoughnessTexture = textureOf('metallicRoughnessMap');
  if (material.normalMap) gltfMaterial.normalTexture = { ...textureOf('normalMap'), scale: material.normalScale?.[0] ?? 1 };
  if (material.occlusionMap) gltfMaterial.occlusionTexture = { ...textureOf('occlusionMap'), strength: material.occlusionStrength ?? 1 };
  if (material.emissiveMap) gltfMaterial.emissiveTexture = textureOf('emissiveMap');
  writeLightMap(writer, textureWriter, material, gltfMaterial);
  return gltfMaterial;
}

function writeGeometry(writer, geometry) {
  const ARRAY_BUFFER = 34962;
  const attributes = { POSITION: writer.addAccessor(geometry.positions, 'VEC3', ARRAY_BUFFER), NORMAL: writer.addAccessor(geometry.normals, 'VEC3', ARRAY_BUFFER) };
  const primitive = { attributes, indices: writer.addAccessor(geometry.indices, 'SCALAR', 34963) };
  if (geometry.colors) attributes.COLOR_0 = writer.addAccessor(geometry.colors, 'VEC3', ARRAY_BUFFER);
  if (geometry.uvs) attributes.TEXCOORD_0 = writer.addAccessor(geometry.uvs, 'VEC2', ARRAY_BUFFER);
  if (geometry.lightUvs) attributes.TEXCOORD_1 = writer.addAccessor(geometry.lightUvs, 'VEC2', ARRAY_BUFFER);
  if (geometry.skinIndices) {
    attributes.JOINTS_0 = writer.addAccessor(Uint16Array.from(geometry.skinIndices), 'VEC4', ARRAY_BUFFER, { bounds: false });
    attributes.WEIGHTS_0 = writer.addAccessor(normalizedWeights(geometry.skinWeights), 'VEC4', ARRAY_BUFFER, { bounds: false });
  }
  if (geometry.morphTargets) {
    primitive.targets = geometry.morphTargets.map(target => {
      const channels = {};
      if (target.positions) channels.POSITION = writer.addAccessor(target.positions, 'VEC3', ARRAY_BUFFER);
      if (target.normals) channels.NORMAL = writer.addAccessor(target.normals, 'VEC3', ARRAY_BUFFER);
      return channels;
    });
  }
  return primitive;
}

function requireUvsForTextures(part) {
  const textured = TEXTURE_CHANNELS.some(channel => part.material[channel]);
  const boxMapped = (part.material.boxMapScale ?? 0) > 0;
  if (textured && !boxMapped && !part.geometry.uvs) {
    throw new RangeError(`GLB part ${part.name} has textures but its geometry has no uvs. Add a uv_unwrap node to the mesh stack, or set geometry.uvs.`);
  }
}

/**
 * Returns a self-contained GLB ArrayBuffer for the parts.
 * Options: `clips` (createAnimationClip form, track targets are node names), `nodes` (the `nodes` of a parsed asset,
 * which hold joints and groups, so skinned parts and clips keep their hierarchy), `maxTextureSize` (default 2048).
 */
export function exportGlb(parts, options = {}) {
  if (!Array.isArray(parts) || parts.length === 0) throw new TypeError('GLB export requires a nonempty parts array.');
  validateOptions(options);
  const validatedGeometries = new Set();
  const morphMetadata = new Map();
  for (const part of parts) {
    if (!validatedGeometries.has(part?.geometry)) {
      validateGeometry(part?.geometry);
      validatedGeometries.add(part.geometry);
    }
    validatePart(part);
    const metadata = morphMetadata.get(part.geometry);
    if (metadata) {
      validateMorphPose(part.morph, metadata);
    } else {
      morphMetadata.set(part.geometry, validateMorphGeometry(part.geometry, part.morph));
    }
    validateSkinnedPart(part);
    requireUvsForTextures(part);
  }
  const hierarchy = buildHierarchy(parts, options.nodes);
  const worldCache = new Map();
  parts.forEach((part, partIndex) => {
    if (part.skin) return;
    const host = part.matrix?.length === 16 ? hostOfPart(partIndex, hierarchy, worldCache) : null;
    validateMatrix(host ? relativeMatrix(part.matrix, host.world) : part.matrix);
  });
  const writer = createGlbWriter();
  const { document } = writer;
  const textureWriter = createTextureWriter(writer, options.maxTextureSize);
  const nodeIndexByName = new Map(hierarchy.map((node, index) => [node.name, index]));
  const geometries = new Map();
  const materials = new Map();
  const meshes = new Map();
  const skins = new Map();
  const identify = createIdentityTracker();

  function geometryFor(part) {
    const boxMapped = (part.material.boxMapScale ?? 0) > 0;
    const scale = columnLengths(part.matrix);
    const variant = boxMapped ? `box:${part.material.boxMapScale}:${part.material.boxMapAxis ?? 1}:${scale.join(',')}` : 'authored';
    if (!geometries.has(part.geometry)) geometries.set(part.geometry, new Map());
    const variants = geometries.get(part.geometry);
    if (!variants.has(variant)) {
      const source = boxMapped ? boxProjectedGeometry(part.geometry, scale, part.material.boxMapScale, part.material.boxMapAxis ?? 1) : part.geometry;
      variants.set(variant, writeGeometry(writer, source));
    }
    return variants.get(variant);
  }

  for (const node of hierarchy) document.nodes.push({ name: node.name, ...hierarchyNodeFields(node) });
  hierarchy.forEach((node, index) => {
    if (node.parent >= 0) (document.nodes[node.parent].children ??= []).push(index);
  });
  const sceneRoots = hierarchy.flatMap((node, index) => node.parent < 0 ? [index] : []);
  parts.forEach((part, partIndex) => {
    const geometry = geometryFor(part);
    const materialKey = materialKeyOf(part.material, identify);
    if (!materials.has(materialKey)) {
      materials.set(materialKey, document.materials.length);
      document.materials.push(writeMaterial(writer, textureWriter, part.material));
    }
    const material = materials.get(materialKey);
    const meshKey = `${geometry.indices}:${material}`;
    if (!meshes.has(meshKey)) {
      meshes.set(meshKey, document.meshes.length);
      document.meshes.push({ primitives: [{ ...geometry, material }] });
    }
    const host = part.skin ? null : hostOfPart(partIndex, hierarchy, worldCache);
    // The mesh node of an imported asset is one of its nodes: keep the mesh on it instead of nesting a same-named node.
    const mergeIntoHost = host && hierarchy[host.index].name === part.name && hierarchy[host.index].meshIds.length === 1;
    // Clips address nodes by name, and loaders rename duplicates, so a mesh node never shares a joint's name.
    const meshNodeName = nodeIndexByName.has(part.name) ? `${part.name} mesh` : part.name;
    const node = mergeIntoHost ? document.nodes[host.index] : { name: meshNodeName };
    node.mesh = meshes.get(meshKey);
    if (part.morph) node.weights = Array.from(part.morph.weights);
    if (part.skin) {
      // A skinned mesh takes its pose from its joints, so its own node stays at the origin.
      node.skin = writeSkin(writer, part.skin, nodeIndexByName, skins);
    } else if (!mergeIntoHost) {
      node.matrix = Array.from(host ? relativeMatrix(part.matrix, host.world) : part.matrix);
    }
    if (mergeIntoHost) return;
    document.nodes.push(node);
    const nodeIndex = document.nodes.length - 1;
    if (host) (document.nodes[host.index].children ??= []).push(nodeIndex);
    else sceneRoots.push(nodeIndex);
  });
  document.scenes[0].nodes = sceneRoots;
  if (options.clips?.length) {
    for (const [index, node] of document.nodes.entries()) {
      if (!nodeIndexByName.has(node.name)) nodeIndexByName.set(node.name, index);
    }
    writeAnimations(writer, options.clips, nodeIndexByName, nodeIndex => {
      const node = document.nodes[nodeIndex];
      if (!node.matrix) return;
      Object.assign(node, decomposeMatrix(node.matrix));
      delete node.matrix;
    });
  }
  return writer.finish();
}

export function downloadGlb(parts, options) {
  const url = URL.createObjectURL(new Blob([exportGlb(parts, options)], { type: 'model/gltf-binary' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = '67js-wall-e.glb';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
