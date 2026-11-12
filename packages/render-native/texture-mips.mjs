// Mip chains for the texture pool of FORMAT-v2 (issue 896). Pure functions on typed arrays, no GPU.
//
// Level 0 is the texture as the caller gave it. Each level after it is half as wide and as high, rounded down and never less
// than one texel. Level 1 is the integral of what the kernel reads at level 0: each level 1 texel is the mean, in linear light,
// of the level 0 reconstruction (bilinear on the stored values with texel centres at +0.5, then the sRGB decode of an sRGB map)
// over its footprint, taken at up to 8 x 8 positions with the wrap mode of the texture. A plain 2 x 2 box of decoded texels is not that
// mean: the bilinear blend of two stored values decodes darker than the two decoded values, so a box would read too bright
// against the level 0 picture of a high contrast map. Levels 2 and up are the 2 x 2 box of the level before, in linear light for
// an sRGB map; an odd last row or column is read twice. The whole chain is built in doubles and each level is rounded to its
// storage format once (to the nearest code of the stored value), so no rounding feeds the next level. The alpha channel is
// averaged on its stored values, not weighted by itself, so a texel with alpha 0 pulls its colour into the next level; a map whose alpha is a cutout should not ask for levels. Normal maps are averaged as stored and are not
// normalised again; the kernel normalises the result.

export const TEXTURE_KIND_RGBA8 = 'rgba8';
export const TEXTURE_KIND_RGBA8_SRGB = 'rgba8-srgb';
export const TEXTURE_KIND_RGBA32_FLOAT = 'rgba32f';
export const TEXTURE_KIND_RG16_FLOAT = 'rg16f';

const MAX_TEXTURE_SIDE = 1 << 20;

const halfScratchView = new DataView(new ArrayBuffer(4));

/** The float value of an IEEE half-precision bit pattern. */
export function halfToFloat(halfBits) {
  const sign = (halfBits & 0x8000) === 0 ? 1 : -1;
  const exponent = (halfBits >> 10) & 0x1f;
  const fraction = halfBits & 0x3ff;
  if (exponent === 0) {
    return sign * (fraction / 1024) * 2 ** -14;
  }
  if (exponent === 31) {
    return fraction === 0 ? sign * Infinity : Number.NaN;
  }
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/** The IEEE half-precision bit pattern nearest to `value` (ties to even; too large becomes infinity). */
export function floatToHalf(value) {
  halfScratchView.setFloat32(0, value);
  const bits = halfScratchView.getUint32(0);
  const signBit = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;
  if (exponent === 0xff) {
    return signBit | 0x7c00 | (mantissa === 0 ? 0 : 0x200);
  }
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 31) {
    return signBit | 0x7c00;
  }
  if (halfExponent <= 0) {
    if (halfExponent < -10) {
      return signBit;
    }
    const withLeadingBit = mantissa | 0x800000;
    const shift = 14 - halfExponent;
    let subnormal = withLeadingBit >>> shift;
    const roundBit = (withLeadingBit >>> (shift - 1)) & 1;
    const stickyBits = withLeadingBit & ((1 << (shift - 1)) - 1);
    if (roundBit === 1 && (stickyBits !== 0 || (subnormal & 1) === 1)) {
      subnormal += 1;
    }
    return signBit | subnormal;
  }
  let half = (halfExponent << 10) | (mantissa >>> 13);
  if ((mantissa & 0x1000) !== 0 && ((mantissa & 0x0fff) !== 0 || (half & 1) === 1)) {
    half += 1;
  }
  return signBit | half;
}

function requireTextureSide(width, height) {
  const isValid = Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= MAX_TEXTURE_SIDE && height <= MAX_TEXTURE_SIDE;
  if (!isValid) {
    throw new RangeError(`A texture side must be an integer from 1 to ${MAX_TEXTURE_SIDE}, got ${width}x${height}. Pass the width and height of the image.`);
  }
}

/** The number of levels of a full chain, level 0 included: 1 + floor(log2(longest side)). */
export function mipLevelCount(width, height) {
  requireTextureSide(width, height);
  return 32 - Math.clz32(Math.max(width, height));
}

