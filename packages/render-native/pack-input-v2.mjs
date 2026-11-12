// Packs a 67js trace scene (or upgrades a legacy v1 input) into the FORMAT-v2 binary tables read by the Cycles-parity
// native kernel (`FORMAT-v2.md` and `src/cycles/abi.wgsl`). Pure typed arrays with zero Node-only imports.

import { buildLightTree } from './light-tree-v2.mjs';
import { THIN_LENS_FLOAT_INDEXES } from './pack-input.mjs';
import {
  TEXTURE_KIND_RG16_FLOAT,
  TEXTURE_KIND_RGBA32_FLOAT,
  TEXTURE_KIND_RGBA8,
  TEXTURE_KIND_RGBA8_SRGB,
  buildMipChain,
  mipChainWordCount,
  mipLevelCount,
} from './texture-mips.mjs';

export const FORMAT_V2_MAGIC = 0x36375054;
export const FORMAT_V2_VERSION = 2;
export const INVALID_INDEX_V2 = 0xffffffff;

// Byte offset of `filter_glossy` inside a `KernelParamsV2` buffer (u32[75] * 4 = 300).
// Used in `packKernelParamsV2` and in `index.mjs` when patching a pre-built buffer.
export const KERNEL_PARAMS_V2_FILTER_GLOSSY_BYTE_OFFSET = 300;
export const KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET = 32;
// Byte offsets of `filter_type` (u32[19]) and `filter_width` (f32[20]); the packer and `traceNative` share them.
export const KERNEL_PARAMS_V2_FILTER_TYPE_BYTE_OFFSET = 76;
export const KERNEL_PARAMS_V2_FILTER_WIDTH_BYTE_OFFSET = 80;

export const VALID_SAMPLERS = Object.freeze(['sobol-burley', 'white']);
/** `auto` picks the light tree when the scene has more than `LIGHT_TREE_AUTO_MIN_EMITTERS` emitters. */
export const VALID_LIGHT_SAMPLING = Object.freeze(['auto', 'tree', 'uniform']);
/** A single emitter is picked with probability 1 either way, so the tree only pays off from two emitters on. */
export const LIGHT_TREE_AUTO_MIN_EMITTERS = 1;

export const STRUCT_STRIDES_V2 = Object.freeze({
  kernelParams: 320,
  instance: 160,
  triangle: 224,
  material: 256,
  emissiveTriangle: 96,
  light: 128,
  lightTreeNode: 64,
  textureDescriptor: 32,
});

export const KERNEL_FLAG_USE_LIGHT_TREE = 1;
/** Tests only: see `KERNEL_FLAG_TEST_NEE_ONLY` and `KERNEL_FLAG_TEST_BSDF_ONLY` in abi.wgsl. */
export const KERNEL_FLAG_LIGHT_TREE_PROBE = 128;
const KERNEL_FLAG_TEST_NEE_ONLY = 256;
const KERNEL_FLAG_TEST_BSDF_ONLY = 512;
export const VALID_DIRECT_LIGHTING = Object.freeze(['both', 'nee-only', 'bsdf-only']);
const KERNEL_FLAG_HAS_VOLUME = 2;
const KERNEL_FLAG_HAS_SUBSURFACE = 4;
const KERNEL_FLAG_ORTHOGRAPHIC_CAMERA = 8;
const KERNEL_FLAG_ADAPTIVE_SAMPLING = 16;
const KERNEL_FLAG_TRANSPARENT_BACKGROUND = 32;
export const KERNEL_FLAG_WHITE_NOISE_SAMPLER = 64;
export const KERNEL_FLAG_PATH_REGENERATION = 1024;
/** Set when any texture of the pool stores mip levels; the kernel then carries a ray footprint (see FORMAT-v2.md). */
export const KERNEL_FLAG_TEXTURE_MIPS = 2048;

const INSTANCE_VISIBILITY_CAMERA = 1;
const INSTANCE_DEFAULT_VISIBILITY = 1 | 2 | 4 | 8 | 16 | 32;
const INSTANCE_FLAG_NEGATIVE_SCALE = 64;

const TRIANGLE_FLAG_SMOOTH_NORMALS = 1;
const TRIANGLE_FLAG_HAS_VERTEX_COLORS = 2;
const TRIANGLE_FLAG_HAS_UV1 = 4;
const TRIANGLE_FLAG_HAS_TANGENTS = 8;
const TRIANGLE_FLAG_DOUBLE_SIDED = 16;

const LIGHT_TYPE_POINT = 0;
const LIGHT_TYPE_SPOT = 1;
const LIGHT_TYPE_AREA_RECT = 2;
const LIGHT_TYPE_AREA_DISK = 3;
const LIGHT_TYPE_SUN = 4;

const LIGHT_FLAG_CAST_SHADOW = 1;
const LIGHT_FLAG_MULTIPLE_IMPORTANCE = 2;
const LIGHT_FLAG_CAMERA_VISIBLE = 4;
const LIGHT_FLAG_PORTAL = 8;
const LIGHT_FLAG_NORMALIZE = 16;

const MATERIAL_FLAG_MULTISCATTER_GGX = 1;
const MATERIAL_FLAG_THIN_WALLED = 2;
const MATERIAL_FLAG_TRANSPARENT_SHADOW = 4;
const MATERIAL_FLAG_DOUBLE_SIDED = 8;
const MATERIAL_FLAG_EMISSIVE_MIS = 16;
const MATERIAL_FLAG_F82_METALLIC = 32;

const ALPHA_MODE_OPAQUE = 0;
const ALPHA_MODE_MASK = 1;
const ALPHA_MODE_BLEND = 2;

const TEXTURE_FORMAT_RGBA8_UNORM = 0;
const TEXTURE_FORMAT_RGBA8_SRGB = 1;
const TEXTURE_FORMAT_RGBA32_FLOAT = 2;
const TEXTURE_FORMAT_RG16_FLOAT = 3;

// All textures share one storage binding of 32-bit words. The native host opens its device with a binding of at most 1 GiB
// (`open_device` in src/host/device.rs), so a pool past this size cannot be bound.
export const TEXTURE_POOL_MAX_BYTES = 1 << 30;
const BYTES_PER_MEBIBYTE = 1 << 20;

const DEFAULT_HDRI_RADIANCE_LIMIT = 16;
const SUN_DEFAULT_HALF_ANGLE = Math.PI / 360;
const IDENTITY_MATRIX_4X4 = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function srgbByteToLinearTable() {
  const table = new Float32Array(256);
  for (let byteValue = 0; byteValue < 256; byteValue++) {
    const encoded = byteValue / 255;
    table[byteValue] = encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  }
  return table;
}

const SRGB_BYTE_TO_LINEAR = srgbByteToLinearTable();

function luminance(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function normalizeVec3(vector, fallback = [0, 0, 1]) {
  const x = Number(vector?.[0] ?? 0);
  const y = Number(vector?.[1] ?? 0);
  const z = Number(vector?.[2] ?? 0);
  const length = Math.hypot(x, y, z);
  if (!(length > 1e-12)) {
    return [fallback[0], fallback[1], fallback[2]];
  }
  return [x / length, y / length, z / length];
}

function crossVec3(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function dotVec3(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function orthonormalBasis(direction) {
  const axisZ = normalizeVec3(direction, [0, 0, 1]);
  const guide = Math.abs(axisZ[1]) < 0.999 ? [0, 1, 0] : [1, 0, 0];
  const axisU = normalizeVec3(crossVec3(guide, axisZ), [1, 0, 0]);
  const axisV = normalizeVec3(crossVec3(axisZ, axisU), [0, 1, 0]);
  return { axisU, axisV };
}

function deterministicUnitHash(seedValue) {
  let state = (seedValue >>> 0) + 0x9e3779b9;
  state = Math.imul(state ^ (state >>> 16), 0x85ebca6b) >>> 0;
  state = Math.imul(state ^ (state >>> 13), 0xc2b2ae35) >>> 0;
  state = (state ^ (state >>> 16)) >>> 0;
  return state / 4294967296;
}

function resolveLightMaskWords(lightMask, lightMaskHi) {
  if (lightMask === undefined || lightMask === null || lightMask < 0) {
    return { lo: 0xffffffff, hi: lightMaskHi === undefined ? 0xffffffff : lightMaskHi >>> 0 };
  }
  return {
    lo: lightMask >>> 0,
    hi: lightMaskHi === undefined ? 0 : lightMaskHi >>> 0,
  };
}

function lightBitMaskWords(bitIndex, explicitMaskLo, explicitMaskHi) {
  if (explicitMaskLo !== undefined) {
    return { lo: explicitMaskLo >>> 0, hi: (explicitMaskHi ?? 0) >>> 0 };
  }
  if (!Number.isInteger(bitIndex) || bitIndex < 0) {
    return { lo: 0xffffffff, hi: 0xffffffff };
  }
  if (bitIndex < 32) {
    return { lo: (1 << bitIndex) >>> 0, hi: 0 };
  }
  if (bitIndex < 64) {
    return { lo: 0, hi: (1 << (bitIndex - 32)) >>> 0 };
  }
  return { lo: 0xffffffff, hi: 0xffffffff };
}

function decomposeAffineMatrix(columnMajorMatrix = IDENTITY_MATRIX_4X4) {
  const m00 = Number(columnMajorMatrix[0]);
  const m10 = Number(columnMajorMatrix[1]);
  const m20 = Number(columnMajorMatrix[2]);
  const m01 = Number(columnMajorMatrix[4]);
  const m11 = Number(columnMajorMatrix[5]);
  const m21 = Number(columnMajorMatrix[6]);
  const m02 = Number(columnMajorMatrix[8]);
  const m12 = Number(columnMajorMatrix[9]);
  const m22 = Number(columnMajorMatrix[10]);
  const tx = Number(columnMajorMatrix[12]);
  const ty = Number(columnMajorMatrix[13]);
  const tz = Number(columnMajorMatrix[14]);

  const c00 = m11 * m22 - m12 * m21;
  const c01 = m12 * m20 - m10 * m22;
  const c02 = m10 * m21 - m11 * m20;
  const c10 = m02 * m21 - m01 * m22;
  const c11 = m00 * m22 - m02 * m20;
  const c12 = m01 * m20 - m00 * m21;
  const c20 = m01 * m12 - m02 * m11;
  const c21 = m02 * m10 - m00 * m12;
  const c22 = m00 * m11 - m01 * m10;
  const determinant = m00 * c00 + m01 * c01 + m02 * c02;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-18) {
    throw new RangeError('Instance affine transform matrix is singular or non-finite.');
  }
  const invDet = 1 / determinant;
  const im00 = c00 * invDet;
  const im01 = c10 * invDet;
  const im02 = c20 * invDet;
  const im10 = c01 * invDet;
  const im11 = c11 * invDet;
  const im12 = c21 * invDet;
  const im20 = c02 * invDet;
  const im21 = c12 * invDet;
  const im22 = c22 * invDet;

  const itx = -(im00 * tx + im01 * ty + im02 * tz);
  const ity = -(im10 * tx + im11 * ty + im12 * tz);
  const itz = -(im20 * tx + im21 * ty + im22 * tz);

  return {
    objectToWorld: [
      m00, m01, m02, tx,
      m10, m11, m12, ty,
      m20, m21, m22, tz,
    ],
    worldToObject: [
      im00, im01, im02, itx,
      im10, im11, im12, ity,
      im20, im21, im22, itz,
    ],
    negativeScale: determinant < 0,
  };
}

function transformPoint3x4(rows, point) {
  return [
    rows[0] * point[0] + rows[1] * point[1] + rows[2] * point[2] + rows[3],
    rows[4] * point[0] + rows[5] * point[1] + rows[6] * point[2] + rows[7],
    rows[8] * point[0] + rows[9] * point[1] + rows[10] * point[2] + rows[11],
  ];
}

function transformDirection3x4(rows, vector) {
  return [
    rows[0] * vector[0] + rows[1] * vector[1] + rows[2] * vector[2],
    rows[4] * vector[0] + rows[5] * vector[1] + rows[6] * vector[2],
    rows[8] * vector[0] + rows[9] * vector[1] + rows[10] * vector[2],
  ];
}

/** Throws unless `value` is undefined, true or false. `name` and `callerName` say which option it was. */
export function validateTextureMipsOption(value, name, callerName) {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new TypeError(
      `${callerName}: \`${name}\` must be true (store mip levels), false or left out (level 0 only, as Blender Cycles reads), got ${JSON.stringify(value)}.`
    );
  }
}

function mipKindOfFormat(format) {
  if (format === TEXTURE_FORMAT_RGBA32_FLOAT) {
    return TEXTURE_KIND_RGBA32_FLOAT;
  }
  if (format === TEXTURE_FORMAT_RG16_FLOAT) {
    return TEXTURE_KIND_RG16_FLOAT;
  }
  return format === TEXTURE_FORMAT_RGBA8_SRGB ? TEXTURE_KIND_RGBA8_SRGB : TEXTURE_KIND_RGBA8;
}

// Level 0 without padding, then the levels after it, padded once at the end to a multiple of four words.
function joinMipLevels(levelZeroWords, mipChain) {
  const joined = new Uint32Array(Math.max(4, Math.ceil((levelZeroWords.length + mipChain.length) / 4) * 4));
  joined.set(levelZeroWords, 0);
  joined.set(mipChain, levelZeroWords.length);
  return joined;
}

/**
 * Collects the textures of a scene into one pool. `textureMips: true` stores a full mip chain after level 0 of every texture
 * that is filtered linearly and has more than one texel; a texture can say `mips: true` or `mips: false` to differ from that.
 * The default is level 0 only, which is what Blender Cycles reads.
 */
function createTextureCollector({ textureMips } = {}) {
  validateTextureMipsOption(textureMips, 'textureMips', 'createTextureCollector');
  const indexByKey = new Map();
  const dataIdMap = new WeakMap();
  let nextDataId = 1;
  const descriptors = [];
  const wordChunks = [];
  let totalWords = 0;
  let finished = null;
  let anyTextureHasMips = false;

  function packedWordCount(format, pixelCount, mipWords = 0) {
    const levelZeroWords = format === TEXTURE_FORMAT_RGBA32_FLOAT ? pixelCount * 4 : pixelCount;
    if (mipWords === 0 && format === TEXTURE_FORMAT_RGBA32_FLOAT) {
      return levelZeroWords;
    }
    return Math.max(4, Math.ceil((levelZeroWords + mipWords) / 4) * 4);
  }

  // The number of levels a texture is stored with, level 0 included: 1 unless mips are asked for and can be used.
  function resolveMipCount(textureOption, nearest, width, height) {
    validateTextureMipsOption(textureOption, 'mips', 'texture');
    const wanted = textureOption ?? textureMips ?? false;
    if (!wanted || nearest) {
      return 1;
    }
    return mipLevelCount(width, height);
  }

  // Checked before a texture is converted, so an oversize image fails fast instead of after allocating its words.
  function assertRoomInPool(wordCount, width, height) {
    if ((totalWords + wordCount) * 4 <= TEXTURE_POOL_MAX_BYTES) {
      return;
    }
    const neededMebibytes = Math.ceil(wordCount * 4 / BYTES_PER_MEBIBYTE);
    const usedMebibytes = Math.ceil(totalWords * 4 / BYTES_PER_MEBIBYTE);
    throw new RangeError(
      `The texture pool is full: the ${width}x${height} texture needs ${neededMebibytes} MiB and the ${descriptors.length} before it take ${usedMebibytes} MiB, ` +
      `but one pool holds at most ${TEXTURE_POOL_MAX_BYTES / BYTES_PER_MEBIBYTE} MiB. Pass smaller textures: downscale the largest maps or drop the ones the look does not need.`,
    );
  }

  function objectIdentity(dataBuffer) {
    if (!dataIdMap.has(dataBuffer)) {
      dataIdMap.set(dataBuffer, nextDataId++);
    }
    return dataIdMap.get(dataBuffer);
  }

  function addTexture(rawDescriptor, defaultSrgb = false) {
    if (!rawDescriptor) {
      return { index: -1, meanLinearRgb: [1, 1, 1] };
    }
    const image = rawDescriptor.image ?? rawDescriptor;
    const width = Number(image.width ?? 0);
    const height = Number(image.height ?? 0);
    const data = image.data;
    if (!(width >= 1 && height >= 1) || !data) {
      return { index: -1, meanLinearRgb: [1, 1, 1] };
    }

    let format = TEXTURE_FORMAT_RGBA8_UNORM;
    if (typeof rawDescriptor.format === 'number') {
      format = rawDescriptor.format & 0xff;
    } else if (data instanceof Float32Array) {
      format = TEXTURE_FORMAT_RGBA32_FLOAT;
    } else if (data instanceof Uint16Array) {
      format = TEXTURE_FORMAT_RG16_FLOAT;
    } else {
      const explicitLinear = rawDescriptor.colorSpace === 'linear' || rawDescriptor.colorLookup === null;
      const explicitSrgb = rawDescriptor.colorSpace === 'srgb' || Boolean(rawDescriptor.colorLookup);
      const isSrgb = explicitLinear ? false : (explicitSrgb || defaultSrgb);
      format = isSrgb ? TEXTURE_FORMAT_RGBA8_SRGB : TEXTURE_FORMAT_RGBA8_UNORM;
    }

    const repeatU = rawDescriptor.wrapU ?? (rawDescriptor.repeat === false ? 1 : 0);
    const repeatV = rawDescriptor.wrapV ?? (rawDescriptor.repeat === false ? 1 : 0);
    const nearest = rawDescriptor.nearest ? 1 : 0;
    const mipCount = resolveMipCount(rawDescriptor.mips, nearest === 1, width, height);
    const useUv1 = rawDescriptor.uvSet === 1 ? 1 : 0;
    const uvScale = rawDescriptor.uvScale ?? [1, 1];
    const uvOffset = rawDescriptor.uvOffset ?? [0, 0];
    const formatAndSampler = (
      (format & 0xff) |
      ((mipCount & 0xff) << 8) |
      ((repeatU & 0x3) << 16) |
      ((repeatV & 0x3) << 18) |
      (nearest << 20) |
      (useUv1 << 21)
    ) >>> 0;

    const dedupeKey = `${objectIdentity(data)}|${width}x${height}|${formatAndSampler}|${uvScale[0]},${uvScale[1]}|${uvOffset[0]},${uvOffset[1]}`;
    if (indexByKey.has(dedupeKey)) {
      return indexByKey.get(dedupeKey);
    }

    const pixelCount = width * height;
    const mipWords = mipCount > 1 ? mipChainWordCount(mipKindOfFormat(format), width, height) : 0;
    assertRoomInPool(packedWordCount(format, pixelCount, mipWords), width, height);
    const dataOffset = totalWords;
    let packedWords;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;

    if (format === TEXTURE_FORMAT_RGBA32_FLOAT) {
      const floatPixels = data instanceof Float32Array ? data : new Float32Array(data);
      const floatBuffer = new ArrayBuffer(pixelCount * 16);
      const floatView = new Float32Array(floatBuffer);
      const channels = Math.max(1, Math.floor(floatPixels.length / pixelCount));
      for (let pixel = 0; pixel < pixelCount; pixel++) {
        const r = floatPixels[pixel * channels] ?? 0;
        const g = channels > 1 ? floatPixels[pixel * channels + 1] : r;
        const b = channels > 2 ? floatPixels[pixel * channels + 2] : r;
        const a = channels > 3 ? floatPixels[pixel * channels + 3] : 1;
        floatView[pixel * 4] = r;
        floatView[pixel * 4 + 1] = g;
        floatView[pixel * 4 + 2] = b;
        floatView[pixel * 4 + 3] = a;
        sumR += r;
        sumG += g;
        sumB += b;
      }
      packedWords = new Uint32Array(floatBuffer);
    } else if (format === TEXTURE_FORMAT_RG16_FLOAT) {
      const halfData = data instanceof Uint16Array ? data : new Uint16Array(data);
      const wordCount = Math.ceil(pixelCount / 1);
      const alignedWords = Math.ceil(wordCount / 4) * 4;
      packedWords = new Uint32Array(alignedWords);
      for (let pixel = 0; pixel < pixelCount; pixel++) {
        const lo = halfData[pixel * 2] ?? 0;
        const hi = halfData[pixel * 2 + 1] ?? 0;
        packedWords[pixel] = (lo | (hi << 16)) >>> 0;
      }
      sumR = pixelCount;
      sumG = pixelCount;
      sumB = pixelCount;
    } else {
      const alignedWords = Math.max(4, Math.ceil(pixelCount / 4) * 4);
      packedWords = new Uint32Array(alignedWords);
      const isSrgb = format === TEXTURE_FORMAT_RGBA8_SRGB;
      for (let pixel = 0; pixel < pixelCount; pixel++) {
        const rByte = data[pixel * 4] & 0xff;
        const gByte = data[pixel * 4 + 1] & 0xff;
        const bByte = data[pixel * 4 + 2] & 0xff;
        const aByte = data[pixel * 4 + 3] & 0xff;
        packedWords[pixel] = (rByte | (gByte << 8) | (bByte << 16) | (aByte << 24)) >>> 0;
        sumR += isSrgb ? SRGB_BYTE_TO_LINEAR[rByte] : rByte / 255;
        sumG += isSrgb ? SRGB_BYTE_TO_LINEAR[gByte] : gByte / 255;
        sumB += isSrgb ? SRGB_BYTE_TO_LINEAR[bByte] : bByte / 255;
      }
    }

    if (mipCount > 1) {
      const levelZeroWordCount = format === TEXTURE_FORMAT_RGBA32_FLOAT ? pixelCount * 4 : pixelCount;
      const levelZeroWords = packedWords.subarray(0, levelZeroWordCount);
      const levelZeroTexels = format === TEXTURE_FORMAT_RGBA32_FLOAT
        ? new Float32Array(packedWords.buffer, packedWords.byteOffset, levelZeroWordCount)
        : levelZeroWords;
      packedWords = joinMipLevels(levelZeroWords, buildMipChain(mipKindOfFormat(format), levelZeroTexels, width, height, repeatU & 0x3, repeatV & 0x3));
      anyTextureHasMips = true;
    }

    const descriptorBytes = new ArrayBuffer(STRUCT_STRIDES_V2.textureDescriptor);
    const descriptorU32 = new Uint32Array(descriptorBytes);
    const descriptorF32 = new Float32Array(descriptorBytes);
    descriptorU32[0] = dataOffset >>> 0;
    descriptorU32[1] = width >>> 0;
    descriptorU32[2] = height >>> 0;
    descriptorU32[3] = formatAndSampler;
    descriptorF32[4] = Number(uvScale[0] ?? 1);
    descriptorF32[5] = Number(uvScale[1] ?? 1);
    descriptorF32[6] = Number(uvOffset[0] ?? 0);
    descriptorF32[7] = Number(uvOffset[1] ?? 0);

    const assignedIndex = descriptors.length;
    descriptors.push(new Uint8Array(descriptorBytes));
    wordChunks.push(packedWords);
    totalWords += packedWords.length;

    const record = {
      index: assignedIndex,
      meanLinearRgb: [sumR / pixelCount, sumG / pixelCount, sumB / pixelCount],
    };
    indexByKey.set(dedupeKey, record);
    return record;
  }

  function addPackedRgba8Words(words, width, height, isSrgb, repeat) {
    const pixelCount = width * height;
    const mipCount = resolveMipCount(undefined, false, width, height);
    const atlasKind = isSrgb ? TEXTURE_KIND_RGBA8_SRGB : TEXTURE_KIND_RGBA8;
    const mipWords = mipCount > 1 ? mipChainWordCount(atlasKind, width, height) : 0;
    const alignedWords = packedWordCount(TEXTURE_FORMAT_RGBA8_UNORM, pixelCount, mipWords);
    assertRoomInPool(alignedWords, width, height);
    let padded = new Uint32Array(alignedWords);
    padded.set(words.subarray(0, pixelCount));
    if (mipCount > 1) {
      const levelZeroWords = padded.slice(0, pixelCount);
      padded = joinMipLevels(levelZeroWords, buildMipChain(atlasKind, levelZeroWords, width, height, repeat ? 0 : 1, repeat ? 0 : 1));
      anyTextureHasMips = true;
    }
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      const word = padded[pixel];
      const rByte = word & 0xff;
      const gByte = (word >>> 8) & 0xff;
      const bByte = (word >>> 16) & 0xff;
      sumR += isSrgb ? SRGB_BYTE_TO_LINEAR[rByte] : rByte / 255;
      sumG += isSrgb ? SRGB_BYTE_TO_LINEAR[gByte] : gByte / 255;
      sumB += isSrgb ? SRGB_BYTE_TO_LINEAR[bByte] : bByte / 255;
    }
    const format = isSrgb ? TEXTURE_FORMAT_RGBA8_SRGB : TEXTURE_FORMAT_RGBA8_UNORM;
    const wrap = repeat ? 0 : 1;
    const formatAndSampler = (format | (mipCount << 8) | (wrap << 16) | (wrap << 18)) >>> 0;
    const descriptorBytes = new ArrayBuffer(STRUCT_STRIDES_V2.textureDescriptor);
    const descriptorU32 = new Uint32Array(descriptorBytes);
    const descriptorF32 = new Float32Array(descriptorBytes);
    descriptorU32[0] = totalWords >>> 0;
    descriptorU32[1] = width >>> 0;
    descriptorU32[2] = height >>> 0;
    descriptorU32[3] = formatAndSampler;
    descriptorF32[4] = 1;
    descriptorF32[5] = 1;
    descriptorF32[6] = 0;
    descriptorF32[7] = 0;

    const assignedIndex = descriptors.length;
    descriptors.push(new Uint8Array(descriptorBytes));
    wordChunks.push(padded);
    totalWords += padded.length;
    return {
      index: assignedIndex,
      meanLinearRgb: [sumR / pixelCount, sumG / pixelCount, sumB / pixelCount],
    };
  }

  function finish() {
    finished ??= buildFinishedTextures();
    return finished;
  }

  // The per-texture word arrays are dropped once they are joined, so the host holds one copy of the pool, not two.
  function buildFinishedTextures() {
    const textureCount = descriptors.length;
    const descriptorBuffer = new Uint8Array(Math.max(1, textureCount) * STRUCT_STRIDES_V2.textureDescriptor);
    for (let index = 0; index < textureCount; index++) {
      descriptorBuffer.set(descriptors[index], index * STRUCT_STRIDES_V2.textureDescriptor);
    }
    const texelBuffer = new Uint32Array(Math.max(4, totalWords));
    let cursor = 0;
    for (const chunk of wordChunks) {
      texelBuffer.set(chunk, cursor);
      cursor += chunk.length;
    }
    wordChunks.length = 0;
    return {
      textureDescriptors: descriptorBuffer,
      textureCount,
      textureTexels: texelBuffer,
      usesTextureMips: anyTextureHasMips,
    };
  }

  return { addTexture, addPackedRgba8Words, finish };
}

