import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import sharp from 'sharp';
import { readGlb, writeGlb } from '../scripts/recode-glb-textures.mjs';
import { exportGlb } from '../src/export.js';
import { parseGltf } from '../src/gltf.js';
import { box } from '../src/geometry.js';

// Node has no image decoder: report the size each test image was made with and keep no pixels.
const IMAGE_SIZE = 192;
globalThis.self = globalThis;
globalThis.createImageBitmap = async (blob, options = {}) => {
  const bitmap = { width: options.resizeWidth ?? IMAGE_SIZE, height: options.resizeHeight ?? IMAGE_SIZE, close() {} };
  if (options.resizeWidth) bitmap.data = new Uint8Array(bitmap.width * bitmap.height * 4);
  return bitmap;
};

async function noisyImage(format) {
  const raw = Buffer.alloc(IMAGE_SIZE * IMAGE_SIZE * 3);
  for (let index = 0; index < raw.length; index++) raw[index] = (index * 31 + (index >> 7) * 17) & 255;
  const image = sharp(raw, { raw: { width: IMAGE_SIZE, height: IMAGE_SIZE, channels: 3 } });
  return format === 'jpeg' ? image.jpeg({ quality: 90 }).toBuffer() : image.png().toBuffer();
}

function texturedBox() {
  const geometry = box();
  geometry.uvs = new Float32Array(geometry.positions.length / 3 * 2).map((_, index) => index % 7 / 7);
  const placeholder = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  const material = { color: [1, 1, 1], metallic: 0, roughness: 1, map: { image: placeholder, colorSpace: 'srgb' }, normalMap: { image: { ...placeholder, data: new Uint8ClampedArray(16) }, colorSpace: 'linear' } };
  return { name: 'Crate', geometry, matrix: mat4.create(), material };
}

// A catalog-style GLB: one box whose base color is a JPEG and whose normal map is a PNG, each stored as the file's own bytes.
async function buildCatalogGlb() {
  const jpegBytes = await noisyImage('jpeg');
  const pngBytes = await noisyImage('png');
  const { json, binary } = readGlb(Buffer.from(exportGlb([texturedBox()])));
  const padded = bytes => Buffer.concat([bytes, Buffer.alloc((4 - bytes.length % 4) % 4)]);
  const base = padded(binary);
  const jpegOffset = base.length;
  const pngOffset = jpegOffset + padded(jpegBytes).length;
  json.bufferViews.push({ buffer: 0, byteOffset: jpegOffset, byteLength: jpegBytes.length }, { buffer: 0, byteOffset: pngOffset, byteLength: pngBytes.length });
  const jpegView = json.bufferViews.length - 2;
  json.images = [{ bufferView: jpegView, mimeType: 'image/jpeg' }, { bufferView: jpegView + 1, mimeType: 'image/png' }];
  json.textures = json.textures.map((texture, index) => ({ ...texture, source: index }));
  const combined = Buffer.concat([base, padded(jpegBytes), padded(pngBytes)]);
  json.buffers[0].byteLength = combined.length;
  return { glb: writeGlb(json, combined), jpegBytes, pngBytes };
}

function embeddedImages(glb) {
  const { json, binary } = readGlb(Buffer.from(glb));
  return json.images.map(image => {
    const view = json.bufferViews[image.bufferView];
    return { mimeType: image.mimeType, bytes: binary.subarray(view.byteOffset, view.byteOffset + view.byteLength) };
  });
}

test('an imported GLB exports its JPEG and PNG textures with the source bytes, and loads again', async () => {
  const { glb, jpegBytes, pngBytes } = await buildCatalogGlb();
  const imported = await parseGltf(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
  const exported = Buffer.from(exportGlb(imported.parts));
  const images = embeddedImages(exported);
  const bytesByMime = new Map(images.map(image => [image.mimeType, image.bytes]));
  assert.deepEqual(Buffer.from(bytesByMime.get('image/jpeg')), jpegBytes);
  assert.deepEqual(Buffer.from(bytesByMime.get('image/png')), pngBytes);
  // Before this change each image was re-encoded as stored PNG: 192 x 192 x 3 plus row filter bytes, about 110 KB each.
  const untextured = imported.parts.map(part => ({ ...part, material: { ...part.material, map: undefined, normalMap: undefined } }));
  const imageBytes = jpegBytes.length + pngBytes.length;
  const extraBytes = exported.length - Buffer.from(exportGlb(untextured)).length - imageBytes;
  assert.ok(extraBytes < 2_000, `${extraBytes} bytes beyond the ${imageBytes} bytes of source images`);
  const reloaded = await parseGltf(exported.buffer.slice(exported.byteOffset, exported.byteOffset + exported.byteLength));
  assert.equal(reloaded.parts[0].material.map.image.width, IMAGE_SIZE);
  assert.equal(reloaded.parts[0].material.normalMap.image.width, IMAGE_SIZE);
});

test('an image that was scaled on import is encoded again from its pixels', async () => {
  const { glb } = await buildCatalogGlb();
  const imported = await parseGltf(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), { maxTexturePixels: IMAGE_SIZE * IMAGE_SIZE });
  const images = embeddedImages(exportGlb(imported.parts));
  assert.ok(images.some(image => image.mimeType === 'image/png'));
  assert.ok(images.every(image => image.bytes.length > 0));
});

test('a texture the scene made itself is encoded as a PNG', () => {
  const images = embeddedImages(exportGlb([texturedBox()]));
  assert.deepEqual(images.map(image => image.mimeType), ['image/png', 'image/png']);
});

test('a flipped texture is encoded again because its rows no longer match the source file', async () => {
  const { glb } = await buildCatalogGlb();
  const imported = await parseGltf(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
  imported.parts[0].material.map.flipY = true;
  // The test decoder keeps no pixels, so re-encoding is visible as the pixel read that fails.
  assert.throws(() => exportGlb(imported.parts), /needs RGBA pixel data/);
});
