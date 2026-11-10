import { mat4 } from 'gl-matrix';
import { createSlicer } from './cooperative.js';
import { COMPONENT_TYPES, attributeFloats, createAccessorReader } from './gltf-accessors.js';
import { createClips } from './gltf-animation.js';
import { layerTextureReferences } from './gltf-layers.js';
import { Matrix4, SceneNode } from './gltf-nodes.js';
import { createSkinPose, validateSkinGeometry } from './skinning.js';

const GEOMETRY_ATTRIBUTE_NAMES = {
  POSITION: 'position',
  NORMAL: 'normal',
  COLOR_0: 'color',
  TEXCOORD_0: 'uv',
  TEXCOORD_1: 'uv1',
  JOINTS_0: 'skinIndex',
  WEIGHTS_0: 'skinWeight',
};
const TEXTURE_SLOTS = [
  ['map', 'baseColorTexture', true],
  ['normalMap', 'normalTexture', false],
  ['metalnessMap', 'metallicRoughnessTexture', true],
  ['aoMap', 'occlusionTexture', false],
  ['emissiveMap', 'emissiveTexture', false],
];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
// "RIFF", four size bytes that vary, then "WEBP".
const WEBP_SIGNATURE = [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50];
const LINEAR_SRGB = 'srgb-linear';
const COMPONENT_CODES = new Map(Object.entries(COMPONENT_TYPES).map(([code, ArrayType]) => [ArrayType, Number(code)]));

/**
 * Record a limit the file goes over: what was measured, the option, its value and the option value that fits.
 * `perUnit` is for ceilings that are a multiple of the option, such as twelve indices per allowed vertex.
 */
export function overLimit(overruns, what, measured, option, limit, perUnit = 1) {
  if (measured > limit * perUnit) {
    const ceiling = perUnit > 1 ? ` x ${perUnit}` : '';
    overruns.push({ text: `${what} ${measured}, over ${option} ${limit}${ceiling}`, option, needed: Math.ceil(measured / perUnit) });
  }
  return overruns;
}

/** Throw one error for every recorded limit, so a single failed call names each option to raise and the value that fits. */
export function throwOverruns(overruns) {
  if (!overruns.length) return;
  const needed = new Map();
  for (const overrun of overruns) needed.set(overrun.option, Math.max(needed.get(overrun.option) ?? 0, overrun.needed));
  const fix = [...needed].map(([option, value]) => `${option}: ${value}`).join(', ');
  throw new RangeError(`glTF over its limits: ${overruns.map(overrun => overrun.text).join('; ')}. Fix: pass { ${fix} }.`);
}

/** Primitives the loader found unusable (bad accessors) before decoding; the decoder leaves them out and the file still loads. */
export const unusablePrimitives = new WeakSet();

/** POINTS, LINES, LINE_LOOP and LINE_STRIP (modes 0 to 3) and primitives marked unusable are not drawn, so the decoder leaves them out. */
export function isLinePrimitive(primitive) {
  return (primitive.mode >= 0 && primitive.mode <= 3) || unusablePrimitives.has(primitive);
}

export function textureSourceIndex(texture) {
  return texture.extensions?.KHR_texture_basisu?.source ?? texture.extensions?.EXT_texture_webp?.source ?? texture.source;
}

function sanitizeNodeName(name) {
  return name.replace(/\s/g, '_').replace(/[[\].:/]/g, '');
}

function mimeTypeOf(imageDefinition, bytes) {
  if (imageDefinition.mimeType) return imageDefinition.mimeType;
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return 'image/png';
  if (WEBP_SIGNATURE.every((value, index) => value === null || bytes[index] === value)) return 'image/webp';
  return 'image/jpeg';
}