function resolveAlphaMode(material, alpha, alphaCutoff) {
  if (typeof material.alphaMode === 'number') {
    return material.alphaMode >>> 0;
  }
  if (material.alphaMode === 'mask') {
    return ALPHA_MODE_MASK;
  }
  if (material.alphaMode === 'blend') {
    return alphaCutoff > 0 ? ALPHA_MODE_MASK : ALPHA_MODE_BLEND;
  }
  if (alphaCutoff > 0) {
    return ALPHA_MODE_MASK;
  }
  if (alpha < 1) {
    return ALPHA_MODE_BLEND;
  }
  return ALPHA_MODE_OPAQUE;
}

function resolveEmissionFields(material) {
  if (material.emissionStrength !== undefined) {
    const strength = Math.max(0, Number(material.emissionStrength));
    const color = material.emissionColor ?? material.emissiveColor ?? material.baseColor ?? material.color ?? [1, 1, 1];
    return { emissionColor: [color[0], color[1], color[2]], emissionStrength: strength };
  }
  if (typeof material.emission === 'number') {
    const strength = Math.max(0, material.emission);
    const color = material.emissiveColor ?? material.emissionColor ?? material.baseColor ?? material.color ?? [1, 1, 1];
    return { emissionColor: [color[0], color[1], color[2]], emissionStrength: strength };
  }
  if (Array.isArray(material.emission) || ArrayBuffer.isView(material.emission)) {
    const r = Math.max(0, Number(material.emission[0] ?? 0));
    const g = Math.max(0, Number(material.emission[1] ?? 0));
    const b = Math.max(0, Number(material.emission[2] ?? 0));
    const strength = Math.max(r, g, b);
    if (strength > 0) {
      return {
        emissionColor: [r / strength, g / strength, b / strength],
        emissionStrength: strength,
      };
    }
  }
  return { emissionColor: [0, 0, 0], emissionStrength: 0 };
}

function resolveSubsurfaceFields(material, baseColor) {
  const block = material.subsurface;
  const directWeight = Number(material.subsurfaceWeight ?? block?.weight ?? 0);
  if (!(directWeight > 0)) {
    return {
      weight: 0,
      radius: [0, 0, 0],
      color: [baseColor[0], baseColor[1], baseColor[2]],
      anisotropy: 0,
      ior: Number(material.subsurfaceIor ?? 1.4),
    };
  }
  const scale = Number(block?.scale ?? 1);
  const rawRadius = material.subsurfaceRadius ?? block?.meanFreePath ?? (
    block?.radius ? [block.radius[0] * scale, block.radius[1] * scale, block.radius[2] * scale] : [1, 0.2, 0.1]
  );
  const radius = [
    Math.max(1e-6, Number(rawRadius[0] ?? 1e-6)),
    Math.max(1e-6, Number(rawRadius[1] ?? 1e-6)),
    Math.max(1e-6, Number(rawRadius[2] ?? 1e-6)),
  ];
  const rawColor = material.subsurfaceColor ?? block?.color ?? baseColor;
  return {
    weight: Math.min(1, Math.max(0, directWeight)),
    radius,
    color: [Number(rawColor[0]), Number(rawColor[1]), Number(rawColor[2])],
    anisotropy: Math.max(-0.9, Math.min(0.9, Number(material.subsurfaceAnisotropy ?? block?.anisotropy ?? 0))),
    ior: Number(material.subsurfaceIor ?? block?.ior ?? 1.4),
  };
}

/**
 * Packs one `MaterialRecord` (256 B) matching `FORMAT-v2.md` section 4 and `src/cycles/abi.wgsl`.
 */
