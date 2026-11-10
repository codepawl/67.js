// Prepares a raw exported GLB (unindexed triangle soup, PNG textures) for the home hero: welds duplicate vertices, reorders for the
// GPU cache, compresses every triangle mesh with meshopt (positions and UVs keep float32 with fewer mantissa bits through the
// EXPONENTIAL filter, normals use the OCTAHEDRAL filter), and re-encodes PNG textures as WebP at a capped size.
//
//   node scripts/prepare-hero-glb.mjs <input.glb> <output.glb> [--max-texture 1024] [--webp-quality 80] [--position-bits 16]
//        [--simplify-above 40000 --simplify-ratio 0.5 --simplify-error 0.01]
//
// A primitive that is not a plain triangle list with POSITION, NORMAL and TEXCOORD_0 only is copied byte for byte.
// Meshes shared by several primitives are encoded once. Nothing is read from the network and no input script is run.
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BINARY_CHUNK = 0x004e4942;
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function parseArguments(argv) {
  const options = { maxTexture: 1024, webpQuality: 80, positionBits: 16, simplifyAbove: 0, simplifyRatio: 0.5, simplifyError: 0.01 };
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!name.startsWith('--')) { positional.push(name); continue; }
    const value = Number(argv[++index]);
    const key = name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!(key in options) || !Number.isFinite(value)) throw new Error(`Unknown or invalid option ${name}.`);
    options[key] = value;
  }
  if (positional.length !== 2) throw new Error('Pass <input.glb> and <output.glb>.');
  return { input: positional[0], output: positional[1], options };
}

function readGlb(buffer) {
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) throw new Error('Not a GLB file.');
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
  const binaryStart = 20 + jsonLength;
  if (buffer.readUInt32LE(binaryStart + 4) !== BINARY_CHUNK) throw new Error('The GLB has no binary chunk.');
  return { json, binary: buffer.subarray(binaryStart + 8, binaryStart + 8 + buffer.readUInt32LE(binaryStart)) };
}

function writeGlb(json, binary) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadded = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const binaryPadded = Buffer.concat([binary, Buffer.alloc((4 - (binary.length % 4)) % 4)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binaryPadded.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonHeader.writeUInt32LE(JSON_CHUNK, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binaryPadded.length, 0);
  binaryHeader.writeUInt32LE(BINARY_CHUNK, 4);
  return Buffer.concat([header, jsonHeader, jsonPadded, binaryHeader, binaryPadded]);
}

function createWriter() {
  const chunks = [];
  let length = 0;
  return {
    add(bytes) {
      const padding = (4 - (length % 4)) % 4;
      if (padding) { chunks.push(Buffer.alloc(padding)); length += padding; }
      const offset = length;
      chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      length += bytes.byteLength;
      return offset;
    },
    finish: () => Buffer.concat(chunks),
    get length() { return length; },
  };
}

// Reads an accessor into a tightly packed typed array of floats (integers are kept as numbers; normalized ones are not rescaled).
function readFloats(document, binary, accessorIndex) {
  const accessor = document.accessors[accessorIndex];
  if (accessor.componentType !== 5126 || accessor.sparse || accessor.normalized) return null;
  const view = document.bufferViews[accessor.bufferView];
  const components = TYPE_COMPONENTS[accessor.type];
  const stride = view.byteStride ?? components * 4;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const values = new Float32Array(accessor.count * components);
  for (let item = 0; item < accessor.count; item++) {
    const base = start + item * stride;
    for (let component = 0; component < components; component++) values[item * components + component] = binary.readFloatLE(base + component * 4);
  }
  return values;
}

function readIndices(document, binary, accessorIndex) {
  const accessor = document.accessors[accessorIndex];
  const view = document.bufferViews[accessor.bufferView];
  const bytes = COMPONENT_BYTES[accessor.componentType];
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const indices = new Uint32Array(accessor.count);
  for (let item = 0; item < accessor.count; item++) {
    const at = start + item * (view.byteStride ?? bytes);
    indices[item] = bytes === 4 ? binary.readUInt32LE(at) : bytes === 2 ? binary.readUInt16LE(at) : binary.readUInt8(at);
  }
  return indices;
}

function isEncodablePrimitive(document, primitive) {
  const names = Object.keys(primitive.attributes);
  const supported = names.every(name => ['POSITION', 'NORMAL', 'TEXCOORD_0'].includes(name));
  return supported && names.includes('POSITION') && (primitive.mode ?? 4) === 4 && !primitive.targets && !primitive.extensions;
}

// Merges identical vertices, then reorders for the vertex cache and vertex fetch.
function buildIndexedMesh(positions, normals, uvs, sourceIndices) {
  const vertexCount = positions.length / 3;
  const indices = sourceIndices ?? Uint32Array.from({ length: vertexCount }, (_, index) => index);
  const keyBytes = new Uint8Array(32);
  const keyFloats = new Float32Array(keyBytes.buffer);
  const firstSeen = new Map();
  const remap = new Uint32Array(vertexCount);
  let unique = 0;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    keyFloats.set(positions.subarray(vertex * 3, vertex * 3 + 3), 0);
    if (normals) keyFloats.set(normals.subarray(vertex * 3, vertex * 3 + 3), 3);
    if (uvs) keyFloats.set(uvs.subarray(vertex * 2, vertex * 2 + 2), 6);
    const key = String.fromCharCode(...new Uint16Array(keyBytes.buffer));
    let target = firstSeen.get(key);
    if (target === undefined) { target = unique++; firstSeen.set(key, target); }
    remap[vertex] = target;
  }
  const weldedIndices = indices.map(index => remap[index]);
  const welded = { positions: new Float32Array(unique * 3), normals: normals && new Float32Array(unique * 3), uvs: uvs && new Float32Array(unique * 2) };
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const target = remap[vertex];
    welded.positions.set(positions.subarray(vertex * 3, vertex * 3 + 3), target * 3);
    welded.normals?.set(normals.subarray(vertex * 3, vertex * 3 + 3), target * 3);
    welded.uvs?.set(uvs.subarray(vertex * 2, vertex * 2 + 2), target * 2);
  }
  return { ...welded, indices: weldedIndices };
}

