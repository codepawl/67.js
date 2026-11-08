import assert from 'node:assert/strict';
import test from 'node:test';

import { texturePixels } from '../src/path-tracer-scene.js';

function fakeCanvasFactory(readCounter) {
  return (width, height) => ({
    getContext: () => ({
      drawImage: () => {},
      getImageData: () => {
        readCounter.reads++;
        return { data: new Uint8ClampedArray(width * height * 4).fill(200) };
      },
    }),
  });
}

test('an image with RGBA data is used as it is', () => {
  const data = new Uint8Array(4).fill(7);
  assert.equal(texturePixels({ width: 1, height: 1, data }), data);
});

test('a decoded bitmap without data is read back through a canvas, once per image', () => {
  const readCounter = { reads: 0 };
  const bitmap = { width: 2, height: 1 };
  const first = texturePixels(bitmap, fakeCanvasFactory(readCounter));
  const second = texturePixels(bitmap, fakeCanvasFactory(readCounter));
  assert.equal(first.length, 8);
  assert.equal(first[0], 200);
  assert.equal(second, first);
  assert.equal(readCounter.reads, 1);
});

test('compressed images, images without a size and runtimes without a canvas give no pixels', () => {
  const readCounter = { reads: 0 };
  assert.equal(texturePixels({ width: 4, height: 4, compressed: true }, fakeCanvasFactory(readCounter)), null);
  assert.equal(texturePixels({ width: 0, height: 4 }, fakeCanvasFactory(readCounter)), null);
  assert.equal(texturePixels({ width: 4, height: 4 }, () => null), null);
  assert.equal(texturePixels(undefined), null);
  assert.equal(readCounter.reads, 0);
});
