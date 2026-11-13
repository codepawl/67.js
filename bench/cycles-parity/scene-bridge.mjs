import { readFile } from 'node:fs/promises';
import { register } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

register('./root-loader.mjs', import.meta.url);

const REPOSITORY_ROOT_PATH = fileURLToPath(new URL('../../', import.meta.url));
const TYPED_ARRAY_CONSTRUCTORS = {
  Float32Array,
  Uint32Array,
  Uint16Array,
  Uint8Array,
  Uint8ClampedArray,
};

function encodeTypedArray(typedArray) {
  const byteView = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  return {
    type: typedArray.constructor.name,
    base64: Buffer.from(byteView).toString('base64'),
  };
}

function decodeTypedArray(encodedEntry) {
  if (encodedEntry === null || encodedEntry === undefined) {
    return undefined;
  }
  const Constructor = TYPED_ARRAY_CONSTRUCTORS[encodedEntry.type];
  if (!Constructor) {
    throw new TypeError(`Unsupported typed array entry type "${encodedEntry.type}".`);
  }
  const rawBuffer = Buffer.from(encodedEntry.base64, 'base64');
  const alignedBytes = new Uint8Array(rawBuffer.byteLength);
  alignedBytes.set(rawBuffer);
  return new Constructor(alignedBytes.buffer, 0, alignedBytes.byteLength / Constructor.BYTES_PER_ELEMENT);
}

function isImageDataLike(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const hasDimensions = Number.isInteger(value.width) && Number.isInteger(value.height);
  const hasByteArray = value.data instanceof Uint8ClampedArray || value.data instanceof Uint8Array;
  return hasDimensions && hasByteArray && Object.keys(value).length <= 4;
}

function serializePlainValue(value, imageTable) {
  if (ArrayBuffer.isView(value)) {
    return encodeTypedArray(value);
  }
  if (isImageDataLike(value)) {
    if (!imageTable) {
      return {
        width: value.width,
        height: value.height,
        data: encodeTypedArray(value.data),
      };
    }
    if (!imageTable.identifiers.has(value)) {
      const nextIdentifier = imageTable.entries.length;
      imageTable.identifiers.set(value, nextIdentifier);
      imageTable.entries.push({
        width: value.width,
        height: value.height,
        data: encodeTypedArray(value.data),
      });
    }
    return { imageId: imageTable.identifiers.get(value) };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => serializePlainValue(entry, imageTable));
  }
  if (value && typeof value === 'object') {
    const serializedObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== 'function') {
        serializedObject[key] = serializePlainValue(entry, imageTable);
      }
    }
    return serializedObject;
  }
  return value;
}

function createMaterialTable() {
  const imageTable = {
    identifiers: new Map(),
    entries: [],
  };
  const materials = [];
  const indexByJson = new Map();
  function indexOf(material) {
    const serializedMaterial = serializePlainValue(material, imageTable);
    const key = JSON.stringify(serializedMaterial);
    if (!indexByJson.has(key)) {
      indexByJson.set(key, materials.length);
      materials.push(serializedMaterial);
    }
    return indexByJson.get(key);
  }
  return {
    indexOf,
    materials,
    images: imageTable.entries,
  };
}

async function resolvePartGeometry(part, boxProjectedCache) {
  if (part.skin) {
    const { skinnedGeometry } = await import('../../src/path-tracer-scene.js');
    return skinnedGeometry(part);
  }
  const boxMapScale = part.material.boxMapScale;
  if (!(boxMapScale > 0) || part.geometry.uvs) {
    return part.geometry;
  }
  const { boxProjectedGeometry } = await import('../../src/export-box-uv.js');
  const { matrix } = part;
  const partScale = [0, 1, 2].map((column) => Math.hypot(matrix[column * 4], matrix[column * 4 + 1], matrix[column * 4 + 2]));
  const cacheKey = `${partScale.join(',')}|${boxMapScale}|${part.material.boxMapAxis ?? 1}`;
  if (!boxProjectedCache.has(part.geometry)) {
    boxProjectedCache.set(part.geometry, new Map());
  }
  const byScale = boxProjectedCache.get(part.geometry);
  if (!byScale.has(cacheKey)) {
    const projected = boxProjectedGeometry(part.geometry, partScale, boxMapScale, part.material.boxMapAxis ?? 1);
    byScale.set(cacheKey, projected);
  }
  return byScale.get(cacheKey);
}