export function packMaterialRecordV2(material = {}, textureCollector = null) {
  const buffer = new ArrayBuffer(STRUCT_STRIDES_V2.material);
  const f32 = new Float32Array(buffer);
  const u32 = new Uint32Array(buffer);
  const i32 = new Int32Array(buffer);

  const baseColor = material.baseColor ?? material.color ?? [1, 1, 1];
  const metallic = Math.min(1, Math.max(0, Number(material.metallic ?? 0)));
  const roughness = Math.min(1, Math.max(0, Number(material.roughness ?? 0.5)));
  const isLiquid = material.tag === 'liquid' && material.liquid;
  const ior = Number(isLiquid ? (material.liquid.ior ?? material.ior ?? 1.33) : (material.ior ?? 1.5));
  const specularIorLevel = material.specularIorLevel !== undefined
    ? Number(material.specularIorLevel)
    : 0.5 * Number(material.specular ?? 1);
  const diffuseRoughness = Math.min(1, Math.max(0, Number(material.diffuseRoughness ?? 0)));

  const hasExplicitF82 = Boolean(material.f82Tint || material.specularColor);
  const f82Tint = material.f82Tint ?? material.specularColor ?? [1, 1, 1];
  const anisotropy = Math.min(1, Math.max(0, Number(material.anisotropy ?? 0)));
  const anisotropyRotation = Number(material.anisotropyRotation ?? 0);
  const transmissionWeight = Math.min(
    1,
    Math.max(0, Number(isLiquid ? 1 : (material.transmissionWeight ?? material.transmission ?? 0))),
  );
  const alpha = Math.min(1, Math.max(0, Number(material.alpha ?? material.opacity ?? 1)));
  const rawCutoff = Number(
    material.alphaCutoff !== undefined
      ? material.alphaCutoff
      : (material.alphaMode === 'mask' ? 0.5 : 0),
  );
  const alphaMode = resolveAlphaMode(material, alpha, rawCutoff);
  const alphaCutoff = alphaMode === ALPHA_MODE_MASK ? (rawCutoff > 0 ? rawCutoff : 0.5) : 0;

  const coatTint = material.coatTint ?? material.clearcoatTint ?? [1, 1, 1];
  const coatWeight = Math.min(1, Math.max(0, Number(material.coatWeight ?? material.clearcoat ?? 0)));
  const coatRoughness = Math.min(1, Math.max(0, Number(material.coatRoughness ?? material.clearcoatRoughness ?? 0)));
  const coatIor = Number(material.coatIor ?? material.clearcoatIor ?? 1.5);

  const iridescenceFactor = Number(material.iridescence ?? 1);
  const thinFilmThickness = material.thinFilmThickness !== undefined
    ? Math.max(0, Number(material.thinFilmThickness))
    : (material.iridescenceThickness !== undefined && iridescenceFactor > 0
      ? Math.max(0, Number(material.iridescenceThickness) * iridescenceFactor)
      : 0);
  const thinFilmIor = Number(material.thinFilmIor ?? material.iridescenceIor ?? 1.33);

  const rawSheenColor = material.sheenTint ?? material.sheenColor ?? [1, 1, 1];
  const sheenWeight = material.sheenWeight !== undefined
    ? Math.min(1, Math.max(0, Number(material.sheenWeight)))
    : (material.sheenColor ? 1 : 0);
  const sheenRoughness = Math.min(1, Math.max(0, Number(material.sheenRoughness ?? 0.5)));

  const rawAttenuationDistance = Number(material.absorptionDistance ?? material.attenuationDistance ?? 0);
  const absorptionDistance = Number.isFinite(rawAttenuationDistance) && rawAttenuationDistance > 0
    ? rawAttenuationDistance
    : 0;
  const absorptionColor = material.absorptionColor ?? material.attenuationColor ?? [1, 1, 1];

  const { emissionColor, emissionStrength } = resolveEmissionFields(material);
  const subsurface = resolveSubsurfaceFields(material, baseColor);
  const normalScale = Array.isArray(material.normalScale) || ArrayBuffer.isView(material.normalScale)
    ? 0.5 * (Math.abs(Number(material.normalScale[0] ?? 1)) + Math.abs(Number(material.normalScale[1] ?? 1)))
    : Number(material.normalScale ?? 1);
  const coatNormalScale = Number(material.coatNormalScale ?? 1);
  const bumpDistance = Math.max(0, Number(material.bumpDistance ?? 0));

  const collector = textureCollector;
  const baseTex = collector
    ? collector.addTexture(material.texture ?? material.map, true)
    : { index: Number(material.baseColorTex ?? -1), meanLinearRgb: [1, 1, 1] };
  const mrTex = collector
    ? collector.addTexture(material.surfaceTexture ?? material.metallicRoughnessMap, false)
    : { index: Number(material.metallicRoughnessTex ?? -1), meanLinearRgb: [1, 1, 1] };
  const normalTex = collector
    ? collector.addTexture(material.normalTexture ?? material.normalMap, false)
    : { index: Number(material.normalTex ?? -1), meanLinearRgb: [1, 1, 1] };
  const emissionTex = collector
    ? collector.addTexture(material.emissiveTexture ?? (emissionStrength > 0 ? material.emissiveMap : null), true)
    : { index: Number(material.emissionTex ?? -1), meanLinearRgb: [1, 1, 1] };
  const transmissionTex = collector
    ? collector.addTexture(material.transmissionTexture ?? material.transmissionMap, false)
    : { index: Number(material.transmissionTex ?? -1), meanLinearRgb: [1, 1, 1] };
  const coatTex = collector
    ? collector.addTexture(material.clearcoatTexture ?? material.layerMaps?.clearcoatTexture, false)
    : { index: Number(material.coatWeightRoughnessTex ?? -1), meanLinearRgb: [1, 1, 1] };
  const coatTintTex = collector
    ? collector.addTexture(material.coatTintTexture ?? material.coatTintMap, true)
    : { index: Number(material.coatTintTex ?? -1), meanLinearRgb: [1, 1, 1] };
  const coatNormalTex = collector
    ? collector.addTexture(material.coatNormalTexture ?? material.coatNormalMap, false)
    : { index: Number(material.coatNormalTex ?? -1), meanLinearRgb: [1, 1, 1] };
  const sheenTex = collector
    ? collector.addTexture(material.sheenTexture ?? material.sheenMap, true)
    : { index: Number(material.sheenColorRoughnessTex ?? -1), meanLinearRgb: [1, 1, 1] };
  const anisotropyTex = collector
    ? collector.addTexture(material.anisotropyTexture ?? material.anisotropyMap, false)
    : { index: Number(material.anisotropyTex ?? -1), meanLinearRgb: [1, 1, 1] };
  const explicitAlphaTex = collector
    ? collector.addTexture(material.alphaTexture ?? material.alphaMap, false)
    : { index: Number(material.alphaTex ?? -1), meanLinearRgb: [1, 1, 1] };
  const bumpTex = collector
    ? collector.addTexture(material.bumpTexture ?? material.bumpMap, false)
    : { index: Number(material.bumpTex ?? -1), meanLinearRgb: [1, 1, 1] };

  // The kernel reads the alpha of the base colour map itself (its alpha channel). `alpha_tex` is a separate map read through its
  // red channel, so pointing it at the base colour map would multiply the alpha by the colour's red (and, for an sRGB map, by its
  // linearised red): a cutout then loses every texel that is not red enough. Only an explicit alpha map sets it.
  const alphaTexIndex = explicitAlphaTex.index;

  let flags = 0;
  if (material.multiscatterGgx !== false) {
    flags |= MATERIAL_FLAG_MULTISCATTER_GGX;
  }
  if (material.thinWalled) {
    flags |= MATERIAL_FLAG_THIN_WALLED;
  }
  if (material.transparentShadow !== false) {
    flags |= MATERIAL_FLAG_TRANSPARENT_SHADOW;
  }
  if (material.doubleSided !== false) {
    flags |= MATERIAL_FLAG_DOUBLE_SIDED;
  }
  if (emissionStrength > 0 && luminance(emissionColor) > 0 && material.emissiveMis !== false) {
    flags |= MATERIAL_FLAG_EMISSIVE_MIS;
  }
  if ((hasExplicitF82 && metallic > 0) || material.f82Metallic) {
    flags |= MATERIAL_FLAG_F82_METALLIC;
  }
  if (typeof material.flags === 'number') {
    flags = material.flags >>> 0;
  }

  f32[0] = Number(baseColor[0]);
  f32[1] = Number(baseColor[1]);
  f32[2] = Number(baseColor[2]);
  f32[3] = metallic;

  f32[4] = roughness;
  f32[5] = ior;
  f32[6] = specularIorLevel;
  f32[7] = diffuseRoughness;

  f32[8] = Number(f82Tint[0]);
  f32[9] = Number(f82Tint[1]);
  f32[10] = Number(f82Tint[2]);
  f32[11] = anisotropy;

  f32[12] = anisotropyRotation;
  f32[13] = transmissionWeight;
  f32[14] = alpha;
  f32[15] = alphaCutoff;

  f32[16] = Number(coatTint[0]);
  f32[17] = Number(coatTint[1]);
  f32[18] = Number(coatTint[2]);
  f32[19] = coatWeight;

  f32[20] = coatRoughness;
  f32[21] = coatIor;
  f32[22] = thinFilmThickness;
  f32[23] = thinFilmIor;

  f32[24] = Number(rawSheenColor[0]);
  f32[25] = Number(rawSheenColor[1]);
  f32[26] = Number(rawSheenColor[2]);
  f32[27] = sheenWeight;

  f32[28] = Number(absorptionColor[0]);
  f32[29] = Number(absorptionColor[1]);
  f32[30] = Number(absorptionColor[2]);
  f32[31] = absorptionDistance;

  f32[32] = Number(emissionColor[0]);
  f32[33] = Number(emissionColor[1]);
  f32[34] = Number(emissionColor[2]);
  f32[35] = emissionStrength;

  f32[36] = subsurface.radius[0];
  f32[37] = subsurface.radius[1];
  f32[38] = subsurface.radius[2];
  f32[39] = subsurface.weight;

  f32[40] = subsurface.color[0];
  f32[41] = subsurface.color[1];
  f32[42] = subsurface.color[2];
  f32[43] = subsurface.anisotropy;

  f32[44] = sheenRoughness;
  f32[45] = subsurface.ior;
  f32[46] = normalScale;
  f32[47] = coatNormalScale;

  u32[48] = flags >>> 0;
  u32[49] = alphaMode >>> 0;
  f32[50] = bumpDistance;
  u32[51] = INVALID_INDEX_V2;

  i32[52] = baseTex.index;
  i32[53] = mrTex.index;
  i32[54] = normalTex.index;
  i32[55] = emissionTex.index;
  i32[56] = transmissionTex.index;
  i32[57] = coatTex.index;
  i32[58] = coatTintTex.index;
  i32[59] = coatNormalTex.index;
  i32[60] = sheenTex.index;
  i32[61] = anisotropyTex.index;
  i32[62] = alphaTexIndex;
  i32[63] = bumpTex.index;

  const meanEmissiveRadiance = [
    emissionColor[0] * emissionStrength * emissionTex.meanLinearRgb[0],
    emissionColor[1] * emissionStrength * emissionTex.meanLinearRgb[1],
    emissionColor[2] * emissionStrength * emissionTex.meanLinearRgb[2],
  ];

  return {
    bytes: new Uint8Array(buffer),
    alphaMode,
    usesSubsurface: subsurface.weight > 0,
    isEmissive: (flags & MATERIAL_FLAG_EMISSIVE_MIS) !== 0 && luminance(meanEmissiveRadiance) > 0,
    meanEmissiveRadiance,
  };
}

function computeTriangleTangents(edge1, edge2, n0, n1, n2, uv0, uv1, uv2) {
  const du1 = uv1[0] - uv0[0];
  const dv1 = uv1[1] - uv0[1];
  const du2 = uv2[0] - uv0[0];
  const dv2 = uv2[1] - uv0[1];
  const det = du1 * dv2 - du2 * dv1;
  if (Math.abs(det) < 1e-12) {
    const t0 = orthonormalBasis(n0).axisU;
    const t1 = orthonormalBasis(n1).axisU;
    const t2 = orthonormalBasis(n2).axisU;
    return { t0, t1, t2, sign: 1.0, hasUvTangents: false };
  }
  const invDet = 1 / det;
  const rawTangent = [
    (edge1[0] * dv2 - edge2[0] * dv1) * invDet,
    (edge1[1] * dv2 - edge2[1] * dv1) * invDet,
    (edge1[2] * dv2 - edge2[2] * dv1) * invDet,
  ];
  const rawBitangent = [
    (edge2[0] * du1 - edge1[0] * du2) * invDet,
    (edge2[1] * du1 - edge1[1] * du2) * invDet,
    (edge2[2] * du1 - edge1[2] * du2) * invDet,
  ];

  function projectTangent(normal) {
    const proj = dotVec3(rawTangent, normal);
    const ortho = [
      rawTangent[0] - normal[0] * proj,
      rawTangent[1] - normal[1] * proj,
      rawTangent[2] - normal[2] * proj,
    ];
    const len = Math.hypot(ortho[0], ortho[1], ortho[2]);
    if (!(len > 1e-12)) {
      return orthonormalBasis(normal).axisU;
    }
    return [ortho[0] / len, ortho[1] / len, ortho[2] / len];
  }

  const t0 = projectTangent(n0);
  const t1 = projectTangent(n1);
  const t2 = projectTangent(n2);
  const sign = dotVec3(crossVec3(n0, t0), rawBitangent) < 0 ? -1.0 : 1.0;
  return { t0, t1, t2, sign, hasUvTangents: true };
}

function writeTriangleRecordBytes(targetBytes, byteOffset, tri) {
  const viewBuffer = targetBytes.buffer;
  const baseByte = targetBytes.byteOffset + byteOffset;
  const f32 = new Float32Array(viewBuffer, baseByte, 56);
  const u32 = new Uint32Array(viewBuffer, baseByte, 56);

  f32[0] = tri.p0[0];
  f32[1] = tri.p0[1];
  f32[2] = tri.p0[2];
  u32[3] = tri.materialIndex >>> 0;

  f32[4] = tri.edge1[0];
  f32[5] = tri.edge1[1];
  f32[6] = tri.edge1[2];
  u32[7] = tri.localEmissiveOffset >>> 0;

  f32[8] = tri.edge2[0];
  f32[9] = tri.edge2[1];
  f32[10] = tri.edge2[2];
  u32[11] = tri.flags >>> 0;

  f32[12] = tri.n0[0];
  f32[13] = tri.n0[1];
  f32[14] = tri.n0[2];
  f32[15] = tri.uv0[0];

  f32[16] = tri.n1[0];
  f32[17] = tri.n1[1];
  f32[18] = tri.n1[2];
  f32[19] = tri.uv0[1];

  f32[20] = tri.n2[0];
  f32[21] = tri.n2[1];
  f32[22] = tri.n2[2];
  f32[23] = tri.uv1[0];

  f32[24] = tri.t0[0];
  f32[25] = tri.t0[1];
  f32[26] = tri.t0[2];
  f32[27] = tri.uv1[1];

  f32[28] = tri.t1[0];
  f32[29] = tri.t1[1];
  f32[30] = tri.t1[2];
  f32[31] = tri.uv2[0];

  f32[32] = tri.t2[0];
  f32[33] = tri.t2[1];
  f32[34] = tri.t2[2];
  f32[35] = tri.uv2[1];

  f32[36] = tri.c0[0];
  f32[37] = tri.c0[1];
  f32[38] = tri.c0[2];
  f32[39] = tri.tangentSign;

  f32[40] = tri.c1[0];
  f32[41] = tri.c1[1];
  f32[42] = tri.c1[2];
  u32[43] = tri.meshId >>> 0;

  f32[44] = tri.c2[0];
  f32[45] = tri.c2[1];
  f32[46] = tri.c2[2];
  u32[47] = tri.primitiveId >>> 0;

  f32[48] = tri.uvSet1_0[0];
  f32[49] = tri.uvSet1_0[1];
  f32[50] = tri.uvSet1_1[0];
  f32[51] = tri.uvSet1_1[1];
  f32[52] = tri.uvSet1_2[0];
  f32[53] = tri.uvSet1_2[1];
  u32[54] = INVALID_INDEX_V2;
  u32[55] = 0;
}

function writeInstanceRecordBytes(targetBytes, byteOffset, inst) {
  const baseByte = targetBytes.byteOffset + byteOffset;
  const f32 = new Float32Array(targetBytes.buffer, baseByte, 40);
  const u32 = new Uint32Array(targetBytes.buffer, baseByte, 40);

  for (let index = 0; index < 12; index++) {
    f32[index] = inst.objectToWorld[index];
    f32[12 + index] = inst.worldToObject[index];
  }
  u32[24] = inst.blasIndex >>> 0;
  u32[25] = inst.triangleOffset >>> 0;
  u32[26] = inst.opaqueTriangleCount >>> 0;
  u32[27] = inst.totalTriangleCount >>> 0;
  u32[28] = inst.materialOverride >>> 0;
  u32[29] = inst.visibilityFlags >>> 0;
  u32[30] = inst.lightGroupMaskLo >>> 0;
  u32[31] = inst.lightGroupMaskHi >>> 0;
  u32[32] = inst.emissiveBaseOffset >>> 0;
  u32[33] = inst.objectId >>> 0;
  f32[34] = inst.objectRandom;
  f32[35] = inst.shadowTerminatorOffset ?? 0;
  f32[36] = inst.objectColor[0];
  f32[37] = inst.objectColor[1];
  f32[38] = inst.objectColor[2];
  f32[39] = inst.objectColor[3];
}

function packEmissiveTriangleBuffer(emissiveList) {
  const count = emissiveList.length;
  const buffer = new Uint8Array(Math.max(1, count) * STRUCT_STRIDES_V2.emissiveTriangle);
  if (count === 0) {
    return { emissiveTriangles: buffer, emissiveTriangleCount: 0, emissiveTotalWeight: 0, boundsMin: null, boundsMax: null, maskOr: 0 };
  }
  let totalWeight = 0;
  for (const item of emissiveList) {
    totalWeight += item.selectionWeight;
  }
  if (!(totalWeight > 0)) {
    totalWeight = count;
  }
  const boundsMin = [Infinity, Infinity, Infinity];
  const boundsMax = [-Infinity, -Infinity, -Infinity];
  let maskOr = 0;
  let cumulative = 0;

  for (let index = 0; index < count; index++) {
    const item = emissiveList[index];
    const pdf = item.selectionWeight > 0 ? item.selectionWeight / totalWeight : 1 / count;
    cumulative += pdf;
    const cdfUpper = index === count - 1 ? 1.0 : Math.min(1.0, cumulative);

    const baseByte = index * STRUCT_STRIDES_V2.emissiveTriangle;
    const f32 = new Float32Array(buffer.buffer, baseByte, 24);
    const u32 = new Uint32Array(buffer.buffer, baseByte, 24);

    f32[0] = item.p0[0];
    f32[1] = item.p0[1];
    f32[2] = item.p0[2];
    f32[3] = item.area;

    f32[4] = item.edge1[0];
    f32[5] = item.edge1[1];
    f32[6] = item.edge1[2];
    u32[7] = item.instanceIndex >>> 0;

    f32[8] = item.edge2[0];
    f32[9] = item.edge2[1];
    f32[10] = item.edge2[2];
    u32[11] = item.triangleIndex >>> 0;

    f32[12] = item.geometricNormal[0];
    f32[13] = item.geometricNormal[1];
    f32[14] = item.geometricNormal[2];
    u32[15] = item.materialIndex >>> 0;

    f32[16] = item.radiance[0];
    f32[17] = item.radiance[1];
    f32[18] = item.radiance[2];
    f32[19] = item.selectionWeight;

    f32[20] = pdf;
    f32[21] = cdfUpper;
    u32[22] = item.lightGroupMaskLo >>> 0;
    u32[23] = item.lightGroupMaskHi >>> 0;

    maskOr = (maskOr | item.lightGroupMaskLo) >>> 0;
    const p1 = [item.p0[0] + item.edge1[0], item.p0[1] + item.edge1[1], item.p0[2] + item.edge1[2]];
    const p2 = [item.p0[0] + item.edge2[0], item.p0[1] + item.edge2[1], item.p0[2] + item.edge2[2]];
    for (let axis = 0; axis < 3; axis++) {
      boundsMin[axis] = Math.min(boundsMin[axis], item.p0[axis], p1[axis], p2[axis]);
      boundsMax[axis] = Math.max(boundsMax[axis], item.p0[axis], p1[axis], p2[axis]);
    }
  }

  return {
    emissiveTriangles: buffer,
    emissiveTriangleCount: count,
    emissiveTotalWeight: totalWeight,
    boundsMin,
    boundsMax,
    maskOr,
  };
}