async function decodeImage(bytes, mimeType, target) {
  const blob = new Blob([bytes], { type: mimeType });
  if (typeof createImageBitmap === 'function') {
    const options = { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' };
    if (target) Object.assign(options, { resizeWidth: target.width, resizeHeight: target.height, resizeQuality: 'high' });
    return createImageBitmap(blob, options);
  }
  if (target) throw new Error('Scaling textures to fit maxTexturePixels requires createImageBitmap.');
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function decodedAttribute(attribute, normalized) {
  return {
    array: attribute.array,
    itemSize: attribute.itemSize,
    count: attribute.count,
    normalized: normalized ?? attribute.normalized === true,
    componentType: COMPONENT_CODES.get(attribute.array.constructor),
  };
}

/** Scale each vertex's four weights to sum to one, as three.js does for skinned meshes. */
function normalizedWeights(weights) {
  const values = attributeFloats(weights);
  for (let offset = 0; offset < values.length; offset += 4) {
    const total = values[offset] + values[offset + 1] + values[offset + 2] + values[offset + 3];
    if (total === 0) {
      values[offset] = 1;
      continue;
    }
    for (let influence = 0; influence < 4; influence++) values[offset + influence] /= total;
  }
  return { array: values, itemSize: 4, count: weights.count, normalized: false, componentType: 5126 };
}

/**
 * Decode the selected glTF scene into plain scene nodes, geometry sources, materials, textures and animation clips.
 * The result has the shape the Renderer67 conversion in gltf.js reads. Nothing here imports three.js: Draco, meshopt
 * and KTX2 decoders arrive as `decoders` objects that the caller supplies.
 */
export async function decodeGltf({ document, glbBinary, resourceBytes, decoders, limits, imageTargets = new Map(), sharedTextures }) {
  const releasers = [];
  const usedNames = new Map();
  const nodeCache = new Map();
  const meshNames = new Map();
  const sources = new Map();
  const materials = new Map();
  const textures = new Map();
  const images = new Map();
  const skeletons = new Map();
  const instanceMatrices = new Map();

  function bufferBytes(index) {
    const buffer = document.buffers?.[index];
    if (!buffer) return null;
    if (buffer.uri !== undefined) return resourceBytes.get(buffer.uri) ?? null;
    return index === 0 ? glbBinary : null;
  }

  const checkpoint = createSlicer();
  const reader = createAccessorReader(document, bufferBytes, decoders.meshopt);
  await reader.prepare();

  function uniqueName(originalName) {
    const sanitized = sanitizeNodeName(originalName);
    if (!usedNames.has(sanitized)) {
      usedNames.set(sanitized, 0);
      return sanitized;
    }
    // A later node may really be called "Bone_1", so skip suffixes that are taken: names stay unique and clip
    // tracks, which address nodes by name, never collide.
    let count = usedNames.get(sanitized);
    let candidate;
    do {
      count++;
      candidate = `${sanitized}_${count}`;
    } while (usedNames.has(candidate));
    usedNames.set(sanitized, count);
    usedNames.set(candidate, 0);
    return candidate;
  }

  function imageBytes(index) {
    const definition = document.images[index];
    if (definition.uri !== undefined) return resourceBytes.get(definition.uri);
    return reader.viewBytes(definition.bufferView);
  }

  function loadKtx2Image(bytes) {
    const loader = decoders.ktx2;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/ktx2' }));
    return new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject)).finally(() => URL.revokeObjectURL(url));
  }

  async function loadImage(sourceIndex, isKtx2) {
    const key = `${sourceIndex}:${isKtx2}`;
    if (images.has(key)) return images.get(key);
    const bytes = imageBytes(sourceIndex);
    let loaded;
    if (isKtx2) {
      const texture = await loadKtx2Image(bytes);
      loaded = { image: texture.image, isCompressedTexture: texture.isCompressedTexture === true, format: texture.format, mipmaps: texture.mipmaps };
      releasers.push(() => texture.dispose?.());
    } else {
      const image = await decodeImage(bytes, mimeTypeOf(document.images[sourceIndex], bytes), imageTargets.get(sourceIndex));
      loaded = { image, isCompressedTexture: false, format: undefined, mipmaps: undefined };
      releasers.push(() => image.close?.());
    }
    images.set(key, loaded);
    return loaded;
  }

  // A WebP source with a PNG or JPEG fallback falls back when this browser cannot decode WebP.
  async function loadTextureImage(definition) {
    const isKtx2 = Boolean(definition.extensions?.KHR_texture_basisu);
    const sourceIndex = textureSourceIndex(definition);
    const fallbackIndex = definition.source;
    const hasWebpFallback = !isKtx2 && definition.extensions?.EXT_texture_webp && Number.isInteger(fallbackIndex) && fallbackIndex !== sourceIndex;
    if (!hasWebpFallback) return loadImage(sourceIndex, isKtx2);
    try {
      return await loadImage(sourceIndex, false);
    } catch {
      return loadImage(fallbackIndex, false);
    }
  }

  async function loadTexture(textureIndex) {
    if (textures.has(textureIndex)) return textures.get(textureIndex);
    const definition = document.textures[textureIndex];
    // A texture that several files of one world carry is stored in the first file only; later files hold a stand-in image and
    // the same key, and take the texture the first file decoded.
    const shareKey = definition.extras?.sharedTexture;
    const shared = shareKey && sharedTextures?.get(shareKey);
    if (shared) return shared;
    const sampler = document.samplers?.[definition.sampler] ?? {};
    const { image, isCompressedTexture, format, mipmaps } = await loadTextureImage(definition);
    const texture = {
      image,
      isCompressedTexture,
      format,
      mipmaps,
      wrapS: sampler.wrapS ?? 10497,
      wrapT: sampler.wrapT ?? 10497,
      minFilter: sampler.minFilter ?? 9987,
      magFilter: sampler.magFilter ?? 9729,
    };
    textures.set(textureIndex, texture);
    if (shareKey) sharedTextures?.set(shareKey, texture);
    return texture;
  }

  async function loadMaterial(materialIndex) {
    if (materials.has(materialIndex)) return materials.get(materialIndex);
    const definition = materialIndex === undefined ? {} : document.materials[materialIndex];
    const pbr = definition.pbrMetallicRoughness ?? {};
    const material = {
      materialIndex,
      color: (pbr.baseColorFactor ?? [1, 1, 1]).slice(0, 3),
      metalness: pbr.metallicFactor ?? 1,
      roughness: pbr.roughnessFactor ?? 1,
      emissive: [...(definition.emissiveFactor ?? [0, 0, 0])],
      emissiveIntensity: definition.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1,
      aoMapIntensity: definition.occlusionTexture?.strength ?? 1,
    };
    for (const [field, sourceField, inPbrBlock] of TEXTURE_SLOTS) {
      const reference = inPbrBlock ? pbr[sourceField] : definition[sourceField];
      if (!reference) continue;
      try {
        material[field] = await loadTexture(reference.index);
      } catch (error) {
        throw new Error(`${sourceField} failed to decode. Use a valid PNG, JPEG or WebP image. ${error.message}`);
      }
    }
    const layerTextures = {};
    for (const [name, reference] of layerTextureReferences(definition)) {
      try {
        layerTextures[name] = await loadTexture(reference.index);
      } catch (error) {
        throw new Error(`${name} failed to decode. Use a valid PNG, JPEG or WebP image. ${error.message}`);
      }
    }
    if (Object.keys(layerTextures).length > 0) material.layerTextures = layerTextures;
    materials.set(materialIndex, material);
    return material;
  }

  function decodeDracoGeometry(primitive, extension) {
    const loader = decoders.draco;
    loader.preload?.();
    const attributeIds = {};
    const attributeTypes = {};
    for (const [semantic, id] of Object.entries(extension.attributes)) {
      const name = GEOMETRY_ATTRIBUTE_NAMES[semantic];
      if (!name) continue;
      attributeIds[name] = id;
      const accessor = document.accessors[primitive.attributes[semantic]];
      if (accessor) attributeTypes[name] = COMPONENT_TYPES[accessor.componentType].name;
    }
    const compressed = reader.viewBytes(extension.bufferView).slice().buffer;
    return new Promise((resolve, reject) => loader.decodeDracoFile(compressed, resolve, attributeIds, attributeTypes, LINEAR_SRGB, reject));
  }

  async function loadPrimitiveSource(meshIndex, primitiveIndex) {
    const key = `${meshIndex}:${primitiveIndex}`;
    if (sources.has(key)) return sources.get(key);
    const primitive = document.meshes[meshIndex].primitives[primitiveIndex];
    const dracoExtension = primitive.extensions?.KHR_draco_mesh_compression;
    const dracoGeometry = dracoExtension ? await decodeDracoGeometry(primitive, dracoExtension) : null;
    const attributes = {};
    for (const [semantic, accessorIndex] of Object.entries(primitive.attributes)) {
      const name = GEOMETRY_ATTRIBUTE_NAMES[semantic];
      if (!name) continue;
      if (dracoGeometry && dracoExtension.attributes[semantic] !== undefined) {
        const decoded = dracoGeometry.getAttribute(name);
        if (!decoded) throw new Error(`Draco geometry is missing ${semantic}.`);
        attributes[name] = decodedAttribute(decoded, document.accessors[accessorIndex]?.normalized === true);
      } else {
        attributes[name] = await reader.readAccessorInSlices(accessorIndex, checkpoint);
      }
    }
    let index = null;
    if (primitive.indices !== undefined) index = dracoGeometry ? decodedAttribute(dracoGeometry.getIndex()) : await reader.readAccessorInSlices(primitive.indices, checkpoint);
    const targets = primitive.targets ?? [];
    const source = {
      uuid: key,
      attributes,
      index,
      morphPositions: targets.map(target => target.POSITION === undefined ? undefined : reader.readAccessor(target.POSITION)),
      morphNormals: targets.map(target => target.NORMAL === undefined ? undefined : reader.readAccessor(target.NORMAL)),
    };
    sources.set(key, source);
    return source;
  }

  /** Raw joints and weights are checked before normalizing, so zero-weight vertices are reported. */
  function prepareSkinnedSource(source, jointCount) {
    if (source.skinPrepared) return;
    const { skinIndex, skinWeight, position } = source.attributes;
    validateSkinGeometry({ positions: { length: position.count * 3 }, skinIndices: attributeFloats(skinIndex), skinWeights: attributeFloats(skinWeight) }, createSkinPose(jointCount));
    source.attributes.skinWeight = normalizedWeights(skinWeight);
    source.skinPrepared = true;
  }

  function instanceMatricesFor(nodeIndex, extension) {
    if (instanceMatrices.has(nodeIndex)) return instanceMatrices.get(nodeIndex);
    const { TRANSLATION, ROTATION, SCALE } = extension.attributes;
    const translations = TRANSLATION === undefined ? null : attributeFloats(reader.readAccessor(TRANSLATION));
    const rotations = ROTATION === undefined ? null : attributeFloats(reader.readAccessor(ROTATION));
    const scales = SCALE === undefined ? null : attributeFloats(reader.readAccessor(SCALE));
    const count = [TRANSLATION, ROTATION, SCALE].filter(index => index !== undefined).map(index => document.accessors[index].count)[0];
    throwOverruns(overLimit([], `node ${nodeIndex} instances`, count, 'maxInstances', limits.maxInstances));
    const matrices = new Float64Array(count * 16);
    for (let instance = 0; instance < count; instance++) {
      mat4.fromRotationTranslationScale(
        matrices.subarray(instance * 16, instance * 16 + 16),
        rotations ? rotations.subarray(instance * 4, instance * 4 + 4) : [0, 0, 0, 1],
        translations ? translations.subarray(instance * 3, instance * 3 + 3) : [0, 0, 0],
        scales ? scales.subarray(instance * 3, instance * 3 + 3) : [1, 1, 1],
      );
    }
    const result = { count, matrices };
    instanceMatrices.set(nodeIndex, result);
    return result;
  }

  function reserveMeshNames(meshIndex) {
    if (!meshNames.has(meshIndex)) {
      const mesh = document.meshes[meshIndex];
      const baseName = mesh.name || `mesh_${meshIndex}`;
      meshNames.set(meshIndex, mesh.primitives.map(() => uniqueName(baseName)));
    }
    return meshNames.get(meshIndex);
  }

  async function createPrimitiveObject(definition, nodeIndex, meshIndex, primitiveIndex) {
    const mesh = document.meshes[meshIndex];
    const primitive = mesh.primitives[primitiveIndex];
    const object = new SceneNode();
    object.isMesh = true;
    object.geometry = await loadPrimitiveSource(meshIndex, primitiveIndex);
    object.material = await loadMaterial(primitive.material);
    object.name = reserveMeshNames(meshIndex)[primitiveIndex];
    object.association = { meshes: meshIndex, primitives: primitiveIndex };
    if (definition.skin !== undefined) {
      object.isSkinnedMesh = true;
      prepareSkinnedSource(object.geometry, document.skins[definition.skin].joints.length);
    }
    const targetCount = primitive.targets?.length ?? 0;
    if (targetCount) {
      object.morphTargetInfluences = Array.from({ length: targetCount }, (unused, target) => definition.weights?.[target] ?? mesh.weights?.[target] ?? 0);
    }
    const instancing = definition.extensions?.EXT_mesh_gpu_instancing;
    if (instancing) {
      const { count, matrices } = instanceMatricesFor(nodeIndex, instancing);
      object.isInstancedMesh = true;
      object.count = count;
      object.instanceMatrices = matrices;
    }
    return object;
  }

  async function loadSkeleton(skinIndex) {
    if (skeletons.has(skinIndex)) return skeletons.get(skinIndex);
    const skin = document.skins[skinIndex];
    const bones = [];
    for (const joint of skin.joints) bones.push(await buildNode(joint));
    const inverseValues = skin.inverseBindMatrices === undefined ? null : attributeFloats(reader.readAccessor(skin.inverseBindMatrices));
    const boneInverses = bones.map((bone, index) => inverseValues ? new Matrix4().fromArray(inverseValues, index * 16) : new Matrix4());
    const skeleton = { bones, boneInverses, dispose() {} };
    skeletons.set(skinIndex, skeleton);
    return skeleton;
  }

  async function buildNode(nodeIndex) {
    if (nodeCache.has(nodeIndex)) return nodeCache.get(nodeIndex);
    const definition = document.nodes[nodeIndex];
    const nodeName = definition.name ? uniqueName(definition.name) : '';
    const objects = [];
    if (definition.mesh !== undefined) {
      for (let primitiveIndex = 0; primitiveIndex < document.meshes[definition.mesh].primitives.length; primitiveIndex++) {
        if (isLinePrimitive(document.meshes[definition.mesh].primitives[primitiveIndex])) continue;
        objects.push(await createPrimitiveObject(definition, nodeIndex, definition.mesh, primitiveIndex));
      }
    }
    let node;
    if (objects.length === 1) {
      node = objects[0];
    } else {
      node = new SceneNode();
      if (objects.length) node.association = { meshes: definition.mesh };
      for (const object of objects) node.add(object);
    }
    if (definition.name) node.name = nodeName;
    node.association = { ...node.association, nodes: nodeIndex };
    if (definition.matrix !== undefined) new Matrix4().fromArray(definition.matrix).decompose(node.position, node.quaternion, node.scale);
    if (definition.translation !== undefined) node.position.fromArray(definition.translation);
    if (definition.rotation !== undefined) node.quaternion.fromArray(definition.rotation);
    if (definition.scale !== undefined) node.scale.fromArray(definition.scale);
    nodeCache.set(nodeIndex, node);
    if (definition.skin !== undefined) {
      const skeleton = await loadSkeleton(definition.skin);
      node.traverse(candidate => {
        if (!candidate.isSkinnedMesh) return;
        candidate.skeleton = skeleton;
        candidate.bindMatrix = new Matrix4();
      });
    }
    for (const childIndex of definition.children ?? []) node.add(await buildNode(childIndex));
    return node;
  }

  const release = () => releasers.forEach(releaseOne => releaseOne());
  try {
    const sceneDefinition = document.scenes?.[document.scene ?? 0];
    if (!sceneDefinition) throw new Error('glTF has no default scene.');
    const scene = new SceneNode();
    for (const rootIndex of sceneDefinition.nodes ?? []) scene.add(await buildNode(rootIndex));
    for (const animation of document.animations ?? []) {
      for (const channel of animation.channels ?? []) {
        if (channel.target.node !== undefined) await buildNode(channel.target.node);
      }
    }
    const animations = createClips(document, index => nodeCache.get(index), reader.readAccessor);
    scene.updateMatrixWorld();
    return { scene, animations, release };
  } catch (error) {
    release();
    throw error;
  }
}