/** The size of level `level`: each side halved `level` times, rounded down, never below 1. */
export function mipLevelSize(width, height, level) {
  return { width: Math.max(1, width >> level), height: Math.max(1, height >> level) };
}

function wordsPerTexel(kind) {
  return kind === TEXTURE_KIND_RGBA32_FLOAT ? 4 : 1;
}

const SRGB_DECODE_TABLE_SIZE = 4096;
const SRGB_DECODE_TABLE = (() => {
  const table = new Float64Array(SRGB_DECODE_TABLE_SIZE + 1);
  for (let index = 0; index <= SRGB_DECODE_TABLE_SIZE; index++) {
    const encoded = index / SRGB_DECODE_TABLE_SIZE;
    table[index] = encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  }
  return table;
})();

// The sRGB decode of a stored value in [0, 1], from a 4096 entry table with linear interpolation.
function decodeStoredSrgb(stored) {
  const position = Math.min(1, Math.max(0, stored)) * SRGB_DECODE_TABLE_SIZE;
  const lower = Math.min(Math.floor(position), SRGB_DECODE_TABLE_SIZE - 1);
  const blend = position - lower;
  return SRGB_DECODE_TABLE[lower] * (1 - blend) + SRGB_DECODE_TABLE[lower + 1] * blend;
}

/** The 32-bit words the levels after level 0 take, with no padding between levels. */
export function mipChainWordCount(kind, width, height) {
  const levelCount = mipLevelCount(width, height);
  let totalWords = 0;
  for (let level = 1; level < levelCount; level++) {
    const size = mipLevelSize(width, height, level);
    totalWords += size.width * size.height * wordsPerTexel(kind);
  }
  return totalWords;
}

// The source texels one destination texel covers along one axis, with the share of the destination texel each one fills.
// A destination side is floor(source / 2), so an odd source side gives spans of two and a fraction texels: every source
// texel is read, and the weights of a span sum to one.
function axisSpans(sourceSide, destinationSide) {
  const ratio = sourceSide / destinationSide;
  const spans = [];
  for (let destinationIndex = 0; destinationIndex < destinationSide; destinationIndex++) {
    const spanStart = destinationIndex * ratio;
    const spanEnd = Math.min(sourceSide, (destinationIndex + 1) * ratio);
    const span = [];
    for (let sourceIndex = Math.floor(spanStart); sourceIndex < Math.ceil(spanEnd); sourceIndex++) {
      const covered = Math.min(spanEnd, sourceIndex + 1) - Math.max(spanStart, sourceIndex);
      if (covered > 0) span.push({ sourceIndex, weight: covered / ratio });
    }
    spans.push(span);
  }
  return spans;
}