function buildAnalyticLightEntries(lightsSection = {}) {
  const records = [];

  if (lightsSection.sun) {
    const sun = lightsSection.sun;
    const sunColor = sun.color ?? [0, 0, 0];
    const maxChannel = Math.max(sunColor[0], sunColor[1], sunColor[2]);
    if (maxChannel > 0) {
      const towardSun = normalizeVec3(sun.direction, [0, 1, 0]);
      const emissionDirection = [-towardSun[0], -towardSun[1], -towardSun[2]];
      const { axisU, axisV } = orthonormalBasis(emissionDirection);
      const halfAngle = Math.max(0, Number(sun.angularRadius ?? SUN_DEFAULT_HALF_ANGLE));
      const cosHalfAngle = Math.cos(halfAngle);
      const sinHalfAngle = Math.sin(halfAngle);
      const discFactor = sinHalfAngle > 1e-7 ? Math.PI * sinHalfAngle * sinHalfAngle : 1;
      const solidAngle = halfAngle > 0 ? 2 * Math.PI * (1 - cosHalfAngle) : 0;
      const radiance = [
        sunColor[0] / discFactor,
        sunColor[1] / discFactor,
        sunColor[2] / discFactor,
      ];
      let flags = LIGHT_FLAG_NORMALIZE;
      if (sun.cyclesCastShadow !== false) {
        flags |= LIGHT_FLAG_CAST_SHADOW;
      }
      if (halfAngle > 0 && sun.multipleImportance !== false) {
        flags |= LIGHT_FLAG_MULTIPLE_IMPORTANCE;
      }
      if (sun.cameraVisible === true) {
        flags |= LIGHT_FLAG_CAMERA_VISIBLE;
      }
      const masks = lightBitMaskWords(sun.bit, sun.lightGroupMaskLo, sun.lightGroupMaskHi);
      const weight = Math.max(1e-6, Math.PI * luminance(sunColor));
      records.push({
        position: [0, 0, 0],
        lightType: LIGHT_TYPE_SUN,
        radiance,
        flags,
        direction: emissionDirection,
        radius: 0,
        axisU,
        sizeU: 0,
        axisV,
        sizeV: 0,
        cosHalfAngle,
        spotBlend: 0,
        tanHalfSpread: 0,
        spreadNormalization: 0,
        areaOrSolidAngle: solidAngle,
        maxDistance: 1e30,
        masks,
        weight,
        isDistant: true,
      });
    }
  }

  for (const point of lightsSection.points ?? []) {
    const intensity = Math.max(0, Number(point.intensity ?? 0));
    const color = point.color ?? [1, 1, 1];
    if (!(intensity > 0) || !(luminance(color) > 0)) {
      continue;
    }
    const radius = Math.max(0, Number(point.radius ?? 0));
    const radianceScale = radius > 0 ? intensity / (Math.PI * radius * radius) : intensity;
    const radiance = [color[0] * radianceScale, color[1] * radianceScale, color[2] * radianceScale];
    let flags = LIGHT_FLAG_NORMALIZE;
    if (point.cyclesCastShadow !== false) {
      flags |= LIGHT_FLAG_CAST_SHADOW;
    }
    if (radius > 0 && point.multipleImportance !== false) {
      flags |= LIGHT_FLAG_MULTIPLE_IMPORTANCE;
    }
    if (point.cameraVisible === true) {
      flags |= LIGHT_FLAG_CAMERA_VISIBLE;
    }
    const masks = lightBitMaskWords(point.bit, point.lightGroupMaskLo, point.lightGroupMaskHi);
    const maxDistance = point.range > 0 ? Number(point.range) : 1e30;
    const weight = Math.max(1e-6, 4 * Math.PI * luminance(color) * intensity);
    records.push({
      position: [Number(point.position[0]), Number(point.position[1]), Number(point.position[2])],
      lightType: LIGHT_TYPE_POINT,
      radiance,
      flags,
      direction: [0, -1, 0],
      radius,
      axisU: [1, 0, 0],
      sizeU: 0,
      axisV: [0, 0, 1],
      sizeV: 0,
      cosHalfAngle: -1,
      spotBlend: 0,
      tanHalfSpread: 0,
      spreadNormalization: 0,
      areaOrSolidAngle: radius > 0 ? 4 * Math.PI * radius * radius : 0,
      maxDistance,
      masks,
      weight,
      isDistant: false,
    });
  }

  for (const spot of lightsSection.spots ?? []) {
    const intensity = Math.max(0, Number(spot.intensity ?? 0));
    const color = spot.color ?? [1, 1, 1];
    if (!(intensity > 0) || !(luminance(color) > 0)) {
      continue;
    }
    const radius = Math.max(0, Number(spot.radius ?? 0));
    const radianceScale = radius > 0 ? intensity / (Math.PI * radius * radius) : intensity;
    const radiance = [color[0] * radianceScale, color[1] * radianceScale, color[2] * radianceScale];
    const direction = normalizeVec3(spot.direction, [0, -1, 0]);
    const { axisU, axisV } = orthonormalBasis(direction);
    const cosHalfAngle = spot.cosineHalfAngle !== undefined
      ? Number(spot.cosineHalfAngle)
      : Math.cos(Number(spot.angle ?? Math.PI / 4));
    let spotBlend = 0;
    if (spot.spotBlend !== undefined) {
      spotBlend = Number(spot.spotBlend);
    } else if (spot.penumbra !== undefined) {
      spotBlend = Number(spot.penumbra);
    } else if (spot.blend !== undefined) {
      const denom = 1 - cosHalfAngle;
      spotBlend = denom > 1e-8 ? Number(spot.blend) / denom : 0;
    }
    spotBlend = Math.min(1, Math.max(0, spotBlend));

    let flags = LIGHT_FLAG_NORMALIZE;
    if (spot.cyclesCastShadow !== false) {
      flags |= LIGHT_FLAG_CAST_SHADOW;
    }
    if (radius > 0 && spot.multipleImportance !== false) {
      flags |= LIGHT_FLAG_MULTIPLE_IMPORTANCE;
    }
    if (spot.cameraVisible === true) {
      flags |= LIGHT_FLAG_CAMERA_VISIBLE;
    }
    const masks = lightBitMaskWords(spot.bit, spot.lightGroupMaskLo, spot.lightGroupMaskHi);
    const maxDistance = spot.range > 0 ? Number(spot.range) : 1e30;
    const coneSolidAngle = Math.max(1e-4, 2 * Math.PI * Math.max(0, 1 - cosHalfAngle));
    const weight = Math.max(1e-6, coneSolidAngle * luminance(color) * intensity);
    records.push({
      position: [Number(spot.position[0]), Number(spot.position[1]), Number(spot.position[2])],
      lightType: LIGHT_TYPE_SPOT,
      radiance,
      flags,
      direction,
      radius,
      axisU,
      sizeU: 0,
      axisV,
      sizeV: 0,
      cosHalfAngle,
      spotBlend,
      tanHalfSpread: 0,
      spreadNormalization: 0,
      areaOrSolidAngle: radius > 0 ? 4 * Math.PI * radius * radius : 0,
      maxDistance,
      masks,
      weight,
      isDistant: false,
    });
  }

  for (const area of lightsSection.areas ?? []) {
    const intensity = Math.max(0, Number(area.intensity ?? 0));
    const color = area.color ?? [1, 1, 1];
    const width = Math.max(1e-6, Number(area.width ?? area.sizeU ?? 1));
    const height = Math.max(1e-6, Number(area.height ?? area.sizeV ?? width));
    if (!(intensity > 0) || !(luminance(color) > 0)) {
      continue;
    }
    const isDisk = area.shape === 'disk' || area.shape === 'ellipse' || area.lightType === LIGHT_TYPE_AREA_DISK;
    const surfaceArea = isDisk ? Math.PI * 0.25 * width * height : width * height;
    const radianceScale = intensity / surfaceArea;
    const radiance = [color[0] * radianceScale, color[1] * radianceScale, color[2] * radianceScale];
    const direction = normalizeVec3(area.normal ?? area.direction, [0, -1, 0]);
    let axisU;
    let axisV;
    if (area.across && area.along) {
      axisU = normalizeVec3(area.across, [1, 0, 0]);
      axisV = normalizeVec3(area.along, [0, 0, 1]);
    } else {
      const guide = normalizeVec3(area.up ?? [0, 1, 0], [0, 1, 0]);
      axisU = normalizeVec3(crossVec3(guide, direction), [1, 0, 0]);
      axisV = normalizeVec3(crossVec3(direction, axisU), [0, 0, 1]);
    }

    const spread = area.spread === undefined ? Math.PI : Math.max(1e-4, Math.min(Math.PI, Number(area.spread)));
    let tanHalfSpread = 0;
    let spreadNormalization = 0;
    if (spread < Math.PI - 1e-5) {
      const halfSpread = 0.5 * spread;
      tanHalfSpread = Math.tan(halfSpread);
      spreadNormalization = 1 / Math.max(1e-8, tanHalfSpread - halfSpread);
    }

    let flags = LIGHT_FLAG_NORMALIZE;
    if (area.cyclesCastShadow !== false) {
      flags |= LIGHT_FLAG_CAST_SHADOW;
    }
    if (spread > 0 && area.multipleImportance !== false) {
      flags |= LIGHT_FLAG_MULTIPLE_IMPORTANCE;
    }
    if (area.cameraVisible === true) {
      flags |= LIGHT_FLAG_CAMERA_VISIBLE;
    }
    if (area.portal === true) {
      flags |= LIGHT_FLAG_PORTAL;
    }
    const masks = lightBitMaskWords(area.bit, area.lightGroupMaskLo, area.lightGroupMaskHi);
    const weight = Math.max(1e-6, Math.PI * luminance(color) * intensity);
    records.push({
      position: [Number(area.position[0]), Number(area.position[1]), Number(area.position[2])],
      lightType: isDisk ? LIGHT_TYPE_AREA_DISK : LIGHT_TYPE_AREA_RECT,
      radiance,
      flags,
      direction,
      radius: 0,
      axisU,
      sizeU: width,
      axisV,
      sizeV: height,
      cosHalfAngle: 0,
      spotBlend: 0,
      tanHalfSpread,
      spreadNormalization,
      areaOrSolidAngle: surfaceArea,
      maxDistance: area.range > 0 ? Number(area.range) : 1e30,
      masks,
      weight,
      isDistant: false,
    });
  }

  return records;
}

function packAnalyticLightsBuffer(entries) {
  const count = entries.length;
  const buffer = new Uint8Array(Math.max(1, count) * STRUCT_STRIDES_V2.light);
  if (count === 0) {
    return { lights: buffer, lightCount: 0, analyticLightTotalWeight: 0, boundsMin: null, boundsMax: null, maskOr: 0, hasDistant: false };
  }
  let totalWeight = 0;
  for (const entry of entries) {
    totalWeight += entry.weight;
  }
  const boundsMin = [Infinity, Infinity, Infinity];
  const boundsMax = [-Infinity, -Infinity, -Infinity];
  let maskOr = 0;
  let hasDistant = false;
  let cumulative = 0;

  for (let index = 0; index < count; index++) {
    const entry = entries[index];
    const pdf = entry.weight / totalWeight;
    cumulative += pdf;
    const cdfUpper = index === count - 1 ? 1.0 : Math.min(1.0, cumulative);

    const baseByte = index * STRUCT_STRIDES_V2.light;
    const f32 = new Float32Array(buffer.buffer, baseByte, 32);
    const u32 = new Uint32Array(buffer.buffer, baseByte, 32);
    const i32 = new Int32Array(buffer.buffer, baseByte, 32);

    f32[0] = entry.position[0];
    f32[1] = entry.position[1];
    f32[2] = entry.position[2];
    u32[3] = entry.lightType >>> 0;

    f32[4] = entry.radiance[0];
    f32[5] = entry.radiance[1];
    f32[6] = entry.radiance[2];
    u32[7] = entry.flags >>> 0;

    f32[8] = entry.direction[0];
    f32[9] = entry.direction[1];
    f32[10] = entry.direction[2];
    f32[11] = entry.radius;

    f32[12] = entry.axisU[0];
    f32[13] = entry.axisU[1];
    f32[14] = entry.axisU[2];
    f32[15] = entry.sizeU;

    f32[16] = entry.axisV[0];
    f32[17] = entry.axisV[1];
    f32[18] = entry.axisV[2];
    f32[19] = entry.sizeV;

    f32[20] = entry.cosHalfAngle;
    f32[21] = entry.spotBlend;
    f32[22] = entry.tanHalfSpread;
    f32[23] = entry.spreadNormalization;

    f32[24] = entry.areaOrSolidAngle;
    f32[25] = entry.maxDistance;
    i32[26] = -1;
    u32[27] = 0;

    f32[28] = pdf;
    f32[29] = cdfUpper;
    u32[30] = entry.masks.lo >>> 0;
    u32[31] = entry.masks.hi >>> 0;

    maskOr = (maskOr | entry.masks.lo) >>> 0;
    if (entry.isDistant) {
      hasDistant = true;
    } else {
      const extent = Math.max(entry.radius, 0.5 * Math.hypot(entry.sizeU, entry.sizeV));
      for (let axis = 0; axis < 3; axis++) {
        boundsMin[axis] = Math.min(boundsMin[axis], entry.position[axis] - extent);
        boundsMax[axis] = Math.max(boundsMax[axis], entry.position[axis] + extent);
      }
    }
  }

  return {
    lights: buffer,
    lightCount: count,
    analyticLightTotalWeight: totalWeight,
    boundsMin: boundsMin[0] <= boundsMax[0] ? boundsMin : null,
    boundsMax: boundsMin[0] <= boundsMax[0] ? boundsMax : null,
    maskOr,
    hasDistant,
  };
}

// Builds the Cycles light tree over the packed lights and emissive triangles (light-tree-v2.mjs) and records the
// owning leaf of every analytic light in its `tree_leaf_index` field.
function packLightTree(packedLights, packedEmissives) {
  const tree = buildLightTree(
    packedLights.lights,
    packedLights.lightCount,
    packedEmissives.emissiveTriangles,
    packedEmissives.emissiveTriangleCount
  );
  const lightWords = new Uint32Array(packedLights.lights.buffer, packedLights.lights.byteOffset, packedLights.lights.byteLength / 4);
  const wordsPerLight = STRUCT_STRIDES_V2.light / 4;
  for (let index = 0; index < packedLights.lightCount; index++) {
    lightWords[index * wordsPerLight + 27] = tree.lightLeafIndices[index];
  }
  return {
    lightTreeNodes: tree.nodes,
    lightTreeNodeCount: tree.nodeCount,
    lightTreeEmitters: tree.emitters,
    lightTreeEmitterCount: tree.emitterCount,
    lightToTree: tree.lightToTree,
  };
}

/**
 * Reads the `envCompensation` option: `undefined`, `false` or `0` (off, the default), `true` (the full mean) or a
 * fraction in (0, 1] of the mean radiance to subtract from the sampling table. Returns the fraction, 0 when off.
 */
export function resolveEnvCompensationFraction(envCompensation, callerName) {
  if (envCompensation === undefined || envCompensation === false) {
    return 0;
  }
  if (envCompensation === true) {
    return 1;
  }
  if (typeof envCompensation !== 'number' || !Number.isFinite(envCompensation) || envCompensation < 0 || envCompensation > 1) {
    throw new RangeError(
      `${callerName}: \`envCompensation\` must be true, false or a number from 0 to 1 (the fraction of the mean radiance to subtract), got ${JSON.stringify(envCompensation)}.`
    );
  }
  return envCompensation;
}

const MINIMUM_COMPENSATED_TABLE_FRACTION = 1e-6;

/**
 * MIS compensation of the environment sampling table (Karlik et al. 2019; pbrt-v4 ImageInfiniteLight, Apache-2.0).
 * Subtracts `fraction` times the sphere-mean radiance from every texel's weight and clamps at zero, so light sampling
 * spends its samples where BSDF sampling does badly. The kernel reads the pdf from the same table, so the pdf used in
 * MIS stays the pdf that was sampled. A map that would end up all zero, or nearly so, keeps its original table.
 * Rewrites `pixelWeights` and `rowTotals` in place and returns the new total.
 */
function compensateEnvironmentWeights(pixelWeights, rowTotals, width, height, fraction, originalTotal) {
  const deltaPhi = (2 * Math.PI) / width;
  const deltaTheta = Math.PI / height;
  let solidAngleSum = 0;
  for (let y = 0; y < height; y++) {
    solidAngleSum += Math.sin(Math.PI * (y + 0.5) / height) * deltaPhi * deltaTheta * width;
  }
  const meanRadiance = originalTotal / solidAngleSum;

  const compensatedWeights = new Float64Array(pixelWeights.length);
  const compensatedRowTotals = new Float64Array(height);
  let compensatedTotal = 0;
  for (let y = 0; y < height; y++) {
    const texelSolidAngle = Math.sin(Math.PI * (y + 0.5) / height) * deltaPhi * deltaTheta;
    const subtractedWeight = fraction * meanRadiance * texelSolidAngle;
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      const weight = Math.max(0, pixelWeights[pixelIndex] - subtractedWeight);
      compensatedWeights[pixelIndex] = weight;
      rowSum += weight;
    }
    compensatedRowTotals[y] = rowSum;
    compensatedTotal += rowSum;
  }
  // A constant map leaves only rounding residue (about 1e-16 of the total) after the subtraction, and a table built
  // from that residue would sample an arbitrary patch of the sky, so anything this small counts as all zero.
  if (!(compensatedTotal > originalTotal * MINIMUM_COMPENSATED_TABLE_FRACTION)) {
    return originalTotal;
  }
  pixelWeights.set(compensatedWeights);
  rowTotals.set(compensatedRowTotals);
  return compensatedTotal;
}

function packEnvironmentTexelsV2(environment, options = {}) {
  if (!environment || !(environment.width > 0 && environment.height > 0)) {
    const bg = options.backgroundColor ?? [0, 0, 0];
    return {
      environmentTexels: new Float32Array(4),
      envWidth: 0,
      envHeight: 0,
      envCdfOffset: 0,
      envRotation: 0,
      envColor: [Number(bg[0]), Number(bg[1]), Number(bg[2])],
      envTotalWeight: 0,
    };
  }

  const width = Math.round(environment.width);
  const height = Math.round(environment.height);
  const channels = Math.max(3, Math.round(environment.channels ?? 3));
  const source = environment.data;
  const intensity = Number(environment.intensity ?? 1);
  const radianceLimit = options.hdriRadianceLimit === undefined
    ? DEFAULT_HDRI_RADIANCE_LIMIT
    : Number(options.hdriRadianceLimit);
  const envRotation = environment.rotation !== undefined
    ? Number(environment.rotation)
    : Math.atan2(Number(environment.sine ?? 0), Number(environment.cosine ?? 1));

  const compensationFraction = resolveEnvCompensationFraction(options.envCompensation, 'buildNativeInputV2');
  const pixelCount = width * height;
  const totalVec4 = 2 * pixelCount + height;
  const texels = new Float32Array(totalVec4 * 4);
  const rowTotals = new Float64Array(height);
  const pixelWeights = new Float64Array(pixelCount);
  const deltaPhi = (2 * Math.PI) / width;
  const deltaTheta = Math.PI / height;
  let totalWeight = 0;

  for (let y = 0; y < height; y++) {
    const sinTheta = Math.sin(Math.PI * (y + 0.5) / height);
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      const srcBase = pixelIndex * channels;
      const r = Math.min(radianceLimit, Math.max(0, Number(source[srcBase])));
      const g = Math.min(radianceLimit, Math.max(0, Number(source[srcBase + 1])));
      const b = Math.min(radianceLimit, Math.max(0, Number(source[srcBase + 2])));
      const dstBase = pixelIndex * 4;
      texels[dstBase] = r;
      texels[dstBase + 1] = g;
      texels[dstBase + 2] = b;
      texels[dstBase + 3] = 1.0;

      const weight = (0.2126 * r + 0.7152 * g + 0.0722 * b) * intensity * sinTheta * deltaPhi * deltaTheta;
      pixelWeights[pixelIndex] = weight;
      rowSum += weight;
    }
    rowTotals[y] = rowSum;
    totalWeight += rowSum;
  }

  if (compensationFraction > 0) {
    totalWeight = compensateEnvironmentWeights(pixelWeights, rowTotals, width, height, compensationFraction, totalWeight);
  }

  const envCdfOffset = pixelCount;
  let marginalRunning = 0;
  for (let y = 0; y < height; y++) {
    const marginalProb = totalWeight > 0 ? rowTotals[y] / totalWeight : 1 / height;
    marginalRunning += marginalProb;
    const marginalBase = (envCdfOffset + y) * 4;
    texels[marginalBase] = y === height - 1 ? 1.0 : Math.min(1.0, marginalRunning);
    texels[marginalBase + 1] = marginalProb;
    texels[marginalBase + 2] = 0.0;
    texels[marginalBase + 3] = 0.0;

    const rowTotal = rowTotals[y];
    let condRunning = 0;
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      const condProb = rowTotal > 0 ? pixelWeights[pixelIndex] / rowTotal : 1 / width;
      condRunning += condProb;
      const condBase = (envCdfOffset + height + pixelIndex) * 4;
      texels[condBase] = x === width - 1 ? 1.0 : Math.min(1.0, condRunning);
      texels[condBase + 1] = condProb;
      texels[condBase + 2] = 0.0;
      texels[condBase + 3] = 0.0;
    }
  }

  const envColor = options.envColor ?? [intensity, intensity, intensity];
  return {
    environmentTexels: texels,
    envWidth: width,
    envHeight: height,
    envCdfOffset,
    envRotation,
    envColor: [Number(envColor[0]), Number(envColor[1]), Number(envColor[2])],
    envTotalWeight: totalWeight,
  };
}