function simplifyMesh(mesh, options) {
  const triangleCount = mesh.indices.length / 3;
  if (!options.simplifyAbove || triangleCount < options.simplifyAbove) return mesh;
  const targetCount = Math.max(900, Math.floor((mesh.indices.length * options.simplifyRatio) / 3) * 3);
  const [simplified] = MeshoptSimplifier.simplify(mesh.indices, mesh.positions, 3, targetCount, options.simplifyError, ['LockBorder']);
  return { ...mesh, indices: simplified };
}

function reorderMesh(mesh) {
  const [vertexRemap, uniqueCount] = MeshoptEncoder.reorderMesh(mesh.indices, true, false);
  const reorder = (values, size) => {
    if (!values) return values;
    const result = new values.constructor(uniqueCount * size);
    for (let vertex = 0; vertex < vertexRemap.length; vertex++) {
      const target = vertexRemap[vertex];
      if (target === 0xffffffff) continue;
      result.set(values.subarray(vertex * size, vertex * size + size), target * size);
    }
    return result;
  };
  return { positions: reorder(mesh.positions, 3), normals: reorder(mesh.normals, 3), uvs: reorder(mesh.uvs, 2), indices: mesh.indices, count: uniqueCount };
}

function boundsOf(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index++) {
    min[index % 3] = Math.min(min[index % 3], positions[index]);
    max[index % 3] = Math.max(max[index % 3], positions[index]);
  }
  return { min, max };
}