function ensureNodeImageData() {
  if (typeof globalThis.ImageData === 'function') {
    return;
  }
  globalThis.ImageData = class ImageData {
    constructor(firstArgument, secondArgument, thirdArgument) {
      if (typeof firstArgument === 'number') {
        this.width = firstArgument;
        this.height = secondArgument;
        this.data = new Uint8ClampedArray(firstArgument * secondArgument * 4);
        return;
      }
      if (firstArgument instanceof Uint8ClampedArray) {
        this.data = firstArgument;
      } else {
        this.data = new Uint8ClampedArray(firstArgument.buffer, firstArgument.byteOffset, firstArgument.byteLength);
      }
      this.width = secondArgument;
      this.height = thirdArgument ?? (this.data.length / (4 * secondArgument));
    }
  };
}

async function readRepositoryAsset(rootRelativeUrl) {
  const cleanRelativePath = rootRelativeUrl.split(/[?#]/, 1)[0].slice(1);
  const publicCandidatePath = join(REPOSITORY_ROOT_PATH, 'public', cleanRelativePath);
  try {
    return await readFile(publicCandidatePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
    return readFile(join(REPOSITORY_ROOT_PATH, cleanRelativePath));
  }
}

async function runWithRepositoryAssetFetch(callback) {
  ensureNodeImageData();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      const assetBytes = await readRepositoryAsset(input);
      return new Response(assetBytes, { status: 200 });
    }
    return previousFetch(input, init);
  };
  try {
    return await callback();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

export async function loadReferenceScene(sceneId) {
  const [{ REFERENCE_SCENES }, { applyLightLinks }] = await Promise.all([
    import('../../bench/reference/scenes.js'),
    import('../../src/light-linking.js'),
  ]);
  const sceneFactory = REFERENCE_SCENES[sceneId];
  if (!sceneFactory) {
    const availableIds = Object.keys(REFERENCE_SCENES).join(', ');
    throw new RangeError(`Unknown reference scene "${sceneId}". Pass one of: ${availableIds}.`);
  }
  const rawScene = await runWithRepositoryAssetFetch(() => sceneFactory());
  const linkedParts = applyLightLinks(rawScene.parts, rawScene.environment);
  return {
    rawScene,
    traceSource: {
      parts: linkedParts,
      environment: rawScene.environment,
      camera: rawScene.camera,
    },
  };
}

export async function serializeSceneDescription(sceneId, rawScene) {
  const { map: _ignoredEnvironmentMap, ...serializableEnvironment } = rawScene.environment;
  const geometryIndices = new Map();
  const boxProjectedCache = new Map();
  const materialTable = createMaterialTable();
  const serializedParts = [];
  for (const part of rawScene.parts) {
    const geometry = await resolvePartGeometry(part, boxProjectedCache);
    if (!geometryIndices.has(geometry)) {
      geometryIndices.set(geometry, geometryIndices.size);
    }
    serializedParts.push({
      name: part.name,
      geometry: geometryIndices.get(geometry),
      matrix: [...part.matrix],
      material: materialTable.indexOf(part.material),
    });
  }
  const serializedGeometries = [...geometryIndices.keys()].map((geometry) => serializePlainValue({
    positions: geometry.positions,
    normals: geometry.normals,
    uvs: geometry.uvs,
    colors: geometry.colors,
    indices: geometry.indices,
  }, null));
  return {
    id: sceneId,
    camera: rawScene.camera,
    environment: serializableEnvironment,
    world: rawScene.blenderWorld,
    blenderCloth: rawScene.blenderCloth,
    brightRegion: rawScene.brightRegion,
    materials: materialTable.materials,
    images: materialTable.images,
    parts: serializedParts,
    geometries: serializedGeometries,
  };
}

/**
 * The path of `fileName` inside `assetDirectory`, for the files a scene description names with `assetFile` (the Blender add-on writes
 * texture images and the world image next to scene.json). Only a bare file name is accepted: a path, an absolute path or a parent
 * reference from the scene file is refused, so a scene file cannot make the reader open anything outside its own folder.
 */
export function resolveAssetFile(assetDirectory, fileName) {
  if (typeof fileName !== 'string' || fileName === '' || fileName === '.' || fileName === '..' || /[/\x5c\x00]/.test(fileName)) {
    throw new RangeError(`The scene names the asset file ${JSON.stringify(fileName)}, which is not a bare file name. Name a file in the scene folder without any folder part, such as "texture-0.rgba".`);
  }
  if (typeof assetDirectory !== 'string' || assetDirectory === '') {
    throw new RangeError(`The scene names the asset file "${fileName}" but no asset directory was given. Pass the folder that holds scene.json as the assetDirectory option.`);
  }
  const directoryPath = resolve(assetDirectory);
  const filePath = resolve(directoryPath, fileName);
  if (dirname(filePath) !== directoryPath) {
    throw new RangeError(`The asset file "${fileName}" resolves outside the scene folder. Name a file in the scene folder without any folder part.`);
  }
  return filePath;
}

async function readImageFromAssetFile(imageEntry, assetDirectory) {
  const bytes = await readFile(resolveAssetFile(assetDirectory, imageEntry.assetFile));
  const expectedByteCount = imageEntry.width * imageEntry.height * 4;
  if (!Number.isInteger(expectedByteCount) || bytes.byteLength !== expectedByteCount) {
    throw new RangeError(`The image file "${imageEntry.assetFile}" holds ${bytes.byteLength} bytes, but ${imageEntry.width} x ${imageEntry.height} RGBA needs ${expectedByteCount}.`);
  }
  return { width: imageEntry.width, height: imageEntry.height, data: new Uint8ClampedArray(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) };
}

function restorePlainValue(value, decodedImages) {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (typeof value.type === 'string' && typeof value.base64 === 'string' && Object.keys(value).length === 2) {
    return decodeTypedArray(value);
  }
  if (Number.isInteger(value.imageId) && Object.keys(value).length === 1) {
    return decodedImages[value.imageId];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => restorePlainValue(entry, decodedImages));
  }
  const restored = {};
  for (const [key, entry] of Object.entries(value)) {
    restored[key] = restorePlainValue(entry, decodedImages);
  }
  return restored;
}

async function rebuildEnvironmentMap(worldDescription, repositoryRootPath = REPOSITORY_ROOT_PATH, assetDirectory = undefined) {
  const { createEnvironmentMap, parseRadianceHdr } = await import('../../src/hdri.js');
  if (worldDescription.type === 'constant') {
    // `color` carries a tinted constant world; the grey `value` alone is what the parity bridges write.
    const [red, green, blue] = worldDescription.color ?? [worldDescription.value, worldDescription.value, worldDescription.value];
    const constantData = new Float32Array(8 * 4 * 3);
    for (let pixelOffset = 0; pixelOffset < constantData.length; pixelOffset += 3) {
      constantData.set([red, green, blue], pixelOffset);
    }
    return createEnvironmentMap({
      width: 8,
      height: 4,
      data: constantData,
      showBackground: true,
    });
  }
  if (worldDescription.type === 'hdri') {
    const hdriPath = worldDescription.assetFile !== undefined
      ? resolveAssetFile(assetDirectory, worldDescription.assetFile)
      : resolve(repositoryRootPath, worldDescription.file);
    const hdriBytes = await readFile(hdriPath);
    const parsedHdri = parseRadianceHdr(hdriBytes.buffer.slice(hdriBytes.byteOffset, hdriBytes.byteOffset + hdriBytes.byteLength));
    const cappedData = parsedHdri.data.map((radiance) => Math.min(radiance, worldDescription.radianceLimit));
    return createEnvironmentMap({
      ...parsedHdri,
      data: cappedData,
      intensity: worldDescription.intensity,
      showBackground: true,
    });
  }
  throw new RangeError(`Unsupported world description type "${worldDescription.type}".`);
}

export async function reconstructTraceSceneSource(description, repositoryRootPath = REPOSITORY_ROOT_PATH, { assetDirectory } = {}) {
  const { applyLightLinks } = await import('../../src/light-linking.js');
  const decodedImages = await Promise.all((description.images ?? []).map(async (imageEntry) => {
    if (imageEntry.assetFile !== undefined) {
      return readImageFromAssetFile(imageEntry, assetDirectory);
    }
    return { width: imageEntry.width, height: imageEntry.height, data: decodeTypedArray(imageEntry.data) };
  }));
  const decodedGeometries = description.geometries.map((geometryEntry) => {
    const restoredGeometry = {
      positions: decodeTypedArray(geometryEntry.positions),
      normals: decodeTypedArray(geometryEntry.normals),
      indices: decodeTypedArray(geometryEntry.indices),
    };
    const uvs = decodeTypedArray(geometryEntry.uvs);
    if (uvs) {
      restoredGeometry.uvs = uvs;
    }
    const colors = decodeTypedArray(geometryEntry.colors);
    if (colors) {
      restoredGeometry.colors = colors;
    }
    return restoredGeometry;
  });
  const decodedMaterials = description.materials.map((materialEntry) => restorePlainValue(materialEntry, decodedImages));
  const rawParts = description.parts.map((partEntry) => ({
    name: partEntry.name,
    geometry: decodedGeometries[partEntry.geometry],
    matrix: new Float32Array(partEntry.matrix),
    material: decodedMaterials[partEntry.material],
    ...(partEntry.rayVisibility ? { rayVisibility: partEntry.rayVisibility } : {}),
  }));
  const environmentMap = await rebuildEnvironmentMap(description.world, repositoryRootPath, assetDirectory);
  const fullEnvironment = {
    ...description.environment,
    map: environmentMap,
  };
  return {
    parts: applyLightLinks(rawParts, fullEnvironment),
    environment: fullEnvironment,
    camera: description.camera,
  };
}