function linearToSrgbByte(linear) {
  const clamped = Math.min(1, Math.max(0, linear));
  const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

// A working level holds four doubles per texel: the linear light of the colour channels of an sRGB map, the stored value
// (bytes as value / 255, floats as they are) for everything else. The chain is built in these doubles and each level is
// rounded to its storage format once, so the rounding of a level never feeds the next one.
function boxAverageLevel(source, sourceSize, destinationSize) {
  const destination = new Float64Array(destinationSize.width * destinationSize.height * 4);
  const columnSpans = axisSpans(sourceSize.width, destinationSize.width);
  const rowSpans = axisSpans(sourceSize.height, destinationSize.height);
  for (let row = 0; row < destinationSize.height; row++) {
    for (let column = 0; column < destinationSize.width; column++) {
      const target = (row * destinationSize.width + column) * 4;
      for (const rowEntry of rowSpans[row]) {
        for (const columnEntry of columnSpans[column]) {
          const sourceTexel = (rowEntry.sourceIndex * sourceSize.width + columnEntry.sourceIndex) * 4;
          const weight = rowEntry.weight * columnEntry.weight;
          for (let channel = 0; channel < 4; channel++) {
            destination[target + channel] += source[sourceTexel + channel] * weight;
          }
        }
      }
    }
  }
  return destination;
}

const FIRST_LEVEL_SAMPLE_BUDGET = 64 * 1024 * 1024;
const FIRST_LEVEL_MAX_POSITIONS_PER_AXIS = 8;

// 8 x 8 positions per level 1 texel leave the mean of a 30 / 220 sRGB checker 0.3 percent short, 4 x 4 leave it 1.6 percent short
// (16 x 16 is exact). A large texture takes fewer positions so that packing stays within about 64 million reconstructions.
function firstLevelPositionsPerAxis(texelCount) {
  const affordable = Math.floor(Math.sqrt(FIRST_LEVEL_SAMPLE_BUDGET / texelCount));
  return Math.max(2, Math.min(FIRST_LEVEL_MAX_POSITIONS_PER_AXIS, affordable));
}

// The kernel wrap of a texel index (texture_wrap_texel_index): repeat wraps, clamp and mirror clamp.
function wrapTexelIndex(index, size, wrapMode) {
  if (wrapMode === 0) {
    const remainder = index % size;
    return remainder < 0 ? remainder + size : remainder;
  }
  return Math.min(Math.max(index, 0), size - 1);
}

// Reads the stored value of one texel as four numbers (floats as they are; a two-channel texture reads b = 0, a = 1).
function createStoredTexelReader(kind, source) {
  if (kind === TEXTURE_KIND_RGBA32_FLOAT) {
    return (index, target) => {
      for (let channel = 0; channel < 4; channel++) target[channel] = source[index * 4 + channel];
    };
  }
  if (kind === TEXTURE_KIND_RG16_FLOAT) {
    return (index, target) => {
      target[0] = halfToFloat(source[index] & 0xffff);
      target[1] = halfToFloat(source[index] >>> 16);
      target[2] = 0;
      target[3] = 1;
    };
  }
  return (index, target) => {
    const word = source[index];
    for (let channel = 0; channel < 4; channel++) target[channel] = ((word >>> (channel * 8)) & 0xff) / 255;
  };
}

function integrateFirstLevel(kind, source, sourceSize, destinationSize, wrapU, wrapV) {
  const read = createStoredTexelReader(kind, source);
  const destination = new Float64Array(destinationSize.width * destinationSize.height * 4);
  const corners = [new Float64Array(4), new Float64Array(4), new Float64Array(4), new Float64Array(4)];
  const sum = new Float64Array(4);
  const decodesSrgb = kind === TEXTURE_KIND_RGBA8_SRGB;
  const positions = firstLevelPositionsPerAxis(destinationSize.width * destinationSize.height);
  for (let row = 0; row < destinationSize.height; row++) {
    for (let column = 0; column < destinationSize.width; column++) {
      sum.fill(0);
      for (let subRow = 0; subRow < positions; subRow++) {
        const coordinateY = (row + (subRow + 0.5) / positions) / destinationSize.height * sourceSize.height - 0.5;
        const baseY = Math.floor(coordinateY);
        const blendY = coordinateY - baseY;
        const rowTop = wrapTexelIndex(baseY, sourceSize.height, wrapV) * sourceSize.width;
        const rowBottom = wrapTexelIndex(baseY + 1, sourceSize.height, wrapV) * sourceSize.width;
        for (let subColumn = 0; subColumn < positions; subColumn++) {
          const coordinateX = (column + (subColumn + 0.5) / positions) / destinationSize.width * sourceSize.width - 0.5;
          const baseX = Math.floor(coordinateX);
          const blendX = coordinateX - baseX;
          const left = wrapTexelIndex(baseX, sourceSize.width, wrapU);
          const right = wrapTexelIndex(baseX + 1, sourceSize.width, wrapU);
          read(rowTop + left, corners[0]);
          read(rowTop + right, corners[1]);
          read(rowBottom + left, corners[2]);
          read(rowBottom + right, corners[3]);
          for (let channel = 0; channel < 4; channel++) {
            const top = corners[0][channel] * (1 - blendX) + corners[1][channel] * blendX;
            const bottom = corners[2][channel] * (1 - blendX) + corners[3][channel] * blendX;
            const reconstructed = top * (1 - blendY) + bottom * blendY;
            sum[channel] += decodesSrgb && channel < 3 ? decodeStoredSrgb(reconstructed) : reconstructed;
          }
        }
      }
      for (let channel = 0; channel < 4; channel++) {
        destination[(row * destinationSize.width + column) * 4 + channel] = sum[channel] / (positions * positions);
      }
    }
  }
  return destination;
}

// Rounds a working level to the storage format of the texture, once: bytes to the nearest code of the stored (sRGB encoded) value.
function encodeLevel(kind, working, texelCount, destination) {
  if (kind === TEXTURE_KIND_RGBA32_FLOAT) {
    for (let index = 0; index < texelCount * 4; index++) destination[index] = working[index];
    return;
  }
  for (let texel = 0; texel < texelCount; texel++) {
    const base = texel * 4;
    if (kind === TEXTURE_KIND_RG16_FLOAT) {
      destination[texel] = (floatToHalf(working[base]) | (floatToHalf(working[base + 1]) << 16)) >>> 0;
      continue;
    }
    let packed = 0;
    for (let channel = 0; channel < 4; channel++) {
      const isLinearLight = kind === TEXTURE_KIND_RGBA8_SRGB && channel < 3;
      const byteValue = isLinearLight ? linearToSrgbByte(working[base + channel]) : Math.round(Math.min(1, Math.max(0, working[base + channel])) * 255);
      packed |= byteValue << (channel * 8);
    }
    destination[texel] = packed >>> 0;
  }
}

/**
 * The levels after level 0 of one texture, one after the other, as 32-bit words. `texels` holds level 0 without padding:
 * one word per texel for `rgba8` and `rgba8-srgb` (bytes r, g, b, a from the low byte) and `rg16f` (two halves, r in the low half), four
 * floats per texel for `rgba32f`. `wrapU` and `wrapV` are the wrap modes of the texture (0 repeat, 1 clamp, 2 mirror) and matter
 * for level 1 only. Returns an empty array for a texture of one texel.
 */
export function buildMipChain(kind, texels, width, height, wrapU = 0, wrapV = 0) {
  requireTextureSide(width, height);
  if (![TEXTURE_KIND_RGBA8, TEXTURE_KIND_RGBA8_SRGB, TEXTURE_KIND_RGBA32_FLOAT, TEXTURE_KIND_RG16_FLOAT].includes(kind)) {
    throw new RangeError(`buildMipChain: kind must be "${TEXTURE_KIND_RGBA8}", "${TEXTURE_KIND_RGBA8_SRGB}", "${TEXTURE_KIND_RGBA32_FLOAT}" or "${TEXTURE_KIND_RG16_FLOAT}", got ${JSON.stringify(kind)}.`);
  }
  const levelCount = mipLevelCount(width, height);
  const chain = new Uint32Array(mipChainWordCount(kind, width, height));
  if (levelCount === 1) {
    return chain;
  }
  const isFloat = kind === TEXTURE_KIND_RGBA32_FLOAT;
  const source = isFloat ? new Float32Array(texels.buffer, texels.byteOffset, width * height * 4) : texels;
  let working = null;
  let sourceSize = { width, height };
  let cursor = 0;
  for (let level = 1; level < levelCount; level++) {
    const destinationSize = mipLevelSize(width, height, level);
    const texelCount = destinationSize.width * destinationSize.height;
    const levelWords = texelCount * wordsPerTexel(kind);
    const destinationWords = chain.subarray(cursor, cursor + levelWords);
    const destination = isFloat ? new Float32Array(destinationWords.buffer, destinationWords.byteOffset, levelWords) : destinationWords;
    working = level === 1
      ? integrateFirstLevel(kind, source, sourceSize, destinationSize, wrapU, wrapV)
      : boxAverageLevel(working, sourceSize, destinationSize);
    encodeLevel(kind, working, texelCount, destination);
    sourceSize = destinationSize;
    cursor += levelWords;
  }
  return chain;
}