// The accumulation buffer holds 64 bytes per pixel and the device caps one storage buffer at 1 GiB.
export const MAX_TRACE_PIXELS = 2 ** 24;
// The most path samples (pixels times samplesPerDispatch) one dispatch may hold; it equals what the automatic batch picks at
// the largest image (16 samples of 4096 x 4096), so a dispatch finishes well inside the GPU watchdog time.
export const MAX_PATH_SAMPLES_PER_DISPATCH = 2 ** 28;

function requireNumberType(value, name, callerName) {
  if (typeof value !== 'number') {
    const received = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    throw new TypeError(`${callerName}: \`${name}\` must be a number; got ${received}. Pass a number, not a string, boolean or array.`);
  }
}

/** Rejects a `maxSeconds` that is not a finite number greater than zero; `undefined` means no time limit. */
export function validateMaxSeconds(maxSeconds, callerName) {
  if (maxSeconds === undefined) {
    return;
  }
  requireNumberType(maxSeconds, 'maxSeconds', callerName);
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
    throw new RangeError(`${callerName}: \`maxSeconds\` must be a finite number greater than 0; got ${maxSeconds}.`);
  }
}

/** Rejects an image whose accumulation buffer would not fit one storage buffer on the device. */
export function validateImagePixelCount(width, height, callerName) {
  if (width * height > MAX_TRACE_PIXELS) {
    throw new RangeError(
      `${callerName}: \`width\` times \`height\` must be at most ${MAX_TRACE_PIXELS} pixels (4096 x 4096) so the accumulation buffer fits the device limit; got ${width} x ${height} = ${width * height}. Lower the resolution.`
    );
  }
}

/** Rejects a dispatch of `samplesPerDispatch` samples over `width * height` pixels that is too long for one GPU submission. */
export function validateDispatchSize(width, height, samplesPerDispatch, callerName) {
  if (width * height * samplesPerDispatch > MAX_PATH_SAMPLES_PER_DISPATCH) {
    const largestAllowed = Math.max(1, Math.floor(MAX_PATH_SAMPLES_PER_DISPATCH / (width * height)));
    throw new RangeError(
      `${callerName}: \`samplesPerDispatch\` times \`width\` times \`height\` must be at most ${MAX_PATH_SAMPLES_PER_DISPATCH} path samples per dispatch; got ${samplesPerDispatch} x ${width} x ${height} = ${samplesPerDispatch * width * height}. Pass \`samplesPerDispatch\` of ${largestAllowed} or less.`
    );
  }
}

function requireFiniteIntegerInRange(value, name, min, max, callerName) {
  requireNumberType(value, name, callerName);
  const n = value;
  if (!Number.isFinite(n)) {
    throw new RangeError(
      `${callerName}: \`${name}\` must be a finite integer in [${min}, ${max}]; got ${value === null ? 'null' : JSON.stringify(value)}.`
    );
  }
  if (!Number.isInteger(n)) {
    throw new RangeError(
      `${callerName}: \`${name}\` must be an integer (no fractional part); got ${value}.`
    );
  }
  if (n < min || n > max) {
    throw new RangeError(
      `${callerName}: \`${name}\` must be in [${min}, ${max}]; got ${n}.`
    );
  }
}

function requireFiniteIntegerInRangeIfPresent(value, name, min, max, callerName) {
  if (value === undefined) {
    return;
  }
  requireFiniteIntegerInRange(value, name, min, max, callerName);
}

/**
 * Validates public boundary options for `buildNativeInputV2`, `upgradeNativeInputV1ToV2`, and
 * `traceNative`. Throws `RangeError` or `TypeError` with a descriptive message on failure.
 */
/** Throws unless `sampler` is undefined, "sobol-burley" (the Cycles default pattern) or "white" (the PCG hash). */
export function validateSamplerOption(sampler, callerName) {
  if (sampler !== undefined && !VALID_SAMPLERS.includes(sampler)) {
    throw new RangeError(
      `${callerName}: \`sampler\` must be "sobol-burley" (default) or "white", got ${JSON.stringify(sampler)}.`
    );
  }
}

/** Throws unless `denoise` is undefined, "none" or "atrous". */
export function validateDenoiseOption(denoise, callerName) {
  if (denoise !== undefined && denoise !== 'none' && denoise !== 'atrous') {
    throw new RangeError(
      `${callerName}: \`denoise\` must be "none" (default) or "atrous", got ${JSON.stringify(denoise)}.`
    );
  }
}

/** Throws unless `lightSampling` is undefined, "auto", "tree" or "uniform". */
export function validateLightSamplingOption(lightSampling, callerName) {
  if (lightSampling !== undefined && !VALID_LIGHT_SAMPLING.includes(lightSampling)) {
    throw new RangeError(
      `${callerName}: \`lightSampling\` must be "auto" (default), "tree" or "uniform", got ${JSON.stringify(lightSampling)}.`
    );
  }
}

/**
 * Reads the sampler and light-selection options, including the earlier names `sampler: 'pcg'` (same as `'white'`),
 * `sampler: 'sobol'` (same as `'sobol-burley'`) and `useLightTree: true|false` (same as `lightSampling: 'tree'|'uniform'`).
 * Returns `{ sampler, lightSampling }` with the canonical names, or `undefined` for an option that was left out.
 * Throws when a name is unknown or when an alias and its canonical option disagree.
 */
export function resolveSamplingOptions(options, callerName) {
  const samplerAliases = { pcg: 'white', sobol: 'sobol-burley' };
  let sampler = options.sampler;
  if (typeof sampler === 'string' && Object.hasOwn(samplerAliases, sampler)) {
    sampler = samplerAliases[sampler];
  }
  validateSamplerOption(sampler, callerName);

  let lightSampling = options.lightSampling;
  validateLightSamplingOption(lightSampling, callerName);
  if (options.useLightTree !== undefined) {
    if (typeof options.useLightTree !== 'boolean') {
      throw new TypeError(
        `${callerName}: \`useLightTree\` must be true, false or left out for automatic, got ${JSON.stringify(options.useLightTree)}.`
      );
    }
    const aliasedLightSampling = options.useLightTree ? 'tree' : 'uniform';
    if (lightSampling !== undefined && lightSampling !== aliasedLightSampling) {
      throw new RangeError(
        `${callerName}: \`useLightTree: ${options.useLightTree}\` means \`lightSampling: "${aliasedLightSampling}"\`, which disagrees with \`lightSampling: "${lightSampling}"\`. Pass only one of them.`
      );
    }
    lightSampling = aliasedLightSampling;
  }
  return { sampler, lightSampling };
}

/** Throws unless `pathRegeneration` is undefined, true or false. */
export function validatePathRegenerationOption(pathRegeneration, callerName) {
  if (pathRegeneration !== undefined && typeof pathRegeneration !== 'boolean') {
    throw new TypeError(
      `${callerName}: \`pathRegeneration\` must be true, false or left out (the "cycles" kernel defaults to true), got ${JSON.stringify(pathRegeneration)}.`
    );
  }
}

/** True when the kernel should pick lights through the light tree for this scene and mode. */
export function resolveUseLightTree(lightSampling, emitterCount, lightTreeNodeCount) {
  if (lightTreeNodeCount <= 0 || lightSampling === 'uniform') {
    return false;
  }
  if (lightSampling === 'tree') {
    return emitterCount > 0;
  }
  return emitterCount > LIGHT_TREE_AUTO_MIN_EMITTERS;
}

export function validatePackOptions(options, callerName, requireDimensionsAndSamples = false) {
  if (!options || typeof options !== 'object') {
    throw new TypeError(`${callerName}: \`options\` must be an object.`);
  }
  const { width, height, samples, samplesPerDispatch } = options;
  if (requireDimensionsAndSamples || width !== undefined) {
    requireFiniteIntegerInRange(width, 'width', 1, 16384, callerName);
  }
  if (requireDimensionsAndSamples || height !== undefined) {
    requireFiniteIntegerInRange(height, 'height', 1, 16384, callerName);
  }
  if (requireDimensionsAndSamples || samples !== undefined) {
    requireFiniteIntegerInRange(samples, 'samples', 1, 1048576, callerName);
  }
  // samplesPerDispatch is optional (undefined means "let the addon choose"); only validate when provided.
  requireFiniteIntegerInRangeIfPresent(samplesPerDispatch, 'samplesPerDispatch', 1, 65536, callerName);
  validateMaxSeconds(options.maxSeconds, callerName);
  resolveSamplingOptions(options, callerName);
  resolveEnvCompensationFraction(options.envCompensation, callerName);
  validateDenoiseOption(options.denoise, callerName);
  validateTextureMipsOption(options.textureMips, 'textureMips', callerName);
  validateFilterOptions(options, callerName);
  if (width !== undefined && height !== undefined) {
    validateImagePixelCount(width, height, callerName);
    if (samplesPerDispatch !== undefined) {
      validateDispatchSize(width, height, samplesPerDispatch, callerName);
    }
  }

  // Bounce limits — each is optional; when provided must be a finite integer in [0, 1024].
  const bounceFields = [
    'bounces', 'maxBounces',
    'diffuseBounces', 'maxDiffuseBounces',
    'glossyBounces', 'maxGlossyBounces',
    'transmissionBounces', 'maxTransmissionBounces',
    'volumeBounces', 'maxVolumeBounces',
    'transparentBounces', 'maxTransparentBounces',
    'minBounceRr',
  ];
  for (const field of bounceFields) {
    if (options[field] !== undefined) {
      requireFiniteIntegerInRange(options[field], field, 0, 1024, callerName);
    }
  }
}

export const MAX_APERTURE_BLADES = 64;

/** The thin lens a v1 params block carries (see THIN_LENS_FLOAT_INDEXES in pack-input.mjs); nothing for a pinhole, so its bytes stay as they were. */
function readV1ThinLens(paramF32) {
  if (!(paramF32[THIN_LENS_FLOAT_INDEXES.apertureRadius] > 0)) {
    return {};
  }
  return Object.fromEntries(Object.entries(THIN_LENS_FLOAT_INDEXES).map(([fieldName, floatIndex]) => [fieldName, paramF32[floatIndex]]));
}
const DEFAULT_FOCAL_DISTANCE = 10;

function requireThinLensNumber(value, name, callerName, isValid, expectation) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !isValid(value)) {
    throw new RangeError(`${callerName}: camera \`${name}\` must be ${expectation}, got ${JSON.stringify(value)}.`);
  }
}

/**
 * The thin lens of a camera, from the camera object (as `createCamera` returns it for a camera with an `fStop`) or from the
 * same names in `options`: `apertureRadius` (scene units, 0 is a pinhole), `focalDistance` (along the view axis),
 * `apertureBlades` (0 for a round aperture, else 3 to 64) and `apertureRotation` (radians). A pinhole keeps the defaults
 * the params block always held, so its bytes do not change. Throws a RangeError that says what to pass.
 */
export function resolveThinLensParameters(camera, options, callerName) {
  const apertureRadius = camera?.apertureRadius ?? options.apertureRadius ?? 0;
  requireThinLensNumber(apertureRadius, 'apertureRadius', callerName, value => value >= 0,
    'a number of scene units, 0 or more (0 is a pinhole; fStop 2.8 on a 50 mm lens is 0.00893)');
  const focalDistance = camera?.focalDistance ?? options.focalDistance ?? DEFAULT_FOCAL_DISTANCE;
  requireThinLensNumber(focalDistance, 'focalDistance', callerName, value => value > 0,
    'a distance along the view axis above 0, such as the eye-to-target distance');
  const apertureBlades = camera?.apertureBlades ?? options.apertureBlades ?? 0;
  requireThinLensNumber(apertureBlades, 'apertureBlades', callerName,
    value => Number.isInteger(value) && (value === 0 || (value >= 3 && value <= MAX_APERTURE_BLADES)),
    `0 for a round aperture or a whole number from 3 to ${MAX_APERTURE_BLADES}`);
  const apertureRotation = camera?.apertureRotation ?? options.apertureRotation ?? 0;
  requireThinLensNumber(apertureRotation, 'apertureRotation', callerName, () => true, 'a finite number of radians');
  return { apertureRadius, focalDistance, apertureBlades, apertureRotation };
}

function effectiveCyclesClamp(value) {
  if (value === undefined || value === null) {
    return 0.0;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 1e29) {
    return 0.0;
  }
  return numeric * 3.0;
}

const FILTER_TYPE_CODES = Object.freeze({
  box: 0,
  gaussian: 1,
  'blackman-harris': 2,
  blackman_harris: 2,
});

export function filterTypeCode(filter) {
  if (filter === 0 || filter === 1 || filter === 2) {
    return filter;
  }
  return typeof filter === 'string' ? FILTER_TYPE_CODES[filter] : undefined;
}

/** Throws unless `filterType` (or `pixelFilter`) and `filterWidth` are absent or valid. Width is in pixels, 0.01 to 16. */
export function validateFilterOptions(options, callerName) {
  const filter = options.filterType !== undefined ? options.filterType : options.pixelFilter;
  if (filter !== undefined && filterTypeCode(filter) === undefined) {
    throw new RangeError(
      `${callerName}: \`filterType\` must be "box" (default), "gaussian" or "blackman-harris", got ${JSON.stringify(filter)}.`
    );
  }
  const width = options.filterWidth;
  if (width !== undefined && !(typeof width === 'number' && Number.isFinite(width) && width >= 0.01 && width <= 16)) {
    throw new RangeError(
      `${callerName}: \`filterWidth\` must be a number of pixels from 0.01 to 16 (1.5 is the Cycles Blackman-Harris default), got ${JSON.stringify(width)}.`
    );
  }
}

export function resolveFilterParameters(options = {}) {
  const filterType = filterTypeCode(options.filterType ?? options.pixelFilter ?? 0) ?? 0;
  const defaultWidth = filterType === 0 ? 1.0 : 1.5;
  const filterWidth = options.filterWidth ?? defaultWidth;
  return { filterType, filterWidth };
}

