// Mip chains for the texture pool of FORMAT-v2 (issue 896). Pure functions on typed arrays, no GPU.
//
// Level 0 is the texture as the caller gave it. Each level after it is half as wide and as high, rounded down and never less
// than one texel, and is the plain average of the 2 x 2 texels of the level before it. A linear 8-bit map and a float map are
// averaged on their stored values. An sRGB map is averaged in linear light and encoded back to bytes: the kernel still filters
// its bytes and decodes the blend, as at level 0, but a level that held the mean of the stored bytes would read darker than
// the mean of the light (a black and white checker: 0.21 against 0.5 once decoded), and a minified surface would turn
// darker than the same surface supersampled. The alpha channel is averaged on its stored values and not weighted by itself, so a texel with alpha 0 pulls its
// colour into the next level; a map whose alpha is a cutout should not ask for levels. Where a side has an odd length, the
// last row or column has no pair: it is averaged with itself in the next level's last texel, and the one beyond the halved
// size is not read. Normal maps are averaged as stored and are not normalised again; the kernel normalises the result.

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

// Calls `visit(destinationIndex, topLeft, topRight, bottomLeft, bottomRight)` with the texel indexes of the 2 x 2 block of the
// source level that the destination texel covers. A side of one texel, or the last column of an odd side, reads itself twice.
function visitBlocks(sourceWidth, sourceHeight, destinationWidth, destinationHeight, visit) {
  for (let row = 0; row < destinationHeight; row++) {
    const topRow = Math.min(row * 2, sourceHeight - 1);
    const bottomRow = Math.min(row * 2 + 1, sourceHeight - 1);
    for (let column = 0; column < destinationWidth; column++) {
      const leftColumn = Math.min(column * 2, sourceWidth - 1);
      const rightColumn = Math.min(column * 2 + 1, sourceWidth - 1);
      visit(
        row * destinationWidth + column,
        topRow * sourceWidth + leftColumn,
        topRow * sourceWidth + rightColumn,
        bottomRow * sourceWidth + leftColumn,
        bottomRow * sourceWidth + rightColumn,
      );
    }
  }
}

function averageBytes(first, second, third, fourth) {
  return (first + second + third + fourth + 2) >> 2;
}

function srgbByteToLinearTable() {
  const table = new Float64Array(256);
  for (let byteValue = 0; byteValue < 256; byteValue++) {
    const encoded = byteValue / 255;
    table[byteValue] = encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  }
  return table;
}

const SRGB_BYTE_TO_LINEAR = srgbByteToLinearTable();

function linearToSrgbByte(linear) {
  const clamped = Math.min(1, Math.max(0, linear));
  const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

function averageSrgbBytesInLinearLight(first, second, third, fourth) {
  return linearToSrgbByte((SRGB_BYTE_TO_LINEAR[first] + SRGB_BYTE_TO_LINEAR[second] + SRGB_BYTE_TO_LINEAR[third] + SRGB_BYTE_TO_LINEAR[fourth]) * 0.25);
}

function averageRgba8Level(source, destination, sourceWidth, sourceHeight, destinationWidth, destinationHeight, isSrgb = false) {
  visitBlocks(sourceWidth, sourceHeight, destinationWidth, destinationHeight, (target, topLeft, topRight, bottomLeft, bottomRight) => {
    let packed = 0;
    for (let channel = 0; channel < 4; channel++) {
      const shift = channel * 8;
      const averageOfChannel = isSrgb && channel < 3 ? averageSrgbBytesInLinearLight : averageBytes;
      const average = averageOfChannel(
        (source[topLeft] >>> shift) & 0xff,
        (source[topRight] >>> shift) & 0xff,
        (source[bottomLeft] >>> shift) & 0xff,
        (source[bottomRight] >>> shift) & 0xff,
      );
      packed |= average << shift;
    }
    destination[target] = packed >>> 0;
  });
}

function averageFloatLevel(source, destination, sourceWidth, sourceHeight, destinationWidth, destinationHeight) {
  visitBlocks(sourceWidth, sourceHeight, destinationWidth, destinationHeight, (target, topLeft, topRight, bottomLeft, bottomRight) => {
    for (let channel = 0; channel < 4; channel++) {
      destination[target * 4 + channel] = (
        source[topLeft * 4 + channel] + source[topRight * 4 + channel] + source[bottomLeft * 4 + channel] + source[bottomRight * 4 + channel]
      ) * 0.25;
    }
  });
}

function averageHalfPairLevel(source, destination, sourceWidth, sourceHeight, destinationWidth, destinationHeight) {
  visitBlocks(sourceWidth, sourceHeight, destinationWidth, destinationHeight, (target, topLeft, topRight, bottomLeft, bottomRight) => {
    let packed = 0;
    for (let channel = 0; channel < 2; channel++) {
      const shift = channel * 16;
      const total = halfToFloat((source[topLeft] >>> shift) & 0xffff)
        + halfToFloat((source[topRight] >>> shift) & 0xffff)
        + halfToFloat((source[bottomLeft] >>> shift) & 0xffff)
        + halfToFloat((source[bottomRight] >>> shift) & 0xffff);
      packed |= floatToHalf(total * 0.25) << shift;
    }
    destination[target] = packed >>> 0;
  });
}

/**
 * The levels after level 0 of one texture, one after the other, as 32-bit words. `texels` holds level 0 without padding:
 * one word per texel for `rgba8` and `rgba8-srgb` (bytes r, g, b, a from the low byte) and `rg16f` (two halves, r in the low half), four
 * floats per texel for `rgba32f`. Returns an empty array for a texture of one texel.
 */
export function buildMipChain(kind, texels, width, height) {
  requireTextureSide(width, height);
  const levelCount = mipLevelCount(width, height);
  const chain = new Uint32Array(mipChainWordCount(kind, width, height));
  if (levelCount === 1) {
    return chain;
  }
  const isFloat = kind === TEXTURE_KIND_RGBA32_FLOAT;
  const average = {
    [TEXTURE_KIND_RGBA8]: averageRgba8Level,
    [TEXTURE_KIND_RGBA8_SRGB]: (...levelArguments) => averageRgba8Level(...levelArguments, true),
    [TEXTURE_KIND_RGBA32_FLOAT]: averageFloatLevel,
    [TEXTURE_KIND_RG16_FLOAT]: averageHalfPairLevel,
  }[kind];
  if (!average) {
    throw new RangeError(`buildMipChain: kind must be "${TEXTURE_KIND_RGBA8}", "${TEXTURE_KIND_RGBA8_SRGB}", "${TEXTURE_KIND_RGBA32_FLOAT}" or "${TEXTURE_KIND_RG16_FLOAT}", got ${JSON.stringify(kind)}.`);
  }
  let source = isFloat ? new Float32Array(texels.buffer, texels.byteOffset, width * height * 4) : texels;
  let sourceSize = { width, height };
  let cursor = 0;
  for (let level = 1; level < levelCount; level++) {
    const destinationSize = mipLevelSize(width, height, level);
    const levelWords = destinationSize.width * destinationSize.height * wordsPerTexel(kind);
    const destinationWords = chain.subarray(cursor, cursor + levelWords);
    const destination = isFloat ? new Float32Array(destinationWords.buffer, destinationWords.byteOffset, levelWords) : destinationWords;
    average(source, destination, sourceSize.width, sourceSize.height, destinationSize.width, destinationSize.height);
    source = destination;
    sourceSize = destinationSize;
    cursor += levelWords;
  }
  return chain;
}
