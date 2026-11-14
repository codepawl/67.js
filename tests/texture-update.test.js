import assert from 'node:assert/strict';
import test from 'node:test';
import { CrucibleRenderer } from '../src/renderer.js';
import { textureRegionOffset, validateTextureRegion } from '../src/texture-update.js';

const MAX_TEXTURE_SIZE = 4096;

/** A WebGL2 stand-in that records texture calls and unpack state. */
function fakeRenderer(descriptor) {
  const calls = [];
  const state = { flipY: false, premultiply: true, colorSpace: 7, binding: 'previous' };
  const context = {
    TEXTURE_2D: 3553, RGBA: 6408, UNSIGNED_BYTE: 5121, NONE: 0, MAX_TEXTURE_SIZE: 1, TEXTURE_BINDING_2D: 2,
    UNPACK_FLIP_Y_WEBGL: 10, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 11, UNPACK_COLORSPACE_CONVERSION_WEBGL: 12,
    getParameter: name => ({ 1: MAX_TEXTURE_SIZE, 2: state.binding, 10: state.flipY, 11: state.premultiply, 12: state.colorSpace })[name],
    pixelStorei: (name, value) => {
      calls.push(['pixelStorei', name, value]);
      if (name === 10) state.flipY = value;
      if (name === 11) state.premultiply = value;
      if (name === 12) state.colorSpace = value;
    },
    bindTexture: (target, texture) => { calls.push(['bindTexture', texture]); state.binding = texture; },
    texSubImage2D: (...args) => calls.push(['texSubImage2D', ...args.slice(1), state.flipY, state.premultiply, state.colorSpace]),
    generateMipmap: () => calls.push(['generateMipmap']),
  };
  const renderer = Object.create(CrucibleRenderer.prototype);
  renderer.context = context;
  renderer.textures = new Map([[descriptor, 'texture']]);
  return { renderer, calls, state };
}

const bytes = (width, height) => new Uint8Array(width * height * 4);
const image = (width, height) => ({ width, height });

test('region validation names the problem', () => {
  const good = { x: 2, y: 4, width: 3, height: 2, data: bytes(3, 2) };
  assert.doesNotThrow(() => validateTextureRegion(good, 8, 8));
  assert.throws(() => validateTextureRegion({ ...good, x: 1.5 }, 8, 8), /region\.x must be an integer/);
  assert.throws(() => validateTextureRegion({ ...good, width: 0, data: bytes(0, 2) }, 8, 8), /does not fit the 8x8 texture/);
  assert.throws(() => validateTextureRegion({ ...good, x: -1 }, 8, 8), /does not fit/);
  assert.throws(() => validateTextureRegion({ ...good, x: 6 }, 8, 8), /3x2 at 6,4 does not fit/);
  assert.throws(() => validateTextureRegion({ ...good, y: 7 }, 8, 8), /does not fit/);
  assert.throws(() => validateTextureRegion({ ...good, data: bytes(3, 1) }, 8, 8), /has 12 bytes, expected 24/);
  assert.throws(() => validateTextureRegion({ ...good, data: new Float32Array(24) }, 8, 8), /Uint8Array or Uint8ClampedArray/);
  assert.throws(() => validateTextureRegion(undefined, 8, 8), /must be an integer/);
  assert.doesNotThrow(() => validateTextureRegion({ ...good, data: new Uint8ClampedArray(24) }, 8, 8));
});

test('region rows follow the flipY of the first upload', () => {
  const region = { x: 3, y: 1, width: 2, height: 2 };
  assert.deepEqual(textureRegionOffset(region, 8, false), { x: 3, y: 1 });
  assert.deepEqual(textureRegionOffset(region, 8, true), { x: 3, y: 5 });
  assert.deepEqual(textureRegionOffset({ x: 0, y: 0, width: 8, height: 8 }, 8, true), { x: 0, y: 0 });
});

test('a region upload binds, sets unpack state, restores it and regenerates mipmaps', () => {
  const descriptor = { image: image(8, 8), flipY: true };
  const { renderer, calls, state } = fakeRenderer(descriptor);
  const data = bytes(2, 2);
  renderer.updateTexture(descriptor, { region: { x: 1, y: 1, width: 2, height: 2, data } });
  assert.deepEqual(calls.find(call => call[0] === 'texSubImage2D'), ['texSubImage2D', 0, 1, 5, 2, 2, 6408, 5121, data, true, false, 0]);
  assert.equal(calls.at(-1)[0], 'bindTexture');
  assert.equal(calls.filter(call => call[0] === 'generateMipmap').length, 1);
  assert.deepEqual({ ...state }, { flipY: false, premultiply: true, colorSpace: 7, binding: 'previous' });
});

test('a texture without mipmaps is not regenerated', () => {
  const descriptor = { image: image(8, 8), minFilter: 9729 };
  const { renderer, calls } = fakeRenderer(descriptor);
  renderer.updateTexture(descriptor, { region: { x: 0, y: 0, width: 1, height: 1, data: bytes(1, 1) } });
  assert.equal(calls.some(call => call[0] === 'generateMipmap'), false);
});

test('a whole image upload takes update.image or the descriptor image again', () => {
  const descriptor = { image: image(8, 8) };
  const { renderer, calls } = fakeRenderer(descriptor);
  const replacement = image(8, 8);
  renderer.updateTexture(descriptor, { image: replacement });
  renderer.updateTexture(descriptor);
  const uploads = calls.filter(call => call[0] === 'texSubImage2D');
  assert.equal(uploads[0][6], replacement);
  assert.equal(uploads[1][6], descriptor.image);
  assert.deepEqual(uploads[0].slice(1, 4), [0, 0, 0]);
});

test('unusable updates fail with a clear message and leave the unpack state alone', () => {
  const descriptor = { image: image(8, 8) };
  const { renderer, calls } = fakeRenderer(descriptor);
  assert.throws(() => renderer.updateTexture({ image: image(8, 8) }), /already uploaded/);
  assert.throws(() => renderer.updateTexture(null), /already uploaded/);
  assert.throws(() => renderer.updateTexture(descriptor, { image: image(4, 8) }), /must be 8x8 like the uploaded texture/);
  assert.throws(() => renderer.updateTexture(descriptor, { image: image(8, 8), region: { x: 0, y: 0, width: 1, height: 1, data: bytes(1, 1) } }), /image or region, not both/);
  assert.throws(() => renderer.updateTexture(descriptor, { region: { x: 7, y: 7, width: 2, height: 2, data: bytes(2, 2) } }), /does not fit the 8x8 texture/);
  assert.equal(calls.length, 0);
});

test('compressed textures reject updates', () => {
  const descriptor = { image: { width: 8, height: 8, compressed: { bytes: 32 } } };
  const { renderer, calls } = fakeRenderer(descriptor);
  assert.throws(() => renderer.updateTexture(descriptor), /Compressed textures cannot be updated/);
  assert.equal(calls.length, 0);
});