function packKernelParamsV2({
  camera,
  options,
  counts,
  packedEnvironment,
  volume,
  usesSubsurface,
  emissiveTotalWeight,
  analyticLightTotalWeight,
  rayEpsilon,
  farDistance,
}) {
  const buffer = new ArrayBuffer(STRUCT_STRIDES_V2.kernelParams);
  const f32 = new Float32Array(buffer);
  const u32 = new Uint32Array(buffer);

  const width = Math.max(1, Math.round(Number(options.width ?? 1)));
  const height = Math.max(1, Math.round(Number(options.height ?? 1)));
  const totalSamples = Math.max(1, Math.round(Number(options.samples ?? 1)));
  const samplesPerDispatch = Math.max(1, Math.round(Number(options.samplesPerDispatch ?? 1)));
  const seed = (options.seed ?? 0) >>> 0;
  const adaptiveThreshold = Math.max(0, Number(options.noiseThreshold ?? options.adaptiveThreshold ?? 0));
  const volumeDensity = Math.max(0, Number(volume?.density ?? 0));

  let kernelFlags = 0;
  const { sampler, lightSampling } = resolveSamplingOptions(options, 'packKernelParamsV2');
  if (options.directLighting !== undefined && !VALID_DIRECT_LIGHTING.includes(options.directLighting)) {
    throw new RangeError(`packKernelParamsV2: \`directLighting\` must be "both", "nee-only" or "bsdf-only", got ${JSON.stringify(options.directLighting)}.`);
  }
  if (options.directLighting === 'nee-only') {
    kernelFlags |= KERNEL_FLAG_TEST_NEE_ONLY;
  } else if (options.directLighting === 'bsdf-only') {
    kernelFlags |= KERNEL_FLAG_TEST_BSDF_ONLY;
  }
  if (options.lightTreeProbe === true) {
    kernelFlags |= KERNEL_FLAG_LIGHT_TREE_PROBE;
  }
  const emitterCount = counts.lightCount + counts.emissiveTriangleCount;
  if (resolveUseLightTree(lightSampling, emitterCount, counts.lightTreeNodeCount)) {
    kernelFlags |= KERNEL_FLAG_USE_LIGHT_TREE;
  }
  if (volumeDensity > 0) {
    kernelFlags |= KERNEL_FLAG_HAS_VOLUME;
  }
  if (usesSubsurface) {
    kernelFlags |= KERNEL_FLAG_HAS_SUBSURFACE;
  }
  if (camera?.orthographic === true || options.orthographic === true) {
    kernelFlags |= KERNEL_FLAG_ORTHOGRAPHIC_CAMERA;
  }
  if (adaptiveThreshold > 0) {
    kernelFlags |= KERNEL_FLAG_ADAPTIVE_SAMPLING;
  }
  if (options.transparentBackground === true) {
    kernelFlags |= KERNEL_FLAG_TRANSPARENT_BACKGROUND;
  }
  if (sampler === 'white') {
    kernelFlags |= KERNEL_FLAG_WHITE_NOISE_SAMPLER;
  }
  if (counts.usesTextureMips === true) {
    kernelFlags |= KERNEL_FLAG_TEXTURE_MIPS;
  }

  const maxBounces = Math.max(0, Math.round(Number(options.bounces ?? options.maxBounces ?? 8)));
  const maxDiffuseBounces = Math.max(0, Math.round(Number(options.diffuseBounces ?? maxBounces)));
  const maxGlossyBounces = Math.max(0, Math.round(Number(options.glossyBounces ?? maxBounces)));
  const maxTransmissionBounces = Math.max(0, Math.round(Number(options.transmissionBounces ?? maxBounces)));
  const maxVolumeBounces = Math.max(0, Math.round(Number(options.volumeBounces ?? maxBounces)));
  const maxTransparentBounces = Math.max(0, Math.round(Number(options.transparentBounces ?? Math.max(maxBounces, 8))));
  const minBounceRr = Math.max(0, Math.round(Number(options.minBounceRr ?? 3)));
  const { filterType, filterWidth } = resolveFilterParameters(options);

  const eye = camera?.eye ?? camera?.position ?? [0, 0, 0];
  const forward = normalizeVec3(camera?.forward ?? [0, 0, -1], [0, 0, -1]);
  const halfWidth = Number(camera?.halfWidth ?? 1);
  const halfHeight = Number(camera?.halfHeight ?? 1);
  const rawRight = camera?.right ?? [1, 0, 0];
  const rawUp = camera?.above ?? camera?.up ?? [0, 1, 0];
  const scaledRight = camera?.scaledAxes
    ? [Number(rawRight[0]), Number(rawRight[1]), Number(rawRight[2])]
    : [Number(rawRight[0]) * halfWidth, Number(rawRight[1]) * halfWidth, Number(rawRight[2]) * halfWidth];
  const scaledUp = camera?.scaledAxes
    ? [Number(rawUp[0]), Number(rawUp[1]), Number(rawUp[2])]
    : [Number(rawUp[0]) * halfHeight, Number(rawUp[1]) * halfHeight, Number(rawUp[2]) * halfHeight];

  const cameraNear = Math.max(0, Number(options.near ?? camera?.near ?? 0));
  const cameraFar = Math.max(cameraNear + 1e-3, Number(options.far ?? camera?.far ?? farDistance ?? 1e30));
  const lensShift = camera?.lensShift ?? options.lensShift ?? [0, 0];
  const thinLens = resolveThinLensParameters(camera, options, 'buildNativeInputV2');

  u32[0] = FORMAT_V2_MAGIC;
  u32[1] = FORMAT_V2_VERSION;
  u32[2] = width >>> 0;
  u32[3] = height >>> 0;

  u32[4] = (options.sampleOffset ?? 0) >>> 0;
  u32[5] = samplesPerDispatch >>> 0;
  u32[6] = totalSamples >>> 0;
  u32[7] = seed;

  u32[8] = kernelFlags >>> 0;
  f32[9] = adaptiveThreshold;
  f32[10] = effectiveCyclesClamp(options.clampDirect);
  f32[11] = effectiveCyclesClamp(options.clampIndirect);

  u32[12] = maxBounces >>> 0;
  u32[13] = maxDiffuseBounces >>> 0;
  u32[14] = maxGlossyBounces >>> 0;
  u32[15] = maxTransmissionBounces >>> 0;

  u32[16] = maxVolumeBounces >>> 0;
  u32[17] = maxTransparentBounces >>> 0;
  u32[18] = minBounceRr >>> 0;
  u32[KERNEL_PARAMS_V2_FILTER_TYPE_BYTE_OFFSET / 4] = filterType >>> 0;

  f32[KERNEL_PARAMS_V2_FILTER_WIDTH_BYTE_OFFSET / 4] = filterWidth;
  u32[21] = counts.instanceCount >>> 0;
  u32[22] = counts.triangleCount >>> 0;
  u32[23] = counts.materialCount >>> 0;

  u32[24] = counts.emissiveTriangleCount >>> 0;
  u32[25] = counts.lightCount >>> 0;
  u32[26] = counts.lightTreeNodeCount >>> 0;
  u32[27] = counts.textureCount >>> 0;

  f32[28] = Number(eye[0]);
  f32[29] = Number(eye[1]);
  f32[30] = Number(eye[2]);
  f32[31] = cameraNear;

  f32[32] = forward[0];
  f32[33] = forward[1];
  f32[34] = forward[2];
  f32[35] = cameraFar;

  f32[36] = scaledRight[0];
  f32[37] = scaledRight[1];
  f32[38] = scaledRight[2];
  f32[39] = thinLens.apertureRadius;

  f32[40] = scaledUp[0];
  f32[41] = scaledUp[1];
  f32[42] = scaledUp[2];
  f32[43] = thinLens.focalDistance;

  f32[44] = Number(lensShift[0] ?? 0);
  f32[45] = Number(lensShift[1] ?? 0);
  u32[46] = thinLens.apertureBlades >>> 0;
  f32[47] = thinLens.apertureRotation;

  u32[48] = packedEnvironment.envWidth >>> 0;
  u32[49] = packedEnvironment.envHeight >>> 0;
  u32[50] = packedEnvironment.envCdfOffset >>> 0;
  f32[51] = packedEnvironment.envRotation;

  f32[52] = packedEnvironment.envColor[0];
  f32[53] = packedEnvironment.envColor[1];
  f32[54] = packedEnvironment.envColor[2];
  f32[55] = packedEnvironment.envTotalWeight;

  const volMin = volume?.minimum ?? [0, 0, 0];
  const volMax = volume?.maximum ?? [0, 0, 0];
  const volAlbedo = volume?.albedo ?? [1, 1, 1];
  f32[56] = Number(volMin[0]);
  f32[57] = Number(volMin[1]);
  f32[58] = Number(volMin[2]);
  f32[59] = volumeDensity;

  f32[60] = Number(volMax[0]);
  f32[61] = Number(volMax[1]);
  f32[62] = Number(volMax[2]);
  f32[63] = Math.max(-0.99, Math.min(0.99, Number(volume?.anisotropy ?? 0)));

  f32[64] = Number(volAlbedo[0]);
  f32[65] = Number(volAlbedo[1]);
  f32[66] = Number(volAlbedo[2]);
  f32[67] = emissiveTotalWeight;

  f32[68] = analyticLightTotalWeight;
  f32[69] = rayEpsilon > 0 ? rayEpsilon : 1e-4;
  u32[70] = Math.max(1, Math.round(Number(options.adaptiveMinSamples ?? 16))) >>> 0;
  u32[71] = 0;

  const rawFilterGlossy = Number(options.filterGlossy ?? options.blurGlossy ?? 1.0);
  const filterGlossy = Number.isFinite(rawFilterGlossy) && rawFilterGlossy > 0 ? rawFilterGlossy : 0.0;

  f32[72] = Number(options.exposure ?? 1.0);
  f32[73] = packedEnvironment.envWidth > 0 && packedEnvironment.envTotalWeight > 0 ? 1.0 : 0.0;
  u32[74] = 0;
  // KERNEL_PARAMS_V2_FILTER_GLOSSY_BYTE_OFFSET / 4 = 75
  f32[KERNEL_PARAMS_V2_FILTER_GLOSSY_BYTE_OFFSET / 4] = filterGlossy;

  u32[76] = 0;
  u32[77] = 0;
  u32[78] = 0;
  u32[79] = 0;

  return new Uint8Array(buffer);
}

function buildGeometryTriangleItem(geometry, triIndex, defaultMaterialIndex, meshId, materialRecords) {
  const { positions, normals, uvs, uv1s, colors, tangents, indices, triangleMaterial } = geometry;
  const i0 = indices[triIndex * 3];
  const i1 = indices[triIndex * 3 + 1];
  const i2 = indices[triIndex * 3 + 2];

  const p0 = [positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]];
  const p1 = [positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]];
  const p2 = [positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]];
  const edge1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const edge2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
  const geoNormal = normalizeVec3(crossVec3(edge1, edge2), [0, 1, 0]);

  const n0 = normals ? normalizeVec3([normals[i0 * 3], normals[i0 * 3 + 1], normals[i0 * 3 + 2]], geoNormal) : geoNormal;
  const n1 = normals ? normalizeVec3([normals[i1 * 3], normals[i1 * 3 + 1], normals[i1 * 3 + 2]], geoNormal) : geoNormal;
  const n2 = normals ? normalizeVec3([normals[i2 * 3], normals[i2 * 3 + 1], normals[i2 * 3 + 2]], geoNormal) : geoNormal;

  const uv0 = uvs ? [uvs[i0 * 2], uvs[i0 * 2 + 1]] : [0, 0];
  const uv1 = uvs ? [uvs[i1 * 2], uvs[i1 * 2 + 1]] : [0, 0];
  const uv2 = uvs ? [uvs[i2 * 2], uvs[i2 * 2 + 1]] : [0, 0];

  const c0 = colors ? [colors[i0 * 3], colors[i0 * 3 + 1], colors[i0 * 3 + 2]] : [1, 1, 1];
  const c1 = colors ? [colors[i1 * 3], colors[i1 * 3 + 1], colors[i1 * 3 + 2]] : [1, 1, 1];
  const c2 = colors ? [colors[i2 * 3], colors[i2 * 3 + 1], colors[i2 * 3 + 2]] : [1, 1, 1];

  const uvSet1_0 = uv1s ? [uv1s[i0 * 2], uv1s[i0 * 2 + 1]] : [0, 0];
  const uvSet1_1 = uv1s ? [uv1s[i1 * 2], uv1s[i1 * 2 + 1]] : [0, 0];
  const uvSet1_2 = uv1s ? [uv1s[i2 * 2], uv1s[i2 * 2 + 1]] : [0, 0];

  let t0;
  let t1;
  let t2;
  let tangentSign = 1.0;
  if (tangents && tangents.length >= (positions.length / 3) * 4) {
    t0 = normalizeVec3([tangents[i0 * 4], tangents[i0 * 4 + 1], tangents[i0 * 4 + 2]], [1, 0, 0]);
    t1 = normalizeVec3([tangents[i1 * 4], tangents[i1 * 4 + 1], tangents[i1 * 4 + 2]], [1, 0, 0]);
    t2 = normalizeVec3([tangents[i2 * 4], tangents[i2 * 4 + 1], tangents[i2 * 4 + 2]], [1, 0, 0]);
    tangentSign = tangents[i0 * 4 + 3] < 0 ? -1.0 : 1.0;
  } else {
    const computed = computeTriangleTangents(edge1, edge2, n0, n1, n2, uv0, uv1, uv2);
    t0 = computed.t0;
    t1 = computed.t1;
    t2 = computed.t2;
    tangentSign = computed.sign;
  }

  let flags = TRIANGLE_FLAG_SMOOTH_NORMALS | TRIANGLE_FLAG_HAS_TANGENTS | TRIANGLE_FLAG_DOUBLE_SIDED;
  if (colors) {
    flags |= TRIANGLE_FLAG_HAS_VERTEX_COLORS;
  }
  if (uv1s) {
    flags |= TRIANGLE_FLAG_HAS_UV1;
  }

  const materialIndex = triangleMaterial ? triangleMaterial[triIndex] : defaultMaterialIndex;
  const matInfo = materialRecords[materialIndex];
  const isOpaque = (matInfo?.alphaMode ?? ALPHA_MODE_OPAQUE) === ALPHA_MODE_OPAQUE;

  return {
    p0,
    edge1,
    edge2,
    n0,
    n1,
    n2,
    uv0,
    uv1,
    uv2,
    t0,
    t1,
    t2,
    tangentSign,
    c0,
    c1,
    c2,
    uvSet1_0,
    uvSet1_1,
    uvSet1_2,
    flags,
    materialIndex,
    meshId,
    primitiveId: triIndex,
    localEmissiveOffset: INVALID_INDEX_V2,
    isOpaque,
  };
}

function appendWorldEmissiveIfActive({
  emissiveList,
  triItem,
  globalTriangleIndex,
  instanceIndex,
  resolvedMaterialIndex,
  materialRecords,
  objectToWorld,
  negativeScale,
  lightGroupMaskLo,
  lightGroupMaskHi,
}) {
  const matInfo = materialRecords[resolvedMaterialIndex];
  if (!matInfo?.isEmissive) {
    return INVALID_INDEX_V2;
  }
  const worldP0 = transformPoint3x4(objectToWorld, triItem.p0);
  const worldEdge1 = transformDirection3x4(objectToWorld, triItem.edge1);
  const worldEdge2 = transformDirection3x4(objectToWorld, triItem.edge2);
  const cross = crossVec3(worldEdge1, worldEdge2);
  const crossLength = Math.hypot(cross[0], cross[1], cross[2]);
  const area = 0.5 * crossLength;
  if (!(area > 1e-12)) {
    return INVALID_INDEX_V2;
  }
  const normalSign = negativeScale ? -1 : 1;
  const geometricNormal = [
    (cross[0] / crossLength) * normalSign,
    (cross[1] / crossLength) * normalSign,
    (cross[2] / crossLength) * normalSign,
  ];
  const radiance = matInfo.meanEmissiveRadiance;
  const selectionWeight = luminance(radiance) * area;
  if (!(selectionWeight > 0)) {
    return INVALID_INDEX_V2;
  }
  const emittedIndex = emissiveList.length;
  emissiveList.push({
    p0: worldP0,
    area,
    edge1: worldEdge1,
    instanceIndex,
    edge2: worldEdge2,
    triangleIndex: globalTriangleIndex,
    geometricNormal,
    materialIndex: resolvedMaterialIndex,
    radiance,
    selectionWeight,
    lightGroupMaskLo,
    lightGroupMaskHi,
  });
  return emittedIndex;
}

// Triangle records are shared by every copy of a mesh, so one `local_emissive_offset` per triangle has to fit every instance that
// emits: the instance's entries are the triangles that kept an area, in order, whichever material the instance resolves to.
// The first emitting instance sets the offsets; a later one must emit the same triangles.
function shareEmissiveOffsets(meshSlot, emittedLocalIndices, instanceIndex) {
  if (emittedLocalIndices.length === 0) return;
  if (!meshSlot.emissiveLocalIndices) {
    meshSlot.emissiveLocalIndices = emittedLocalIndices;
    emittedLocalIndices.forEach((localIdx, offset) => {
      meshSlot.ordered[localIdx].localEmissiveOffset = offset;
    });
    return;
  }
  const reference = meshSlot.emissiveLocalIndices;
  const matches = reference.length === emittedLocalIndices.length && reference.every((localIdx, offset) => localIdx === emittedLocalIndices[offset]);
  if (!matches) {
    throw new RangeError(`Instance[${instanceIndex}] scales some emissive triangles of its shared mesh to no area, so its emissive entries differ from the other copies. Give it a scale that keeps every triangle, or remove its emissive material.`);
  }
}

