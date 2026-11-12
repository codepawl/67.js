import assert from 'node:assert/strict';
import test from 'node:test';
import { planRowSlices, sliceDestinationRow, uploadTextureInSlices, TEXTURE_SLICE_BYTES } from '../src/texture-upload.js';
import { withDevServerPage } from './helpers/dev-server-browser.js';

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test('row slices cover every row once, in order, each within the byte bound', () => {
  const random = seededRandom(779);
  for (let trial = 0; trial < 200; trial++) {
    const height = 1 + Math.floor(random() * 5000);
    const bytesPerRow = 4 * (1 + Math.floor(random() * 4096));
    const maximumBytes = 1 + Math.floor(random() * 4 * TEXTURE_SLICE_BYTES);
    const slices = planRowSlices(height, bytesPerRow, maximumBytes);
    let nextRow = 0;
    for (const slice of slices) {
      assert.equal(slice.firstRow, nextRow);
      assert.ok(slice.rowCount >= 1);
      assert.ok(slice.rowCount * bytesPerRow <= Math.max(maximumBytes, bytesPerRow), 'a band stays within the bound unless one row alone exceeds it');
      nextRow += slice.rowCount;
    }
    assert.equal(nextRow, height);
  }
});

test('a texture that fits the bound is one band, and bad input is refused', () => {
  assert.deepEqual(planRowSlices(64, 256, TEXTURE_SLICE_BYTES), [{ firstRow: 0, rowCount: 64 }]);
  assert.deepEqual(planRowSlices(5, 1000, 1), [0, 1, 2, 3, 4].map(firstRow => ({ firstRow, rowCount: 1 })));
  assert.throws(() => planRowSlices(0, 4), RangeError);
  assert.throws(() => planRowSlices(4, 0), RangeError);
});

test('with flipY the bands land on the mirrored rows', () => {
  assert.equal(sliceDestinationRow({ firstRow: 0, rowCount: 3 }, 10, false), 0);
  assert.equal(sliceDestinationRow({ firstRow: 0, rowCount: 3 }, 10, true), 7);
  assert.equal(sliceDestinationRow({ firstRow: 3, rowCount: 3 }, 10, true), 4);
  assert.equal(sliceDestinationRow({ firstRow: 9, rowCount: 1 }, 10, true), 0);
});

// A context that records texSubImage2D into a byte grid, flipping each band inside itself as WebGL does.
function recordingContext(width, height) {
  const grid = new Uint8Array(width * height * 4);
  const calls = [];
  const state = { flipY: false };
  const context = {
    TEXTURE_2D: 1, TEXTURE_BINDING_2D: 2, UNPACK_FLIP_Y_WEBGL: 3, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 4, UNPACK_COLORSPACE_CONVERSION_WEBGL: 5, NONE: 0, RGBA: 6, UNSIGNED_BYTE: 7,
    getParameter: name => (name === 3 ? state.flipY : null),
    bindTexture() {}, texImage2D() {},
    pixelStorei(name, value) { if (name === 3) state.flipY = value; },
    texSubImage2D(target, level, x, y, bandWidth, bandHeight, format, type, pixels) {
      calls.push(pixels.byteLength);
      for (let row = 0; row < bandHeight; row++) {
        const sourceRow = state.flipY ? bandHeight - 1 - row : row;
        grid.set(pixels.subarray(sourceRow * bandWidth * 4, (sourceRow + 1) * bandWidth * 4), ((y + row) * width + x) * 4);
      }
    },
  };
  return { context, grid, calls };
}

for (const flipY of [false, true]) {
  test(`sliced upload of raw bytes equals one upload (flipY ${flipY}), with every call bounded and a yield after each`, async () => {
    const width = 37;
    const height = 101;
    const data = new Uint8Array(width * height * 4).map((_, index) => (index * 7919) % 251);
    const { context, grid, calls } = recordingContext(width, height);
    let checkpoints = 0;
    await uploadTextureInSlices(context, {}, 0, { width, height, data }, { flipY, maximumBytes: 5000, checkpoint: async () => { checkpoints++; } });
    const expected = new Uint8Array(data.length);
    for (let row = 0; row < height; row++) {
      const sourceRow = flipY ? height - 1 - row : row;
      expected.set(data.subarray(sourceRow * width * 4, (sourceRow + 1) * width * 4), row * width * 4);
    }
    assert.deepEqual(grid, expected);
    assert.ok(calls.length > 1);
    assert.ok(calls.every(bytes => bytes <= 5000));
    assert.equal(checkpoints, calls.length);
  });
}