async function main() {
  const { input, output, options } = parseArguments(process.argv.slice(2));
  await Promise.all([MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  const { json: source, binary } = readGlb(readFileSync(input));
  const document = structuredClone(source);
  const writer = createWriter();
  const newViews = [];
  const newAccessors = [];

  function addView(bytes, extra = {}) {
    newViews.push({ buffer: 0, byteOffset: writer.add(bytes), byteLength: bytes.byteLength, ...extra });
    return newViews.length - 1;
  }

  // Compressed views keep the decoded length in the view and the packed bytes in the extension, as the existing showcase files do.
  function addCompressedView(decoded, count, byteStride, mode, filter, target) {
    const packed = MeshoptEncoder.encodeGltfBuffer(decoded, count, byteStride, mode);
    const offset = writer.add(packed);
    const extension = { buffer: 0, byteOffset: offset, byteLength: packed.byteLength, mode, byteStride, count };
    if (filter) extension.filter = filter;
    newViews.push({ buffer: 1, byteOffset: 0, byteLength: decoded.byteLength, ...(target ? { target } : {}), ...(mode === 'ATTRIBUTES' ? { byteStride } : {}), extensions: { EXT_meshopt_compression: extension } });
    return newViews.length - 1;
  }

  const processedGeometry = new Map();
  const copiedAccessors = new Map();
  const stats = { primitives: 0, copied: 0, verticesBefore: 0, verticesAfter: 0, trianglesAfter: 0 };

  function copyAccessor(index) {
    if (copiedAccessors.has(index)) return copiedAccessors.get(index);
    const accessor = source.accessors[index];
    const created = { ...accessor };
    if (accessor.bufferView !== undefined && !accessor.sparse) {
      const view = source.bufferViews[accessor.bufferView];
      const elementBytes = COMPONENT_BYTES[accessor.componentType] * TYPE_COMPONENTS[accessor.type];
      const stride = view.byteStride ?? elementBytes;
      const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      const packed = Buffer.alloc(accessor.count * elementBytes);
      for (let item = 0; item < accessor.count; item++) binary.copy(packed, item * elementBytes, start + item * stride, start + item * stride + elementBytes);
      created.bufferView = addView(packed, view.target ? { target: view.target } : {});
      created.byteOffset = 0;
    }
    newAccessors.push(created);
    copiedAccessors.set(index, newAccessors.length - 1);
    return newAccessors.length - 1;
  }

  function encodePrimitive(primitive) {
    const attributes = primitive.attributes;
    const cacheKey = `${attributes.POSITION}/${attributes.NORMAL}/${attributes.TEXCOORD_0}/${primitive.indices}`;
    if (processedGeometry.has(cacheKey)) return processedGeometry.get(cacheKey);
    const positions = readFloats(document, binary, attributes.POSITION);
    const normals = attributes.NORMAL === undefined ? undefined : readFloats(document, binary, attributes.NORMAL);
    const uvs = attributes.TEXCOORD_0 === undefined ? undefined : readFloats(document, binary, attributes.TEXCOORD_0);
    if (!positions || normals === null || uvs === null) return null;
    const sourceIndices = primitive.indices === undefined ? undefined : readIndices(document, binary, primitive.indices);
    stats.verticesBefore += sourceIndices ? sourceIndices.length : positions.length / 3;
    const mesh = reorderMesh(simplifyMesh(buildIndexedMesh(positions, normals, uvs, sourceIndices), options));
    stats.verticesAfter += mesh.count;
    stats.trianglesAfter += mesh.indices.length / 3;

    const indexBytes = mesh.count > 65535 ? 4 : 2;
    const indexArray = indexBytes === 4 ? mesh.indices : Uint16Array.from(mesh.indices);
    const indexView = addCompressedView(new Uint8Array(indexArray.buffer, indexArray.byteOffset, indexArray.byteLength), mesh.indices.length, indexBytes, 'TRIANGLES', null, 34963);
    const result = { attributes: {}, indices: null };
    newAccessors.push({ bufferView: indexView, byteOffset: 0, componentType: indexBytes === 4 ? 5125 : 5123, count: mesh.indices.length, type: 'SCALAR' });
    result.indices = newAccessors.length - 1;

    const exponent = MeshoptEncoder.encodeFilterExp(mesh.positions, mesh.count, 12, options.positionBits);
    const bounds = boundsOf(mesh.positions);
    const positionView = addCompressedView(exponent, mesh.count, 12, 'ATTRIBUTES', 'EXPONENTIAL', 34962);
    newAccessors.push({ bufferView: positionView, byteOffset: 0, componentType: 5126, count: mesh.count, type: 'VEC3', min: bounds.min, max: bounds.max });
    result.attributes.POSITION = newAccessors.length - 1;

    if (mesh.normals) {
      const padded = new Float32Array(mesh.count * 4);
      for (let vertex = 0; vertex < mesh.count; vertex++) {
        padded.set(mesh.normals.subarray(vertex * 3, vertex * 3 + 3), vertex * 4);
        padded[vertex * 4 + 3] = 1;
      }
      const octahedral = MeshoptEncoder.encodeFilterOct(padded, mesh.count, 8, 10);
      const normalView = addCompressedView(octahedral, mesh.count, 8, 'ATTRIBUTES', 'OCTAHEDRAL', 34962);
      newAccessors.push({ bufferView: normalView, byteOffset: 0, componentType: 5122, normalized: true, count: mesh.count, type: 'VEC3' });
      result.attributes.NORMAL = newAccessors.length - 1;
    }
    if (mesh.uvs) {
      const padded = new Float32Array(mesh.count * 2);
      padded.set(mesh.uvs);
      const textureView = addCompressedView(MeshoptEncoder.encodeFilterExp(padded, mesh.count, 8, 14), mesh.count, 8, 'ATTRIBUTES', 'EXPONENTIAL', 34962);
      newAccessors.push({ bufferView: textureView, byteOffset: 0, componentType: 5126, count: mesh.count, type: 'VEC2' });
      result.attributes.TEXCOORD_0 = newAccessors.length - 1;
    }
    processedGeometry.set(cacheKey, result);
    return result;
  }

  for (const mesh of document.meshes) {
    for (const primitive of mesh.primitives) {
      stats.primitives++;
      const encoded = isEncodablePrimitive(document, primitive) ? encodePrimitive(primitive) : null;
      if (encoded) {
        primitive.attributes = encoded.attributes;
        primitive.indices = encoded.indices;
        continue;
      }
      stats.copied++;
      for (const name of Object.keys(primitive.attributes)) primitive.attributes[name] = copyAccessor(primitive.attributes[name]);
      if (primitive.indices !== undefined) primitive.indices = copyAccessor(primitive.indices);
      for (const target of primitive.targets ?? []) for (const name of Object.keys(target)) target[name] = copyAccessor(target[name]);
    }
  }

  for (const node of document.nodes ?? []) {
    const instancing = node.extensions?.EXT_mesh_gpu_instancing;
    if (instancing) for (const name of Object.keys(instancing.attributes)) instancing.attributes[name] = copyAccessor(instancing.attributes[name]);
  }
  for (const skin of document.skins ?? []) if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = copyAccessor(skin.inverseBindMatrices);
  for (const animation of document.animations ?? []) {
    for (const sampler of animation.samplers) { sampler.input = copyAccessor(sampler.input); sampler.output = copyAccessor(sampler.output); }
  }

  let imageBytesBefore = 0;
  let imageBytesAfter = 0;
  for (const image of document.images ?? []) {
    const view = source.bufferViews[image.bufferView];
    const original = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    imageBytesBefore += original.length;
    let bytes = original;
    if (image.mimeType === 'image/png' || image.mimeType === 'image/jpeg') {
      const metadata = await sharp(original).metadata();
      const longest = Math.max(metadata.width, metadata.height);
      let pipeline = sharp(original);
      if (longest > options.maxTexture) pipeline = pipeline.resize({ width: metadata.width >= metadata.height ? options.maxTexture : undefined, height: metadata.height > metadata.width ? options.maxTexture : undefined });
      const converted = await pipeline.webp({ quality: options.webpQuality, effort: 4, alphaQuality: 90 }).toBuffer();
      if (converted.length < original.length) { bytes = converted; image.mimeType = 'image/webp'; }
    }
    imageBytesAfter += bytes.length;
    image.bufferView = addView(bytes);
  }

  const used = new Set([...(document.extensionsUsed ?? []), 'EXT_meshopt_compression', 'EXT_texture_webp'].filter(name => name !== 'EXT_texture_webp' || document.images?.some(image => image.mimeType === 'image/webp')));
  const required = new Set(document.extensionsRequired ?? []);
  required.add('EXT_meshopt_compression');
  if (used.has('EXT_texture_webp')) required.add('EXT_texture_webp');
  document.extensionsUsed = [...used];
  document.extensionsRequired = [...required];
  document.accessors = newAccessors;
  document.bufferViews = newViews;
  const packed = writer.finish();
  const fallbackLength = newViews.filter(view => view.buffer === 1).reduce((total, view) => total + view.byteLength, 0);
  document.buffers = [{ byteLength: packed.length }, { byteLength: fallbackLength, extensions: { EXT_meshopt_compression: { fallback: true } } }];
  // Fix up the fallback offsets: each compressed view occupies its own range of the (never read) fallback buffer.
  let fallbackOffset = 0;
  for (const view of newViews) if (view.buffer === 1) { view.byteOffset = fallbackOffset; fallbackOffset += view.byteLength; }
  writeFileSync(output, writeGlb(document, packed));
  console.log(JSON.stringify({ ...stats, geometryBytes: packed.length - imageBytesAfter, imageBytesBefore, imageBytesAfter, outputBytes: packed.length }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