function packInstancedGeometry(instancesInput, rawMaterials, textureCollector, reducedMaterials) {
  const materialRecords = reducedMaterials
    ? reducedMaterials.materialRecords
    : rawMaterials.map(mat => packMaterialRecordV2(mat, textureCollector));
  const materialsBuffer = new Uint8Array(Math.max(1, materialRecords.length) * STRUCT_STRIDES_V2.material);
  materialRecords.forEach((rec, index) => materialsBuffer.set(rec.bytes, index * STRUCT_STRIDES_V2.material));

  const forceNonOpaqueGeometries = new Set();
  const firstDefaultMatByGeo = new Map();
  for (let instIdx = 0; instIdx < instancesInput.length; instIdx++) {
    const inst = instancesInput[instIdx];
    const geometry = inst?.geometry;
    if (!geometry) continue;
    const defaultMat = Number(inst.materialIndex ?? 0);
    if (!firstDefaultMatByGeo.has(geometry)) {
      firstDefaultMatByGeo.set(geometry, defaultMat);
    }
    const overrideMat = inst.materialOverride !== undefined
      ? (inst.materialOverride >>> 0)
      : (!geometry.triangleMaterial && defaultMat !== firstDefaultMatByGeo.get(geometry) ? (defaultMat >>> 0) : INVALID_INDEX_V2);
    if (overrideMat !== INVALID_INDEX_V2) {
      const matAlphaMode = materialRecords[overrideMat]?.alphaMode ?? ALPHA_MODE_OPAQUE;
      if (matAlphaMode !== ALPHA_MODE_OPAQUE) {
        forceNonOpaqueGeometries.add(geometry);
      }
    }
  }

  const meshCache = new Map();
  const allTriangles = [];
  const instanceItems = [];
  const emissiveList = [];

  for (let instIdx = 0; instIdx < instancesInput.length; instIdx++) {
    const inst = instancesInput[instIdx];
    const geometry = inst.geometry;
    if (!geometry?.positions || !geometry?.indices) {
      throw new TypeError(`Instance[${instIdx}] requires a geometry with positions and indices.`);
    }
    const defaultMaterialIndex = Number(inst.materialIndex ?? 0);
    let materialOverride = inst.materialOverride !== undefined
      ? (inst.materialOverride >>> 0)
      : (inst.overrideMaterial === true ? (defaultMaterialIndex >>> 0) : INVALID_INDEX_V2);

    let meshSlot = meshCache.get(geometry);
    if (!meshSlot) {
      const blasIndex = meshCache.size;
      const triCount = Math.floor(geometry.indices.length / 3);
      const forceNonOpaque = forceNonOpaqueGeometries.has(geometry);
      const opaque = [];
      const cutout = [];
      for (let t = 0; t < triCount; t++) {
        const item = buildGeometryTriangleItem(geometry, t, defaultMaterialIndex, blasIndex, materialRecords);
        if (item.isOpaque && !forceNonOpaque) {
          opaque.push(item);
        } else {
          cutout.push(item);
        }
      }
      const ordered = [...opaque, ...cutout];
      const triangleOffset = allTriangles.length;
      const opaqueTriangleCount = opaque.length;
      const totalTriangleCount = ordered.length;

      for (const item of ordered) {
        allTriangles.push(item);
      }
      meshSlot = { blasIndex, defaultMaterialIndex, triangleOffset, opaqueTriangleCount, totalTriangleCount, ordered, emissiveLocalIndices: null };
      meshCache.set(geometry, meshSlot);
    } else if (
      materialOverride === INVALID_INDEX_V2 &&
      !geometry.triangleMaterial &&
      defaultMaterialIndex !== meshSlot.defaultMaterialIndex
    ) {
      materialOverride = defaultMaterialIndex >>> 0;
    }

    const decomposed = decomposeAffineMatrix(inst.matrix ?? IDENTITY_MATRIX_4X4);
    const masks = resolveLightMaskWords(inst.lightMask, inst.lightMaskHi);
    const baseVisibility = inst.visibilityFlags !== undefined
      ? (inst.visibilityFlags & 0x3f)
      : INSTANCE_DEFAULT_VISIBILITY;
    const visibilityFlags = (baseVisibility | (decomposed.negativeScale ? INSTANCE_FLAG_NEGATIVE_SCALE : 0)) >>> 0;

    let emissiveBaseOffset = INVALID_INDEX_V2;
    const emittedLocalIndices = [];
    for (let localIdx = 0; localIdx < meshSlot.ordered.length; localIdx++) {
      const triItem = meshSlot.ordered[localIdx];
      const globalTriIdx = meshSlot.triangleOffset + localIdx;
      const resolvedMatIdx = materialOverride !== INVALID_INDEX_V2 ? materialOverride : triItem.materialIndex;
      const emittedIdx = appendWorldEmissiveIfActive({
        emissiveList,
        triItem,
        globalTriangleIndex: globalTriIdx,
        instanceIndex: instIdx,
        resolvedMaterialIndex: resolvedMatIdx,
        materialRecords,
        objectToWorld: decomposed.objectToWorld,
        negativeScale: decomposed.negativeScale,
        lightGroupMaskLo: masks.lo,
        lightGroupMaskHi: masks.hi,
      });
      if (emittedIdx !== INVALID_INDEX_V2) {
        if (emissiveBaseOffset === INVALID_INDEX_V2) {
          emissiveBaseOffset = emittedIdx;
        }
        emittedLocalIndices.push(localIdx);
      }
    }
    shareEmissiveOffsets(meshSlot, emittedLocalIndices, instIdx);

    const objectId = (inst.objectId ?? instIdx) >>> 0;
    instanceItems.push({
      objectToWorld: decomposed.objectToWorld,
      worldToObject: decomposed.worldToObject,
      blasIndex: meshSlot.blasIndex,
      triangleOffset: meshSlot.triangleOffset,
      opaqueTriangleCount: meshSlot.opaqueTriangleCount,
      totalTriangleCount: meshSlot.totalTriangleCount,
      materialOverride,
      visibilityFlags,
      lightGroupMaskLo: masks.lo,
      lightGroupMaskHi: masks.hi,
      emissiveBaseOffset,
      objectId,
      objectRandom: inst.objectRandom !== undefined ? Number(inst.objectRandom) : deterministicUnitHash(objectId),
      shadowTerminatorOffset: Number(inst.shadowTerminatorOffset ?? 0),
      objectColor: inst.objectColor ?? [1, 1, 1, 1],
    });
  }

  const trianglesBuffer = new Uint8Array(Math.max(1, allTriangles.length) * STRUCT_STRIDES_V2.triangle);
  for (let index = 0; index < allTriangles.length; index++) {
    writeTriangleRecordBytes(trianglesBuffer, index * STRUCT_STRIDES_V2.triangle, allTriangles[index]);
  }
  const instancesBuffer = new Uint8Array(Math.max(1, instanceItems.length) * STRUCT_STRIDES_V2.instance);
  for (let index = 0; index < instanceItems.length; index++) {
    writeInstanceRecordBytes(instancesBuffer, index * STRUCT_STRIDES_V2.instance, instanceItems[index]);
  }

  return {
    instances: instancesBuffer,
    instanceCount: instanceItems.length,
    triangles: trianglesBuffer,
    triangleCount: allTriangles.length,
    materials: materialsBuffer,
    materialCount: materialRecords.length,
    usesSubsurface: materialRecords.some(rec => rec.usesSubsurface),
    emissiveList,
  };
}

function packFlattenedTraceScene(scene, rawParts, textureCollector) {
  const mergedMaterials = (scene.materials ?? []).map((resolvedMat, index) => {
    const rawMat = rawParts?.[index]?.material;
    return rawMat ? { ...rawMat, ...resolvedMat } : resolvedMat;
  });
  const materialRecords = mergedMaterials.map(mat => packMaterialRecordV2(mat, textureCollector));
  const materialsBuffer = new Uint8Array(Math.max(1, materialRecords.length) * STRUCT_STRIDES_V2.material);
  materialRecords.forEach((rec, index) => materialsBuffer.set(rec.bytes, index * STRUCT_STRIDES_V2.material));

  const totalSceneTriangles = Math.floor((scene.indices?.length ?? 0) / 3);
  const trianglesByPart = new Map();
  for (let triIndex = 0; triIndex < totalSceneTriangles; triIndex++) {
    const partIndex = scene.triangleMaterial ? scene.triangleMaterial[triIndex] : 0;
    let bucket = trianglesByPart.get(partIndex);
    if (!bucket) {
      bucket = [];
      trianglesByPart.set(partIndex, bucket);
    }
    bucket.push(triIndex);
  }

  const identityTransform = decomposeAffineMatrix(IDENTITY_MATRIX_4X4);
  const allTriangles = [];
  const instanceItems = [];
  const emissiveList = [];

  const sortedPartIndices = [...trianglesByPart.keys()].sort((a, b) => a - b);
  for (const partIndex of sortedPartIndices) {
    const triIndices = trianglesByPart.get(partIndex);
    const opaque = [];
    const cutout = [];
    for (const triIndex of triIndices) {
      const item = buildGeometryTriangleItem(scene, triIndex, partIndex, partIndex, materialRecords);
      if (item.isOpaque) {
        opaque.push(item);
      } else {
        cutout.push(item);
      }
    }
    const ordered = [...opaque, ...cutout];
    const instanceIndex = instanceItems.length;
    const triangleOffset = allTriangles.length;
    const partMaterial = mergedMaterials[partIndex] ?? {};
    const masks = resolveLightMaskWords(partMaterial.lightMask, partMaterial.lightMaskHi);

    let emissiveBaseOffset = INVALID_INDEX_V2;
    let localEmissiveCounter = 0;
    for (let localIdx = 0; localIdx < ordered.length; localIdx++) {
      const triItem = ordered[localIdx];
      const globalTriIdx = triangleOffset + localIdx;
      const emittedIdx = appendWorldEmissiveIfActive({
        emissiveList,
        triItem,
        globalTriangleIndex: globalTriIdx,
        instanceIndex,
        resolvedMaterialIndex: triItem.materialIndex,
        materialRecords,
        objectToWorld: identityTransform.objectToWorld,
        negativeScale: false,
        lightGroupMaskLo: masks.lo,
        lightGroupMaskHi: masks.hi,
      });
      if (emittedIdx !== INVALID_INDEX_V2) {
        if (emissiveBaseOffset === INVALID_INDEX_V2) {
          emissiveBaseOffset = emittedIdx;
        }
        triItem.localEmissiveOffset = localEmissiveCounter++;
      }
      allTriangles.push(triItem);
    }

    const objectId = partIndex >>> 0;
    instanceItems.push({
      objectToWorld: identityTransform.objectToWorld,
      worldToObject: identityTransform.worldToObject,
      blasIndex: instanceIndex,
      triangleOffset,
      opaqueTriangleCount: opaque.length,
      totalTriangleCount: ordered.length,
      materialOverride: INVALID_INDEX_V2,
      visibilityFlags: INSTANCE_DEFAULT_VISIBILITY,
      lightGroupMaskLo: masks.lo,
      lightGroupMaskHi: masks.hi,
      emissiveBaseOffset,
      objectId,
      objectRandom: deterministicUnitHash(objectId),
      shadowTerminatorOffset: 0,
      objectColor: [1, 1, 1, 1],
    });
  }

  const trianglesBuffer = new Uint8Array(Math.max(1, allTriangles.length) * STRUCT_STRIDES_V2.triangle);
  for (let index = 0; index < allTriangles.length; index++) {
    writeTriangleRecordBytes(trianglesBuffer, index * STRUCT_STRIDES_V2.triangle, allTriangles[index]);
  }
  const instancesBuffer = new Uint8Array(Math.max(1, instanceItems.length) * STRUCT_STRIDES_V2.instance);
  for (let index = 0; index < instanceItems.length; index++) {
    writeInstanceRecordBytes(instancesBuffer, index * STRUCT_STRIDES_V2.instance, instanceItems[index]);
  }

  return {
    instances: instancesBuffer,
    instanceCount: instanceItems.length,
    triangles: trianglesBuffer,
    triangleCount: allTriangles.length,
    materials: materialsBuffer,
    materialCount: materialRecords.length,
    usesSubsurface: materialRecords.some(rec => rec.usesSubsurface),
    emissiveList,
  };
}

/**
 * Packs a 67js scene (from `buildTraceScene` or an explicit `{ instances, materials }` descriptor) and camera into
 * `FORMAT-v2` typed-array buffers (`schemaVersion: 2`) matching `FORMAT-v2.md` and `src/cycles/abi.wgsl`.
 */
export function buildNativeInputV2(scene, camera, options = {}) {
  if (!scene || typeof scene !== 'object') {
    throw new TypeError('buildNativeInputV2 requires a scene object.');
  }
  if (scene.localVolumes) {
    throw new RangeError(
      'environment.localVolumes is traced by the CPU path tracer only; render-native cannot draw them. Use backend "cpu" or remove the volumes.'
    );
  }
  if (!camera || typeof camera !== 'object') {
    throw new TypeError('buildNativeInputV2 requires a camera object.');
  }
  validatePackOptions(options, 'buildNativeInputV2');

  const explicitInstances = options.instances ?? scene.instances;
  const reducedMaterials = options.reducedMaterials;
  if (reducedMaterials !== undefined) {
    if (!explicitInstances) {
      throw new TypeError('buildNativeInputV2 option `reducedMaterials` belongs to an instanced scene: pass a scene with `instances` (buildTraceScene with { instancing: true }), or leave the option out.');
    }
    if (!Array.isArray(reducedMaterials.materialRecords) || !reducedMaterials.textureCollector) {
      throw new TypeError('buildNativeInputV2 option `reducedMaterials` must be the result of reduceV1MaterialTable (materialRecords and textureCollector).');
    }
  }
  const textureCollector = reducedMaterials?.textureCollector ?? createTextureCollector({ textureMips: options.textureMips });
  const packedGeometry = explicitInstances
    ? packInstancedGeometry(explicitInstances, options.materials ?? scene.materials ?? [{}], textureCollector, reducedMaterials)
    : packFlattenedTraceScene(scene, options.parts ?? scene.parts, textureCollector);

  const packedTextures = textureCollector.finish();
  const packedEmissives = packEmissiveTriangleBuffer(packedGeometry.emissiveList);
  const analyticEntries = buildAnalyticLightEntries(scene.lights);
  const packedLights = packAnalyticLightsBuffer(analyticEntries);
  const packedLightTree = packLightTree(packedLights, packedEmissives);
  const packedEnvironment = packEnvironmentTexelsV2(scene.environment, options);

  const counts = {
    instanceCount: packedGeometry.instanceCount,
    triangleCount: packedGeometry.triangleCount,
    materialCount: packedGeometry.materialCount,
    emissiveTriangleCount: packedEmissives.emissiveTriangleCount,
    lightCount: packedLights.lightCount,
    lightTreeNodeCount: packedLightTree.lightTreeNodeCount,
    textureCount: packedTextures.textureCount,
    usesTextureMips: packedTextures.usesTextureMips,
  };

  const kernelParams = packKernelParamsV2({
    camera,
    options,
    counts,
    packedEnvironment,
    volume: scene.volume,
    usesSubsurface: packedGeometry.usesSubsurface,
    emissiveTotalWeight: packedEmissives.emissiveTotalWeight,
    analyticLightTotalWeight: packedLights.analyticLightTotalWeight,
    rayEpsilon: Number(scene.surfaceOffset ?? options.rayEpsilon ?? 1e-4),
    farDistance: Number(scene.farDistance ?? 1e30),
  });

  return {
    schemaVersion: FORMAT_V2_VERSION,
    kernelParams,
    instances: packedGeometry.instances,
    instanceCount: counts.instanceCount,
    triangles: packedGeometry.triangles,
    triangleCount: counts.triangleCount,
    materials: packedGeometry.materials,
    materialCount: counts.materialCount,
    emissiveTriangles: packedEmissives.emissiveTriangles,
    emissiveTriangleCount: counts.emissiveTriangleCount,
    lights: packedLights.lights,
    lightCount: counts.lightCount,
    lightTreeNodes: packedLightTree.lightTreeNodes,
    lightTreeNodeCount: counts.lightTreeNodeCount,
    lightTreeEmitters: packedLightTree.lightTreeEmitters,
    lightTreeEmitterCount: packedLightTree.lightTreeEmitterCount,
    lightToTree: packedLightTree.lightToTree,
    textureDescriptors: packedTextures.textureDescriptors,
    textureCount: counts.textureCount,
    textureTexels: packedTextures.textureTexels,
    environmentTexels: packedEnvironment.environmentTexels,
  };
}

function extractAtlasSubtexture(atlasWords, atlasWidth, rectX, rectY, width, height) {
  const words = new Uint32Array(width * height);
  for (let row = 0; row < height; row++) {
    const srcStart = (rectY + row) * atlasWidth + rectX;
    words.set(atlasWords.subarray(srcStart, srcStart + width), row * width);
  }
  return words;
}

// The texture slots of a material record that the v1 tables have no atlas rectangle for, with the colour space of each.
// `carried.textures` names them; the record field is the index the collector hands back.
const CARRIED_TEXTURE_SLOTS = Object.freeze([
  ['transmission', 'transmissionTex', false],
  ['coatWeightRoughness', 'coatWeightRoughnessTex', false],
  ['coatTint', 'coatTintTex', true],
  ['coatNormal', 'coatNormalTex', false],
  ['sheenColorRoughness', 'sheenColorRoughnessTex', true],
  ['anisotropy', 'anisotropyTex', false],
  ['bump', 'bumpTex', false],
]);

/**
 * The record descriptor of a material with the fields beyond the v1 tables laid over it. `carried` is the result of
 * `carriedMaterialFields` (src names of the record fields, plus `textures`, resolved images by slot). The descriptor keeps
 * every field the v1 tables carry as they are: carried fields never replace them, so a material that carries nothing packs
 * to the bytes it always did. Blending applies only to a material the tables made opaque.
 */
function withCarriedFields(descriptor, carried, textureCollector) {
  if (!carried) return descriptor;
  const { textures, alphaMode, ...fields } = carried;
  const carriedDescriptor = { ...descriptor, ...fields };
  if (alphaMode === 'blend' && descriptor.alphaMode === 'opaque') carriedDescriptor.alphaMode = 'blend';
  for (const [slot, field, isSrgb] of CARRIED_TEXTURE_SLOTS) {
    const image = textures?.[slot];
    if (image) carriedDescriptor[field] = textureCollector.addTexture(image, isSrgb).index;
  }
  return carriedDescriptor;
}

/**
 * The material records of a v1 material table. The fields the v1 tables carry (base colour, metallic, roughness, emission,
 * clearcoat, transmission, ior, normal scale, mask cutoff, subsurface and the four atlas textures) are read from the tables.
 * `carriedFields`, when given, holds one `carriedMaterialFields` result per material for everything the tables cannot hold
 * (blend opacity, sheen, specular, anisotropy, iridescence, attenuation, the layer textures and the rest of the record).
 * `materials` holds the table with the subsurface table after it, `atlas` the atlas words and `atlasWidth` their row width.
 */