test('in Chrome a sliced upload reads back the pixels a single upload gives, flipped or not, with alpha', async (testContext) => {
  await withDevServerPage(testContext, async (page) => {
    const result = await page.evaluate(async () => {
      const { uploadTextureInSlices } = await import('/src/texture-upload.js');
      const width = 64;
      const height = 90;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const painter = canvas.getContext('2d');
      for (let row = 0; row < height; row++) {
        painter.fillStyle = `rgba(${row * 2}, ${255 - row * 2}, ${(row * 37) % 256}, ${0.2 + (row % 5) * 0.2})`;
        painter.fillRect(row % width, row, width - (row % width), 1);
      }
      // A glTF texture arrives as an unpremultiplied ImageBitmap, whose rows are cut without rounding.
      const bitmap = await createImageBitmap(canvas, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      // A canvas source is premultiplied, so only an opaque one reads back the same through both paths.
      const opaque = document.createElement('canvas');
      opaque.width = width;
      opaque.height = height;
      const opaquePainter = opaque.getContext('2d');
      for (let row = 0; row < height; row++) {
        opaquePainter.fillStyle = `rgb(${row * 2}, ${255 - row * 2}, ${(row * 37) % 256})`;
        opaquePainter.fillRect(row % width, row, width - (row % width), 1);
      }
      const gl = document.createElement('canvas').getContext('webgl2');
      const framebuffer = gl.createFramebuffer();
      const read = (texture) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return Array.from(pixels);
      };
      const outcome = {};
      for (const [kind, image] of [['bitmap', bitmap], ['canvas', opaque]]) for (const flipY of [false, true]) {
        const whole = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, whole);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        const sliced = gl.createTexture();
        await uploadTextureInSlices(gl, sliced, gl.RGBA8, image, { flipY, maximumBytes: 64 * 4 * 7 });
        outcome[kind + flipY] = { identical: JSON.stringify(read(whole)) === JSON.stringify(read(sliced)), restoredFlip: gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) === false };
      }
      return outcome;
    });
    for (const key of ['bitmapfalse', 'bitmaptrue', 'canvasfalse', 'canvastrue']) {
      assert.equal(result[key].identical, true, `pixels differ for ${key}`);
      assert.equal(result[key].restoredFlip, true);
    }
  });
});

test('preloadTextures uploads a large texture in bands and createTexture then reuses it, while a small one is left alone', async (testContext) => {
  await withDevServerPage(testContext, async (page) => {
    const result = await page.evaluate(async () => {
      const { box } = await import('/src/geometry.js');
      const { Renderer67 } = await import('/src/renderer.js');
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const material = { tag: 'surface', color: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.5, emission: 0 };
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      document.body.append(canvas);
      const renderer = new Renderer67(canvas, [{ name: 'box', geometry: box(0, 1), matrix: identity, material }], { samples: 1, pixelRatio: 1 });
      const imageOf = size => Object.assign(document.createElement('canvas'), { width: size, height: size });
      const large = { image: imageOf(256) };
      const small = { image: imageOf(8) };
      let bands = 0;
      const texSubImage2D = renderer.context.texSubImage2D.bind(renderer.context);
      renderer.context.texSubImage2D = (...parameters) => {
        bands++;
        return texSubImage2D(...parameters);
      };
      await renderer.preloadTextures([{ material: { ...material, map: large } }, { material: { ...material, map: small } }], { maximumBytes: 256 * 4 * 16 });
      const uploaded = renderer.textures.get(large);
      return { bands, largeUploaded: Boolean(uploaded), smallLeftAlone: !renderer.textures.has(small), reused: renderer.createTexture(large) === uploaded, error: renderer.context.getError() };
    });
    assert.equal(result.bands, 16);
    assert.equal(result.largeUploaded, true);
    assert.equal(result.smallLeftAlone, true);
    assert.equal(result.reused, true);
    assert.equal(result.error, 0);
  });
});
