import assert from 'node:assert/strict';
import test from 'node:test';
import { ktx2WorkerConfigFor, describeCompressedImage } from '../src/compressed-texture.js';
import { CrucibleRenderer, textureDescriptorInfo } from '../src/renderer.js';

const BC7 = 0x8e8c;
const BC7_SRGB = 0x8e8d;
const BC3 = 0x83f3;
const ETC2_RGBA = 0x9278;

/** A WebGL2 stand-in that exposes only the named extensions and records the texture calls. */
function fakeContext(extensionNames) {
  const calls = [];
  return {
    calls,
    TEXTURE_2D: 3553,
    getExtension: name => (extensionNames.includes(name) ? {} : null),
    texStorage2D: (...args) => calls.push(['texStorage2D', ...args]),
    compressedTexSubImage2D: (target, level, x, y, width, height, format, data) => calls.push(['compressedTexSubImage2D', level, width, height, format, data.length]),
  };
}

function uploadLevels(context, image) {
  image.compressed.upload(context);
}

function bc7Levels() {
  return [8, 4, 2, 1].map(size => ({ width: size, height: size, data: new Uint8Array(Math.ceil(size / 4) ** 2 * 16) }));
}

test('the KTX2 worker config follows the extensions the context exposes', () => {
  const none = ktx2WorkerConfigFor(fakeContext([]));
  assert.deepEqual(Object.values(none).filter(Boolean), []);
  const desktop = ktx2WorkerConfigFor(fakeContext(['EXT_texture_compression_bptc', 'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb']));
  assert.equal(desktop.bptcSupported, true);
  assert.equal(desktop.dxtSupported, true);
  assert.equal(desktop.astcSupported, false);
  const s3tcOnly = ktx2WorkerConfigFor(fakeContext(['WEBGL_compressed_texture_s3tc']));
  assert.equal(s3tcOnly.dxtSupported, false);
  const mobile = ktx2WorkerConfigFor(fakeContext(['WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc']));
  assert.equal(mobile.astcSupported, true);
  assert.equal(mobile.etc2Supported, true);
});

test('a compressed image uploads each mip level into immutable storage', () => {
  const image = describeCompressedImage(BC7, bc7Levels(), 'map', 'srgb');
  const context = fakeContext(['EXT_texture_compression_bptc']);
  uploadLevels(context, image);
  assert.deepEqual(context.calls[0], ['texStorage2D', 3553, 4, BC7_SRGB, 8, 8]);
  assert.deepEqual(context.calls.slice(1).map(call => call.slice(0, 5)), [
    ['compressedTexSubImage2D', 0, 8, 8, BC7_SRGB],
    ['compressedTexSubImage2D', 1, 4, 4, BC7_SRGB],
    ['compressedTexSubImage2D', 2, 2, 2, BC7_SRGB],
    ['compressedTexSubImage2D', 3, 1, 1, BC7_SRGB],
  ]);
});

test('a linear map uploads the linear format', () => {
  const image = describeCompressedImage(BC7, bc7Levels(), 'normalMap', 'linear');
  const context = fakeContext(['EXT_texture_compression_bptc']);
  uploadLevels(context, image);
  assert.equal(context.calls[0][3], BC7);
});

test('a context without the extension refuses the upload and names it', () => {
  const image = describeCompressedImage(BC7, bc7Levels(), 'map', 'srgb');
  assert.throws(() => uploadLevels(fakeContext([]), image), /EXT_texture_compression_bptc/);
});

test('an sRGB DXT map needs the sRGB S3TC extension', () => {
  const levels = [{ width: 4, height: 4, data: new Uint8Array(16) }];
  const srgb = describeCompressedImage(BC3, levels, 'map', 'srgb');
  assert.throws(() => uploadLevels(fakeContext(['WEBGL_compressed_texture_s3tc']), srgb), /s3tc_srgb/);
  const linear = describeCompressedImage(BC3, levels, 'map', 'linear');
  uploadLevels(fakeContext(['WEBGL_compressed_texture_s3tc']), linear);
});

test('block compressed levels must match their size and DXT must be a multiple of four', () => {
  assert.throws(() => describeCompressedImage(BC7, [{ width: 8, height: 8, data: new Uint8Array(10) }], 'map'), /does not match/);
  assert.throws(() => describeCompressedImage(BC3, [{ width: 6, height: 6, data: new Uint8Array(64) }], 'map'), /multiples of 4/);
  describeCompressedImage(ETC2_RGBA, [{ width: 6, height: 6, data: new Uint8Array(64) }], 'map');
});

test('compressed bytes feed the renderer texture budget and a single level drops mip filtering', () => {
  const full = describeCompressedImage(BC7, bc7Levels(), 'map', 'srgb');
  const info = textureDescriptorInfo({ image: full });
  assert.equal(info.bytes, 112);
  assert.equal(info.mipmaps, false);
  assert.equal(info.minFilter, 9987);
  const single = describeCompressedImage(BC7, bc7Levels().slice(0, 1), 'map', 'srgb');
  assert.equal(textureDescriptorInfo({ image: single }).minFilter, 9729);
  assert.equal(textureDescriptorInfo({ image: single, minFilter: 9984 }).minFilter, 9728);
});

test('createTexture uploads a compressed image without generating mips', () => {
  const calls = [];
  const context = {
    TEXTURE_2D: 3553,
    NONE: 0,
    UNPACK_FLIP_Y_WEBGL: 1,
    UNPACK_COLORSPACE_CONVERSION_WEBGL: 2,
    MAX_TEXTURE_SIZE: 3,
    TEXTURE_WRAP_S: 4,
    TEXTURE_WRAP_T: 5,
    TEXTURE_MIN_FILTER: 6,
    TEXTURE_MAG_FILTER: 7,
    getParameter: () => 4096,
    createTexture: () => ({}),
    bindTexture: () => {},
    pixelStorei: () => {},
    texParameteri: () => {},
    generateMipmap: () => calls.push('generateMipmap'),
    texImage2D: () => calls.push('texImage2D'),
    getExtension: name => (name === 'EXT_texture_compression_bptc' ? {} : null),
    texStorage2D: () => calls.push('texStorage2D'),
    compressedTexSubImage2D: () => calls.push('compressedTexSubImage2D'),
  };
  const map = { image: describeCompressedImage(BC7, bc7Levels(), 'map', 'srgb'), colorSpace: 'srgb' };
  const renderer = { context, textures: new Map(), applyAnisotropy: () => calls.push('anisotropy') };
  CrucibleRenderer.prototype.createTexture.call(renderer, map);
  assert.deepEqual(calls, ['texStorage2D', 'compressedTexSubImage2D', 'compressedTexSubImage2D', 'compressedTexSubImage2D', 'compressedTexSubImage2D']);
});