export function reduceV1MaterialTable({ materials: matSource, atlas: atlasWords, atlasWidth, subsurfaceVec4Offset, materialCount, carriedFields, textureMips }) {
  const textureCollector = createTextureCollector({ textureMips });
  const atlasCache = new Map();

  function registerAtlasRect(rectX, rectY, width, height, flagsValue) {
    if (!(width > 0 && height > 0) || !atlasWords) {
      return { index: -1, meanLinearRgb: [1, 1, 1] };
    }
    const x = Math.round(rectX);
    const y = Math.round(rectY);
    const w = Math.round(width);
    const h = Math.round(height);
    const flags = Math.round(flagsValue);
    const key = `${x},${y},${w},${h},${flags}`;
    if (atlasCache.has(key)) {
      return atlasCache.get(key);
    }
    const repeat = (flags & 1) !== 0;
    const isSrgb = (flags & 2) !== 0;
    const subWords = extractAtlasSubtexture(atlasWords, atlasWidth, x, y, w, h);
    const added = textureCollector.addPackedRgba8Words(subWords, w, h, isSrgb, repeat);
    atlasCache.set(key, added);
    return added;
  }

  const materialRecords = [];
  const materialLightMasks = [];
  const materialShadowOnly = [];
  for (let m = 0; m < materialCount; m++) {
    const base = m * 40;
    const baseColor = [matSource[base], matSource[base + 1], matSource[base + 2]];
    const metallic = matSource[base + 3];
    const emission = [matSource[base + 4], matSource[base + 5], matSource[base + 6]];
    const roughness = matSource[base + 7];
    const clearcoat = matSource[base + 8];
    const clearcoatRoughness = matSource[base + 9];
    const transmission = matSource[base + 10];
    const ior = matSource[base + 11] > 0 ? matSource[base + 11] : 1.5;
    const normalScale = [matSource[base + 12] || 1, matSource[base + 13] || 1];
    const alphaCutoff = matSource[base + 14];
    const maskLo = ((Math.round(matSource[base + 15]) & 0xffff) | ((Math.round(matSource[base + 16]) & 0xffff) << 16)) >>> 0;
    materialLightMasks.push(maskLo);
    // The v1 tables flag a shadow-only part in the second channel of material texel 5 (SHADOW_ONLY_SLOT in src/path-tracer-gpu-pack.js).
    materialShadowOnly.push(matSource[base + 21] > 0);

    const baseTex = registerAtlasRect(matSource[base + 24], matSource[base + 25], matSource[base + 26], matSource[base + 27], matSource[base + 17]);
    const normalTex = registerAtlasRect(matSource[base + 28], matSource[base + 29], matSource[base + 30], matSource[base + 31], matSource[base + 18]);
    const mrTex = registerAtlasRect(matSource[base + 32], matSource[base + 33], matSource[base + 34], matSource[base + 35], matSource[base + 19]);
    const emissionTex = registerAtlasRect(matSource[base + 36], matSource[base + 37], matSource[base + 38], matSource[base + 39], matSource[base + 20]);

    let subsurface = null;
    if (subsurfaceVec4Offset > 0) {
      const subBase = subsurfaceVec4Offset * 4 + m * 8;
      if (subBase + 7 < matSource.length && matSource[subBase] > 0) {
        const hasCustomColor = matSource[subBase + 4] >= 0;
        subsurface = {
          weight: matSource[subBase],
          meanFreePath: [matSource[subBase + 1], matSource[subBase + 2], matSource[subBase + 3]],
          color: hasCustomColor ? [matSource[subBase + 4], matSource[subBase + 5], matSource[subBase + 6]] : baseColor,
        };
      }
    }

    const packedMat = packMaterialRecordV2(withCarriedFields({
      baseColor,
      metallic,
      roughness,
      ior,
      clearcoat,
      clearcoatRoughness,
      transmission,
      normalScale,
      emission,
      subsurface,
      alphaMode: alphaCutoff > 0 && baseTex.index >= 0 ? 'mask' : 'opaque',
      alphaCutoff: alphaCutoff > 0 && baseTex.index >= 0 ? alphaCutoff : 0,
      baseColorTex: baseTex.index,
      normalTex: normalTex.index,
      metallicRoughnessTex: mrTex.index,
      emissionTex: emissionTex.index,
      alphaTex: -1,
    }, carriedFields?.[m], textureCollector), null);
    packedMat.meanEmissiveRadiance = [
      packedMat.meanEmissiveRadiance[0] * emissionTex.meanLinearRgb[0],
      packedMat.meanEmissiveRadiance[1] * emissionTex.meanLinearRgb[1],
      packedMat.meanEmissiveRadiance[2] * emissionTex.meanLinearRgb[2],
    ];
    packedMat.isEmissive = luminance(packedMat.meanEmissiveRadiance) > 0;
    materialRecords.push(packedMat);
  }
  return { materialRecords, materialLightMasks, materialShadowOnly, textureCollector };
}

/**
 * Upgrades a legacy v1 `buildNativeInput` payload to `FORMAT-v2` (`schemaVersion: 2`) so existing callers passing v1
 * inputs with `kernel: 'cycles'` or `JS67_NATIVE_KERNEL=cycles` run without changing call sites. `carriedFields` (one
 * `carriedMaterialFields` result per material) adds what the v1 material table cannot hold; without it the records hold the
 * v1 fields alone.
 */
export function upgradeNativeInputV1ToV2(v1Input, options = {}, carriedFields = undefined) {
  if (v1Input?.schemaVersion === FORMAT_V2_VERSION) {
    return v1Input;
  }
  if (!v1Input || !(v1Input.parameters instanceof Uint8Array) || v1Input.parameters.byteLength !== 256) {
    throw new TypeError('upgradeNativeInputV1ToV2 requires a v1 NativeTraceInput with a 256-byte parameters block, or a FORMAT-v2 input.');
  }
  validatePackOptions(options, 'upgradeNativeInputV1ToV2');

  const paramBuffer = v1Input.parameters.buffer;
  const paramByteOffset = v1Input.parameters.byteOffset;
  const paramF32 = new Float32Array(paramBuffer, paramByteOffset, 64);
  const paramI32 = new Int32Array(paramBuffer, paramByteOffset, 64);
  const paramU32 = new Uint32Array(paramBuffer, paramByteOffset, 64);

  const triangleCount = Number(v1Input.triangleCount ?? 0);
  const triData = v1Input.triangles;
  if (!(triangleCount >= 0) || !triData || triData.length < triangleCount * 36) {
    throw new RangeError('v1 NativeTraceInput.triangles must hold at least triangleCount * 36 floats.');
  }

  const subsurfaceVec4Offset = paramU32[60];
  const materialVec4Limit = subsurfaceVec4Offset > 0 ? subsurfaceVec4Offset : Math.floor((v1Input.materials?.length ?? 0) / 4);
  const maxPossibleMaterials = Math.max(1, Math.floor(materialVec4Limit / 10));
  let highestMaterialIndex = 0;
  for (let slot = 0; slot < triangleCount; slot++) {
    const matIdx = Math.max(0, Math.round(triData[slot * 36 + 3]));
    if (matIdx > highestMaterialIndex) {
      highestMaterialIndex = matIdx;
    }
  }
  const materialCount = Math.min(maxPossibleMaterials, highestMaterialIndex + 1);

  const { materialRecords, materialLightMasks, materialShadowOnly, textureCollector } = reduceV1MaterialTable({
    materials: v1Input.materials,
    atlas: v1Input.atlas,
    atlasWidth: paramU32[45] || 1,
    subsurfaceVec4Offset,
    materialCount,
    carriedFields,
    textureMips: options.textureMips,
  });

  const materialsBuffer = new Uint8Array(Math.max(1, materialRecords.length) * STRUCT_STRIDES_V2.material);
  materialRecords.forEach((rec, idx) => materialsBuffer.set(rec.bytes, idx * STRUCT_STRIDES_V2.material));

  const trianglesByMat = new Map();
  for (let slot = 0; slot < triangleCount; slot++) {
    const matIdx = Math.min(materialCount - 1, Math.max(0, Math.round(triData[slot * 36 + 3])));
    let list = trianglesByMat.get(matIdx);
    if (!list) {
      list = [];
      trianglesByMat.set(matIdx, list);
    }
    list.push(slot);
  }

  const identityTransform = decomposeAffineMatrix(IDENTITY_MATRIX_4X4);
  const allTriangles = [];
  const instanceItems = [];
  const emissiveList = [];

  for (const matIdx of [...trianglesByMat.keys()].sort((a, b) => a - b)) {
    const slots = trianglesByMat.get(matIdx);
    const opaque = [];
    const cutout = [];
    for (const slot of slots) {
      const b = slot * 36;
      const p0 = [triData[b], triData[b + 1], triData[b + 2]];
      const edge1 = [triData[b + 4], triData[b + 5], triData[b + 6]];
      const edge2 = [triData[b + 8], triData[b + 9], triData[b + 10]];
      const geoNormal = normalizeVec3(crossVec3(edge1, edge2), [0, 1, 0]);
      const n0 = normalizeVec3([triData[b + 12], triData[b + 13], triData[b + 14]], geoNormal);
      const n1 = normalizeVec3([triData[b + 16], triData[b + 17], triData[b + 18]], geoNormal);
      const n2 = normalizeVec3([triData[b + 20], triData[b + 21], triData[b + 22]], geoNormal);
      const uv0 = [triData[b + 15], triData[b + 27]];
      const uv1 = [triData[b + 19], triData[b + 31]];
      const uv2 = [triData[b + 23], triData[b + 35]];
      const c0 = [triData[b + 24], triData[b + 25], triData[b + 26]];
      const c1 = [triData[b + 28], triData[b + 29], triData[b + 30]];
      const c2 = [triData[b + 32], triData[b + 33], triData[b + 34]];
      const tang = computeTriangleTangents(edge1, edge2, n0, n1, n2, uv0, uv1, uv2);
      const isOpaque = (materialRecords[matIdx]?.alphaMode ?? ALPHA_MODE_OPAQUE) === ALPHA_MODE_OPAQUE;
      const triItem = {
        p0,
        edge1,
        edge2,
        n0,
        n1,
        n2,
        uv0,
        uv1,
        uv2,
        t0: tang.t0,
        t1: tang.t1,
        t2: tang.t2,
        tangentSign: tang.sign,
        c0,
        c1,
        c2,
        uvSet1_0: [0, 0],
        uvSet1_1: [0, 0],
        uvSet1_2: [0, 0],
        flags: TRIANGLE_FLAG_SMOOTH_NORMALS | TRIANGLE_FLAG_HAS_VERTEX_COLORS | TRIANGLE_FLAG_HAS_TANGENTS | TRIANGLE_FLAG_DOUBLE_SIDED,
        materialIndex: matIdx,
        meshId: matIdx,
        primitiveId: slot,
        localEmissiveOffset: INVALID_INDEX_V2,
        isOpaque,
      };
      if (isOpaque) {
        opaque.push(triItem);
      } else {
        cutout.push(triItem);
      }
    }

    const ordered = [...opaque, ...cutout];
    const instanceIndex = instanceItems.length;
    const triangleOffset = allTriangles.length;
    const maskLo = materialLightMasks[matIdx] ?? 0xffffffff;
    const maskHi = maskLo === 0xffffffff ? 0xffffffff : 0;

    let emissiveBaseOffset = INVALID_INDEX_V2;
    let localEmissiveCounter = 0;
    for (let localIdx = 0; localIdx < ordered.length; localIdx++) {
      const triItem = ordered[localIdx];
      const globalTriIdx = triangleOffset + localIdx;
      const emittedIdx = appendWorldEmissiveIfActive({
        emissiveList,
        triItem,
        globalTriangleIndex: globalTriIdx,
        instanceIndex,
        resolvedMaterialIndex: matIdx,
        materialRecords,
        objectToWorld: identityTransform.objectToWorld,
        negativeScale: false,
        lightGroupMaskLo: maskLo,
        lightGroupMaskHi: maskHi,
      });
      if (emittedIdx !== INVALID_INDEX_V2) {
        if (emissiveBaseOffset === INVALID_INDEX_V2) {
          emissiveBaseOffset = emittedIdx;
        }
        triItem.localEmissiveOffset = localEmissiveCounter++;
      }
      allTriangles.push(triItem);
    }

    const objectId = matIdx >>> 0;
    instanceItems.push({
      objectToWorld: identityTransform.objectToWorld,
      worldToObject: identityTransform.worldToObject,
      blasIndex: instanceIndex,
      triangleOffset,
      opaqueTriangleCount: opaque.length,
      totalTriangleCount: ordered.length,
      materialOverride: INVALID_INDEX_V2,
      visibilityFlags: materialShadowOnly[matIdx] ? INSTANCE_DEFAULT_VISIBILITY & ~INSTANCE_VISIBILITY_CAMERA : INSTANCE_DEFAULT_VISIBILITY,
      lightGroupMaskLo: maskLo,
      lightGroupMaskHi: maskHi,
      emissiveBaseOffset,
      objectId,
      objectRandom: deterministicUnitHash(objectId),
      shadowTerminatorOffset: 0,
      objectColor: [1, 1, 1, 1],
    });
  }

  const trianglesBuffer = new Uint8Array(Math.max(1, allTriangles.length) * STRUCT_STRIDES_V2.triangle);
  for (let idx = 0; idx < allTriangles.length; idx++) {
    writeTriangleRecordBytes(trianglesBuffer, idx * STRUCT_STRIDES_V2.triangle, allTriangles[idx]);
  }
  const instancesBuffer = new Uint8Array(Math.max(1, instanceItems.length) * STRUCT_STRIDES_V2.instance);
  for (let idx = 0; idx < instanceItems.length; idx++) {
    writeInstanceRecordBytes(instancesBuffer, idx * STRUCT_STRIDES_V2.instance, instanceItems[idx]);
  }

  const v1LightCount = Math.max(0, paramI32[39]);
  const hasSun = paramI32[41] > 0;
  const reconstructedLights = { sun: null, points: [], spots: [], areas: [] };
  if (hasSun) {
    const cosSun = Math.min(1, Math.max(-1, paramF32[23]));
    reconstructedLights.sun = {
      bit: 0,
      direction: [paramF32[16], paramF32[17], paramF32[18]],
      color: [paramF32[20], paramF32[21], paramF32[22]],
      angularRadius: Math.acos(cosSun),
    };
  }
  const lightFloats = v1Input.lights;
  for (let i = 0; i < v1LightCount; i++) {
    const b = i * 24;
    const position = [lightFloats[b], lightFloats[b + 1], lightFloats[b + 2]];
    const type = Math.round(lightFloats[b + 3]);
    const color = [lightFloats[b + 4], lightFloats[b + 5], lightFloats[b + 6]];
    const bit = Math.round(lightFloats[b + 7]);
    if (type === 2) {
      reconstructedLights.areas.push({
        bit,
        position,
        color,
        normal: [lightFloats[b + 8], lightFloats[b + 9], lightFloats[b + 10]],
        width: lightFloats[b + 11],
        across: [lightFloats[b + 12], lightFloats[b + 13], lightFloats[b + 14]],
        height: lightFloats[b + 15],
        along: [lightFloats[b + 16], lightFloats[b + 17], lightFloats[b + 18]],
        intensity: lightFloats[b + 20],
      });
    } else if (type === 1) {
      reconstructedLights.spots.push({
        bit,
        position,
        color,
        direction: [lightFloats[b + 8], lightFloats[b + 9], lightFloats[b + 10]],
        radius: lightFloats[b + 11],
        cosineHalfAngle: lightFloats[b + 15],
        blend: lightFloats[b + 19],
        intensity: lightFloats[b + 20],
        range: lightFloats[b + 21],
      });
    } else {
      reconstructedLights.points.push({
        bit,
        position,
        color,
        radius: lightFloats[b + 11],
        intensity: lightFloats[b + 20],
        range: lightFloats[b + 21],
      });
    }
  }

  const hasEnvironment = paramI32[42] > 0;
  const reconstructedEnv = hasEnvironment && v1Input.environmentColors
    ? {
      width: Math.max(1, Math.round(paramF32[24])),
      height: Math.max(1, Math.round(paramF32[25])),
      channels: 4,
      data: v1Input.environmentColors,
      intensity: paramF32[26],
      cosine: paramF32[28],
      sine: paramF32[29],
    }
    : null;

  const volume = paramF32[51] > 0
    ? {
      minimum: [paramF32[48], paramF32[49], paramF32[50]],
      density: paramF32[51],
      maximum: [paramF32[52], paramF32[53], paramF32[54]],
      anisotropy: paramF32[55],
      albedo: [paramF32[56], paramF32[57], paramF32[58]],
      maxDistance: paramF32[59],
    }
    : null;

  const camera = {
    eye: [paramF32[0], paramF32[1], paramF32[2]],
    forward: [paramF32[4], paramF32[5], paramF32[6]],
    right: [paramF32[8], paramF32[9], paramF32[10]],
    above: [paramF32[12], paramF32[13], paramF32[14]],
    halfWidth: paramF32[32],
    halfHeight: paramF32[33],
    ...readV1ThinLens(paramF32),
  };

  const packedTextures = textureCollector.finish();
  const packedEmissives = packEmissiveTriangleBuffer(emissiveList);
  const analyticEntries = buildAnalyticLightEntries(reconstructedLights);
  const packedLights = packAnalyticLightsBuffer(analyticEntries);
  const packedLightTree = packLightTree(packedLights, packedEmissives);
  const packedEnvironment = packEnvironmentTexelsV2(reconstructedEnv, options);

  const mergedOptions = {
    width: options.width ?? paramI32[36],
    height: options.height ?? paramI32[37],
    bounces: options.bounces ?? paramI32[38],
    seed: options.seed ?? paramU32[44],
    noiseThreshold: options.noiseThreshold ?? paramF32[35],
    ...options,
  };

  const counts = {
    instanceCount: instanceItems.length,
    triangleCount: allTriangles.length,
    materialCount: materialRecords.length,
    emissiveTriangleCount: packedEmissives.emissiveTriangleCount,
    lightCount: packedLights.lightCount,
    lightTreeNodeCount: packedLightTree.lightTreeNodeCount,
    textureCount: packedTextures.textureCount,
    usesTextureMips: packedTextures.usesTextureMips,
  };

  const kernelParams = packKernelParamsV2({
    camera,
    options: mergedOptions,
    counts,
    packedEnvironment,
    volume,
    usesSubsurface: materialRecords.some(rec => rec.usesSubsurface),
    emissiveTotalWeight: packedEmissives.emissiveTotalWeight,
    analyticLightTotalWeight: packedLights.analyticLightTotalWeight,
    rayEpsilon: paramF32[30] > 0 ? paramF32[30] : 1e-4,
    farDistance: paramF32[31] > 0 ? paramF32[31] : 1e30,
  });

  return {
    schemaVersion: FORMAT_V2_VERSION,
    kernelParams,
    instances: instancesBuffer,
    instanceCount: counts.instanceCount,
    triangles: trianglesBuffer,
    triangleCount: counts.triangleCount,
    materials: materialsBuffer,
    materialCount: counts.materialCount,
    emissiveTriangles: packedEmissives.emissiveTriangles,
    emissiveTriangleCount: counts.emissiveTriangleCount,
    lights: packedLights.lights,
    lightCount: counts.lightCount,
    lightTreeNodes: packedLightTree.lightTreeNodes,
    lightTreeNodeCount: counts.lightTreeNodeCount,
    lightTreeEmitters: packedLightTree.lightTreeEmitters,
    lightTreeEmitterCount: packedLightTree.lightTreeEmitterCount,
    lightToTree: packedLightTree.lightToTree,
    textureDescriptors: packedTextures.textureDescriptors,
    textureCount: counts.textureCount,
    textureTexels: packedTextures.textureTexels,
    environmentTexels: packedEnvironment.environmentTexels,
  };
}
