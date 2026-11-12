import assert from 'node:assert/strict';
import test from 'node:test';
import { STRUCT_STRIDES_V2, buildNativeInputV2, findNativeAddon, traceNative } from '../packages/render-native/index.mjs';
import {
  KERNEL_FLAG_TEXTURE_MIPS,
  KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET,
  TEXTURE_POOL_MAX_BYTES,
} from '../packages/render-native/pack-input-v2.mjs';
import {
  TEXTURE_KIND_RG16_FLOAT,
  TEXTURE_KIND_RGBA32_FLOAT,
  TEXTURE_KIND_RGBA8,
  TEXTURE_KIND_RGBA8_SRGB,
  buildMipChain,
  floatToHalf,
  halfToFloat,
  mipChainWordCount,
  mipLevelCount,
  mipLevelSize,
} from '../packages/render-native/texture-mips.mjs';
import { createCamera } from '../src/path-tracer.js';

const QUAD_UVS = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
const FORMAT_RGBA8_UNORM = 0;
const FORMAT_RGBA8_SRGB = 1;
const FORMAT_RGBA32_FLOAT = 2;
const FORMAT_RG16_FLOAT = 3;

function quadGeometry(z = 0) {
  return {
    positions: new Float32Array([-1, -1, z, 1, -1, z, 1, 1, z, -1, 1, z]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: QUAD_UVS,
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function packedWord(red, green, blue, alpha) {
  return (red | (green << 8) | (blue << 16) | (alpha << 24)) >>> 0;
}

function byteImage(width, height, fillTexel) {
  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const texel = fillTexel(pixel % width, Math.floor(pixel / width));
    data.set(texel, pixel * 4);
  }
  return { width, height, data };
}

function packMaterials(materials, options = {}) {
  const camera = createCamera({ eye: [0, 0, 3], target: [0, 0, 0], fov: 40 }, 8, 8);
  return buildNativeInputV2(
    {
      materials,
      instances: materials.map((_, index) => ({ geometry: quadGeometry(index), materialIndex: index })),
      lights: {},
    },
    camera,
    { width: 8, height: 8, samples: 1, ...options },
  );
}

function packMaps(maps, options = {}) {
  return packMaterials(maps.map((map) => ({ color: [1, 1, 1], map })), options);
}

function descriptorWord(input, textureIndex, wordIndex) {
  const stride = STRUCT_STRIDES_V2.textureDescriptor;
  const view = new Uint32Array(input.textureDescriptors.buffer, input.textureDescriptors.byteOffset + textureIndex * stride, stride / 4);
  return view[wordIndex];
}

function mipCountOf(input, textureIndex) {
  return (descriptorWord(input, textureIndex, 3) >>> 8) & 0xff;
}

function kernelFlagsOf(input) {
  return new DataView(input.kernelParams.buffer, input.kernelParams.byteOffset, input.kernelParams.byteLength)
    .getUint32(KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET, true);
}

test('the level count and sizes halve each side down to one texel, rounding down', () => {
  assert.equal(mipLevelCount(1, 1), 1);
  assert.equal(mipLevelCount(2, 2), 2);
  assert.equal(mipLevelCount(16, 4), 5);
  assert.equal(mipLevelCount(5, 3), 3);
  assert.deepEqual(mipLevelSize(16, 4, 1), { width: 8, height: 2 });
  assert.deepEqual(mipLevelSize(16, 4, 3), { width: 2, height: 1 });
  assert.deepEqual(mipLevelSize(16, 4, 4), { width: 1, height: 1 });
  assert.deepEqual(mipLevelSize(5, 3, 1), { width: 2, height: 1 });
  assert.equal(mipChainWordCount(TEXTURE_KIND_RGBA8, 4, 4), 4 + 1);
  assert.equal(mipChainWordCount(TEXTURE_KIND_RGBA32_FLOAT, 4, 4), (4 + 1) * 4);
  assert.throws(() => mipLevelCount(0, 4), /texture side must be an integer from 1/);
});

test('half floats round trip the values a mip average produces', () => {
  for (const value of [0, 1, -1, 0.5, 0.333251953125, 65504, 6.103515625e-5, 5.960464477539063e-8]) {
    assert.equal(halfToFloat(floatToHalf(value)), value);
  }
  assert.equal(floatToHalf(1e9), 0x7c00);
  assert.equal(floatToHalf(-1e9), 0xfc00);
  assert.equal(floatToHalf(1e-9), 0);
  assert.equal(floatToHalf(1.00048828125), floatToHalf(1), 'a tie rounds to the even neighbour');
});

const BLACK_WHITE_CHECKER_4X4 = () => Uint32Array.from(
  { length: 16 },
  (_, index) => ((index % 4) + Math.floor(index / 4)) % 2 === 0 ? packedWord(0, 0, 0, 255) : packedWord(255, 255, 255, 255),
);

function byteOf(word, channel) {
  return (word >>> (channel * 8)) & 0xff;
}

test('level 1 of an 8-bit chain is the mean of the level 0 reconstruction, levels after it are 2 x 2 boxes', () => {
  const chain = buildMipChain(TEXTURE_KIND_RGBA8, BLACK_WHITE_CHECKER_4X4(), 4, 4);
  assert.equal(chain.length, 4 + 1);
  for (let texel = 0; texel < 5; texel++) {
    assert.ok(Math.abs(byteOf(chain[texel], 0) - 127.5) <= 2, `texel ${texel} of the chain is ${byteOf(chain[texel], 0)}`);
    assert.equal(byteOf(chain[texel], 3), 255);
  }
  const rampAlpha = new Uint32Array([packedWord(10, 0, 0, 0), packedWord(10, 0, 0, 255), packedWord(10, 0, 0, 255), packedWord(10, 0, 0, 255)]);
  const alphaChain = buildMipChain(TEXTURE_KIND_RGBA8, rampAlpha, 2, 2);
  assert.ok(Math.abs(byteOf(alphaChain[0], 3) - 191.25) <= 2, 'alpha is the plain mean, not a weight');
  assert.equal(byteOf(alphaChain[0], 0), 10, 'a colour that does not change stays');
});

test('a chain of an uneven or thin texture keeps every level the size the kernel walks to, and a flat colour stays flat', () => {
  const flat = Uint32Array.from({ length: 5 * 3 }, () => packedWord(77, 90, 200, 255));
  const chain = buildMipChain(TEXTURE_KIND_RGBA8, flat, 5, 3);
  assert.equal(chain.length, 2 * 1 + 1 * 1);
  for (const word of chain) {
    assert.equal(word, packedWord(77, 90, 200, 255));
  }
  const thin = buildMipChain(TEXTURE_KIND_RGBA8_SRGB, Uint32Array.from({ length: 8 }, () => packedWord(77, 90, 200, 255)), 8, 1);
  assert.equal(thin.length, 4 + 2 + 1);
  for (const word of thin) {
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(Math.abs(byteOf(word, channel) - [77, 90, 200][channel]) <= 1);
    }
  }
  assert.equal(buildMipChain(TEXTURE_KIND_RGBA8, new Uint32Array(1), 1, 1).length, 0);
});

test('a float chain keeps the energy of a bright texel and does not clamp', () => {
  const level0 = new Float32Array([8, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const chain = buildMipChain(TEXTURE_KIND_RGBA32_FLOAT, level0, 2, 2);
  assert.equal(chain.length, 4);
  const mean = Array.from(new Float32Array(chain.buffer, chain.byteOffset, 4));
  assert.ok(Math.abs(mean[0] - 2) < 1e-5 && mean[1] === 0 && Math.abs(mean[3] - 1) < 1e-6, `mean texel ${mean}`);
});

test('a two-channel half chain takes the mean of each channel as a float', () => {
  const pair = (red, green) => (floatToHalf(red) | (floatToHalf(green) << 16)) >>> 0;
  const level0 = new Uint32Array([pair(1, 0), pair(0, 0), pair(0, 0.5), pair(0, 0)]);
  const chain = buildMipChain(TEXTURE_KIND_RG16_FLOAT, level0, 2, 2);
  assert.ok(Math.abs(halfToFloat(chain[0] & 0xffff) - 0.25) < 1e-3);
  assert.ok(Math.abs(halfToFloat(chain[0] >>> 16) - 0.125) < 1e-3);
});

test('the wrap mode reaches level 1: a clamped edge does not read the opposite side', () => {
  const level0 = Uint32Array.from({ length: 4 * 4 }, (_, index) => (index % 4 === 0 ? packedWord(255, 0, 0, 255) : packedWord(0, 0, 0, 255)));
  const repeated = buildMipChain(TEXTURE_KIND_RGBA8, level0, 4, 4, 0, 0);
  const clamped = buildMipChain(TEXTURE_KIND_RGBA8, level0, 4, 4, 1, 1);
  assert.notEqual(byteOf(repeated[1], 0), byteOf(clamped[1], 0), 'the right half sees the red column on its far side only when it repeats');
});

function decodeSrgbByte(byteValue) {
  const encoded = byteValue / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

function linearMeanOfLevels(chain, side) {
  const means = [];
  let cursor = 0;
  for (let level = 1; level < mipLevelCount(side, side); level++) {
    const texelCount = mipLevelSize(side, side, level).width ** 2;
    let total = 0;
    for (let index = 0; index < texelCount; index++) {
      total += decodeSrgbByte(chain[cursor + index] & 0xff);
    }
    means.push(total / texelCount);
    cursor += texelCount;
  }
  return means;
}

// The kernel reads level 0 by blending the stored values and decoding the blend; this is its mean over a fine grid, repeat wrap.
function reconstructionLinearMean(words, side) {
  const stored = (column, row) => (words[(((row % side) + side) % side) * side + (((column % side) + side) % side)] & 0xff) / 255;
  const steps = 8;
  let total = 0;
  for (let sampleRow = 0; sampleRow < side * steps; sampleRow++) {
    for (let sampleColumn = 0; sampleColumn < side * steps; sampleColumn++) {
      const x = (sampleColumn + 0.5) / steps - 0.5;
      const y = (sampleRow + 0.5) / steps - 0.5;
      const left = Math.floor(x);
      const top = Math.floor(y);
      const blendX = x - left;
      const blendY = y - top;
      const upper = stored(left, top) * (1 - blendX) + stored(left + 1, top) * blendX;
      const lower = stored(left, top + 1) * (1 - blendX) + stored(left + 1, top + 1) * blendX;
      const value = upper * (1 - blendY) + lower * blendY;
      total += value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }
  }
  return total / (side * side * steps * steps);
}

test('a uniform mid grey keeps its linear value within half a code at every level of an sRGB chain', () => {
  for (const grey of [30, 77, 128, 200]) {
    const side = 32;
    const chain = buildMipChain(TEXTURE_KIND_RGBA8_SRGB, new Uint32Array(side * side).fill(packedWord(grey, grey, grey, 255)), side, side);
    for (const word of chain) {
      assert.equal(word & 0xff, grey, 'a flat colour is the same byte at every level, no drift down');
    }
  }
});

test('the levels of a random sRGB texture keep the mean light of the level 0 reconstruction, with no downward trend', () => {
  let seed = 12345;
  const nextByte = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return 60 + (seed >>> 24) % 181;
  };
  const side = 32;
  const words = Uint32Array.from({ length: side * side }, () => {
    const value = nextByte();
    return packedWord(value, value, value, 255);
  });
  const expected = reconstructionLinearMean(words, side);
  const means = linearMeanOfLevels(buildMipChain(TEXTURE_KIND_RGBA8_SRGB, words, side, side), side);
  const relativeErrors = means.map((mean) => (mean - expected) / expected);
  for (const [index, error] of relativeErrors.entries()) {
    assert.ok(Math.abs(error) < 0.005, `level ${index + 1} mean is ${(error * 100).toFixed(2)} percent off the reconstruction mean`);
  }
  const averageError = relativeErrors.reduce((sum, error) => sum + error, 0) / relativeErrors.length;
  assert.ok(averageError > -0.003, `the levels do not drift down together: average ${(averageError * 100).toFixed(2)} percent`);
});

test('without textureMips a texture is level 0 only, the flag is clear and the pool is as it was', () => {
  const image = byteImage(8, 8, (x, y) => [x * 30, y * 30, 7, 255]);
  const byDefault = packMaps([{ image }]);
  const explicitOff = packMaps([{ image }], { textureMips: false });
  assert.equal(mipCountOf(byDefault, 0), 1);
  assert.equal(byDefault.textureTexels.length, 64);
  assert.equal(kernelFlagsOf(byDefault) & KERNEL_FLAG_TEXTURE_MIPS, 0);
  assert.deepEqual(explicitOff.textureTexels, byDefault.textureTexels);
  assert.deepEqual(explicitOff.textureDescriptors, byDefault.textureDescriptors);
  assert.deepEqual(explicitOff.kernelParams, byDefault.kernelParams);
});

test('textureMips stores the chain after level 0, counts the levels in the descriptor and sets the kernel flag', () => {
  const image = byteImage(8, 8, () => [40, 80, 120, 255]);
  const off = packMaps([{ image, colorSpace: 'linear' }]);
  const on = packMaps([{ image, colorSpace: 'linear' }], { textureMips: true });
  assert.equal(KERNEL_FLAG_TEXTURE_MIPS, 2048);
  assert.equal(mipCountOf(on, 0), 4);
  assert.equal(kernelFlagsOf(on) & KERNEL_FLAG_TEXTURE_MIPS, KERNEL_FLAG_TEXTURE_MIPS);
  assert.equal(kernelFlagsOf(on) & ~KERNEL_FLAG_TEXTURE_MIPS, kernelFlagsOf(off));
  assert.equal(on.textureTexels.length, 64 + 16 + 4 + 1 + 3, 'padded once to four words at the end');
  assert.deepEqual(on.textureTexels.subarray(0, 64), off.textureTexels.subarray(0, 64), 'level 0 is untouched');
  for (const wordIndex of [64, 64 + 15, 64 + 16, 64 + 19, 64 + 20]) {
    assert.equal(on.textureTexels[wordIndex], packedWord(40, 80, 120, 255), `word ${wordIndex}: every level of a flat map is that colour, stored right after level 0`);
  }
});

test('an sRGB chain stores bytes of the mean light: level 1 integrates the reconstruction, which is darker than a box of decoded texels', () => {
  const chain = buildMipChain(TEXTURE_KIND_RGBA8_SRGB, BLACK_WHITE_CHECKER_4X4(), 4, 4);
  const level1 = byteOf(chain[0], 0);
  assert.ok(level1 >= 130 && level1 <= 145, `level 1 holds byte ${level1}: the mean of the decoded blend of black and white, near 137`);
  assert.ok(level1 < 188, 'the box of decoded texels would give the byte 188');
  assert.equal(byteOf(chain[0], 3), 255);
  const grey = buildMipChain(TEXTURE_KIND_RGBA8_SRGB, new Uint32Array(4).fill(packedWord(77, 77, 77, 255)), 2, 2);
  assert.ok(Math.abs(byteOf(grey[0], 0) - 77) <= 1, 'a flat colour survives the round trip');
});

test('an sRGB map keeps its format at every level', () => {
  const checker = byteImage(4, 4, (x, y) => ((x + y) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const input = packMaps([{ image: checker, colorSpace: 'srgb' }], { textureMips: true });
  assert.equal(descriptorWord(input, 0, 3) & 0xff, FORMAT_RGBA8_SRGB);
  const level1 = byteOf(input.textureTexels[16], 0);
  assert.ok(level1 >= 130 && level1 <= 145, `level 1 byte ${level1}`);
});

test('mips are per texture too: mips true on one map, false on another, and nearest maps never take levels', () => {
  const image = byteImage(8, 8, () => [10, 20, 30, 255]);
  const mixed = packMaps([{ image, mips: true }, { image: byteImage(8, 8, () => [1, 2, 3, 255]), mips: false }]);
  assert.equal(mipCountOf(mixed, 0), 4);
  assert.equal(mipCountOf(mixed, 1), 1);
  assert.equal(kernelFlagsOf(mixed) & KERNEL_FLAG_TEXTURE_MIPS, KERNEL_FLAG_TEXTURE_MIPS);
  const overridden = packMaps([{ image, mips: false }], { textureMips: true });
  assert.equal(mipCountOf(overridden, 0), 1);
  assert.equal(kernelFlagsOf(overridden) & KERNEL_FLAG_TEXTURE_MIPS, 0, 'no texture stores levels, so the kernel carries no footprint');
  const nearest = packMaps([{ image, nearest: true }], { textureMips: true });
  assert.equal(mipCountOf(nearest, 0), 1);
  const single = packMaps([{ image: byteImage(1, 1, () => [9, 9, 9, 255]) }], { textureMips: true });
  assert.equal(mipCountOf(single, 0), 1);
});

test('one image with and without levels stays two descriptors, and the uv transform stays in the key', () => {
  const image = byteImage(8, 8, () => [5, 5, 5, 255]);
  const split = packMaps([{ image, mips: true }, { image, mips: false }]);
  assert.equal(split.textureCount, 2);
  const same = packMaps([{ image }, { image }], { textureMips: true });
  assert.equal(same.textureCount, 1);
  const scaled = packMaps([{ image, uvScale: [2, 2] }, { image }], { textureMips: true });
  assert.equal(scaled.textureCount, 2);
  const offset = packMaps([{ image, uvOffset: [0.5, 0] }, { image }], { textureMips: true });
  assert.equal(offset.textureCount, 2);
  const wrapped = packMaps([{ image, wrapU: 1 }, { image }], { textureMips: true });
  assert.equal(wrapped.textureCount, 2);
});

test('float and half textures are packed in their own formats, with levels on request', () => {
  const floatData = new Float32Array(4 * 4 * 4).fill(0.5);
  floatData.set([12, 6, 3, 1], 0);
  const halfData = new Uint16Array(4 * 4 * 2).fill(floatToHalf(0.25));
  const input = packMaterials(
    [
      { color: [0, 0, 0], emissiveTexture: { image: { width: 4, height: 4, data: floatData } } },
      { color: [1, 1, 1], normalMap: { image: { width: 4, height: 4, data: halfData } } },
    ],
    { textureMips: true },
  );
  assert.equal(input.textureCount, 2);
  assert.equal(descriptorWord(input, 0, 3) & 0xff, FORMAT_RGBA32_FLOAT);
  assert.equal(descriptorWord(input, 1, 3) & 0xff, FORMAT_RG16_FLOAT);
  assert.equal(mipCountOf(input, 0), 3);
  const floatTexels = new Float32Array(input.textureTexels.buffer, input.textureTexels.byteOffset, 64 + 16 + 4);
  assert.deepEqual(Array.from(floatTexels.subarray(0, 4)), [12, 6, 3, 1], 'an HDR texel is stored unclamped');
  const levelOneRed = [0, 1, 2, 3].map((texel) => floatTexels[64 + texel * 4]);
  assert.ok(Math.max(...levelOneRed) > 1, 'the texel that sees the bright one is above one');
  const levelOneMean = levelOneRed.reduce((sum, value) => sum + value, 0) / 4;
  assert.ok(Math.abs(levelOneMean - (12 + 15 * 0.5) / 16) < 1e-4, `level 1 keeps the energy of level 0: ${levelOneMean}`);
  const halfStart = descriptorWord(input, 1, 0);
  assert.ok(Math.abs(halfToFloat(input.textureTexels[halfStart + 16] & 0xffff) - 0.25) < 1e-3);
});

test('textureMips and mips fail at the boundary with what to pass', () => {
  const image = byteImage(4, 4, () => [1, 1, 1, 255]);
  assert.throws(() => packMaps([{ image }], { textureMips: 'yes' }), (error) => {
    assert.ok(error instanceof TypeError);
    assert.match(error.message, /`textureMips` must be true \(store mip levels\), false or left out/);
    assert.match(error.message, /got "yes"/);
    return true;
  });
  assert.throws(() => packMaps([{ image, mips: 1 }]), /`mips` must be true/);
});

test('the pool budget counts the mip levels', () => {
  // 16384 x 16384 bytes-per-texel 4 is exactly the 1 GiB pool: level 0 alone would fit, the chain on top of it does not.
  const side = 16384;
  assert.equal(side * side * 4, TEXTURE_POOL_MAX_BYTES);
  assert.equal(mipChainWordCount(TEXTURE_KIND_RGBA8, side, side), (side * side - 1) / 3, 'the chain adds a third of level 0');
  const oversize = { width: side, height: side, data: new Uint8Array(4) };
  assert.throws(
    () => packMaps([{ image: oversize, mips: true }]),
    (error) => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /texture pool is full: the 16384x16384 texture needs 1366 MiB/);
      return true;
    },
  );
});

// ---- GPU-gated: the kernel reads the levels ----

const gpuSkip = { skip: !findNativeAddon() };

test('a magnified texture reads level 0 with mip levels on, to the last bit', gpuSkip, async () => {
  const { renderFloor, maxAbsoluteDifference } = await import('../bench/cycles-parity/texture-mips-bench.mjs');
  const settings = { cameraName: 'magnified', samples: 4, seed: 3, width: 48, height: 27 };
  const withoutMips = renderFloor({ ...settings, textureMips: false });
  const withMips = renderFloor({ ...settings, textureMips: true });
  assert.equal(maxAbsoluteDifference(withoutMips, withMips), 0);
});

test('a minified checker reads other levels with mip levels on, and stays finite', gpuSkip, async () => {
  const { renderFloor, maxAbsoluteDifference } = await import('../bench/cycles-parity/texture-mips-bench.mjs');
  const settings = { cameraName: 'receding', width: 96, height: 54, samples: 16, seed: 5 };
  const withoutMips = renderFloor({ ...settings, textureMips: false });
  const withMips = renderFloor({ ...settings, textureMips: true });
  assert.ok(withMips.every(Number.isFinite));
  assert.ok(maxAbsoluteDifference(withoutMips, withMips) > 0.01, 'the far floor is read at a coarser level');
});

test('an HDR float emissive map keeps values above one through the kernel, with and without levels', gpuSkip, () => {
  const size = 9;
  const camera = createCamera({ eye: [0, 0, 2.2], target: [0, 0, 0], fov: 30 }, size, size);
  const texelValue = 4;
  const hdrData = new Float32Array(4 * 4 * 4);
  for (let texel = 0; texel < 16; texel++) {
    hdrData.set([texelValue, texelValue * 0.5, texelValue * 0.25, 1], texel * 4);
  }
  for (const textureMips of [false, true]) {
    const options = { width: size, height: size, samples: 4, textureMips };
    const input = buildNativeInputV2(
      {
        materials: [{ color: [0, 0, 0], emissionStrength: 1, emissionColor: [1, 1, 1], emissiveTexture: { image: { width: 4, height: 4, data: hdrData } } }],
        instances: [{ geometry: quadGeometry(0), materialIndex: 0 }],
        lights: {},
      },
      camera,
      options,
    );
    assert.equal(descriptorWord(input, 0, 3) & 0xff, FORMAT_RGBA32_FLOAT);
    const result = traceNative(input, { ...options, kernel: 'cycles' });
    const centrePixel = Math.floor(size / 2) * size + Math.floor(size / 2);
    assert.ok(Math.abs(result.rgba[centrePixel * 4] - texelValue) < 0.05, `centre red ${result.rgba[centrePixel * 4]} (levels ${textureMips})`);
    assert.ok(Math.abs(result.rgba[centrePixel * 4 + 1] - texelValue * 0.5) < 0.05);
  }
});

test('the level follows the footprint with no half level of bias: one texel per pixel reads level 0, two texels per pixel level 1', gpuSkip, () => {
  const size = 32;
  const fieldOfView = 30;
  const distance = 2 / Math.tan(fieldOfView * Math.PI / 360);
  const camera = createCamera({ eye: [0, 0, distance], target: [0, 0, 0], fov: fieldOfView }, size, size);
  const spread = (texelsPerSide) => {
    const checker = new Float32Array(texelsPerSide * texelsPerSide * 4);
    for (let texel = 0; texel < texelsPerSide * texelsPerSide; texel++) {
      const value = ((texel % texelsPerSide) + Math.floor(texel / texelsPerSide)) % 2 === 0 ? 0 : 1;
      checker.set([value, value, value, 1], texel * 4);
    }
    const options = { width: size, height: size, samples: 1, textureMips: true };
    const input = buildNativeInputV2(
      {
        materials: [{ color: [0, 0, 0], emissionStrength: 1, emissionColor: [1, 1, 1], emissiveTexture: { image: { width: texelsPerSide, height: texelsPerSide, data: checker } } }],
        instances: [{ geometry: quadGeometry(0), materialIndex: 0 }],
        lights: {},
      },
      camera,
      options,
    );
    const result = traceNative(input, { ...options, kernel: 'cycles' });
    const centre = [];
    for (let row = 14; row < 18; row++) {
      for (let column = 14; column < 18; column++) {
        centre.push(result.rgba[(row * size + column) * 4]);
      }
    }
    return { minimum: Math.min(...centre), maximum: Math.max(...centre) };
  };
  // The quad is 16 pixels wide at its centre. 32 texels across it: 2 texels per pixel, level 1, the flat mean of the checker.
  const twoTexels = spread(32);
  assert.ok(twoTexels.maximum - twoTexels.minimum < 0.02, 'level 1 is flat: ' + JSON.stringify(twoTexels));
  assert.ok(Math.abs(twoTexels.minimum - 0.5) < 0.02);
  // 16 texels across it: 1 texel per pixel, level 0, the checker itself.
  const oneTexel = spread(16);
  assert.ok(oneTexel.maximum - oneTexel.minimum > 0.3, 'level 0 keeps the checker: ' + JSON.stringify(oneTexel));
});

test('a contrasty sRGB map read at level 1 gives the linear mean of the stored level 1 texels, not a blend of stored values', gpuSkip, () => {
  const size = 32;
  const fieldOfView = 30;
  const distance = 2 / Math.tan(fieldOfView * Math.PI / 360);
  const camera = createCamera({ eye: [0, 0, distance], target: [0, 0, 0], fov: fieldOfView }, size, size);
  const levelZeroSide = 4;
  const image = byteImage(levelZeroSide, levelZeroSide, (column, row) => {
    const isLight = (column * 7 + row * 13 + column * row) % 3 === 0;
    return isLight ? [235, 235, 235, 255] : [20, 20, 20, 255];
  });
  const words = new Uint32Array(image.data.buffer, 0, levelZeroSide * levelZeroSide);
  const levelOne = buildMipChain(TEXTURE_KIND_RGBA8_SRGB, words, levelZeroSide, levelZeroSide).subarray(0, 4);
  const expectedMean = Array.from(levelOne).reduce((sum, word) => sum + decodeSrgbByte(word & 0xff), 0) / 4;
  // 8 repeats of the 4 x 4 map across the 16 pixels of the quad: 2 texels per pixel, so level 1, one level 1 texel per pixel.
  const options = { width: size, height: size, samples: 1, textureMips: true };
  const input = buildNativeInputV2(
    {
      materials: [{ color: [0, 0, 0], emissionStrength: 1, emissionColor: [1, 1, 1], emissiveTexture: { image, colorSpace: 'srgb', uvScale: [8, 8] } }],
      instances: [{ geometry: quadGeometry(0), materialIndex: 0 }],
      lights: {},
    },
    camera,
    options,
  );
  assert.equal(descriptorWord(input, 0, 3) & 0xff, FORMAT_RGBA8_SRGB);
  assert.equal(mipCountOf(input, 0), 3);
  const result = traceNative(input, { ...options, kernel: 'cycles' });
  let total = 0;
  for (let row = 10; row < 22; row++) {
    for (let column = 10; column < 22; column++) {
      total += result.rgba[(row * size + column) * 4];
    }
  }
  const pictureMean = total / 144;
  assert.ok(Math.abs(pictureMean - expectedMean) / expectedMean < 0.01, `picture mean ${pictureMean} against the linear mean ${expectedMean} of the level 1 texels`);
});

// The tables a scene packs to with mip levels off, as SHA-256 taken on main before the levels existed (#896): the default
// must not move a byte of the texture descriptors, the texel pool, the kernel parameters or the material records.
test('with mip levels off the packed tables are the bytes main packed before the levels existed', async () => {
  const { createHash } = await import('node:crypto');
  const materials = [
    { color: [1, 1, 1], map: { image: byteImage(6, 5, (x, y) => [x * 40, y * 50, 7, 255]) } },
    { color: [1, 1, 1], map: { image: byteImage(8, 8, (x, y) => [x * 30, y * 30, 90, 200]), colorSpace: 'linear' }, alphaMode: 'mask', alphaCutoff: 0.5 },
    { color: [0, 0, 0], emission: 1, emissiveColor: [1, 1, 1], emissiveMap: { image: byteImage(3, 3, (x, y) => [x * 100, y * 100, 255, 255]), colorSpace: 'srgb' } },
  ];
  const sharedGeometry = quadGeometry(0);
  const camera = createCamera({ eye: [0, 0, 3], target: [0, 0, 0], fov: 40 }, 16, 16);
  const input = buildNativeInputV2(
    { materials, instances: materials.map((material, index) => ({ geometry: sharedGeometry, materialIndex: index })), lights: {} },
    camera,
    { width: 16, height: 16, samples: 4 },
  );
  const expected = {
    textureDescriptors: '402bc427be8bb0c8813f31b93db3db427aecd03310a86eaedd571d26d2a80db3',
    textureTexels: '020b6aa192172d87214eae6b2fc9604ef6174b5583ad6fbf1c6991d483f424ab',
    kernelParams: '582db4072d736a1dfb749a2eeeac2ab47fa64093cb4a26f6f99a4ef41dec9a12',
    materials: '65bd6ad01f6045e2cb0af51bf496358bb318101e21c72627fb34e13b4374ac94',
  };
  for (const [tableName, expectedHash] of Object.entries(expected)) {
    const table = input[tableName];
    const hash = createHash('sha256').update(Buffer.from(table.buffer, table.byteOffset, table.byteLength)).digest('hex');
    assert.equal(hash, expectedHash, tableName);
  }
});

// A level of odd side halves to floor(side / 2) texels, so each destination texel covers two and a fraction source texels.
// Every source texel must reach the next level: a 6 x 6 map has a 3 x 3 level 1 and a 1 x 1 level 2 that is the mean of all nine.
test('a level with an odd side reaches the next level whole, not without its last row and column', () => {
  const rightThirdWhite = new Uint32Array(36);
  for (let texel = 0; texel < 36; texel++) {
    const value = texel % 6 >= 4 ? 255 : 0;
    rightThirdWhite[texel] = packedWord(value, value, value, 255);
  }
  const chain = buildMipChain(TEXTURE_KIND_RGBA8, rightThirdWhite, 6, 6);
  assert.equal(chain.length, 9 + 1);
  let levelOneSum = 0;
  for (let texel = 0; texel < 9; texel++) levelOneSum += chain[texel] & 0xff;
  const levelTwoRed = chain[9] & 0xff;
  assert.ok(levelOneSum > 0, 'level 1 holds the white third');
  assert.ok(Math.abs(levelTwoRed - levelOneSum / 9) <= 1, `level 2 is ${levelTwoRed}, the mean of level 1 is ${(levelOneSum / 9).toFixed(1)}`);
});
