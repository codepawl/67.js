import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { parseArguments, readGlb, recodeGlbTextures, writeGlb } from '../scripts/recode-glb-textures.mjs';

async function noisyJpeg(size) {
  const raw = Buffer.alloc(size * size * 3);
  for (let index = 0; index < raw.length; index++) raw[index] = (index * 31 + (index >> 7) * 17) & 255;
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

// One JPEG image and one stand-in for a meshopt buffer view, whose data lives in the extension and not in the view.
async function buildGlb(size) {
  const jpeg = await noisyJpeg(size);
  const geometry = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const padded = bytes => Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
  const binary = Buffer.concat([padded(geometry), padded(jpeg)]);
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: binary.length }, { byteLength: 8, extensions: { EXT_meshopt_compression: { fallback: true } } }],
    bufferViews: [
      { buffer: 1, byteOffset: 0, byteLength: 8, extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: 8, byteStride: 4, count: 2, mode: 'ATTRIBUTES' } } },
      { buffer: 0, byteOffset: padded(geometry).length, byteLength: jpeg.length },
    ],
    images: [{ bufferView: 1, mimeType: 'image/jpeg' }],
    extensionsUsed: ['EXT_meshopt_compression'],
    extensionsRequired: ['EXT_meshopt_compression'],
  };
  return { glb: writeGlb(json, binary), geometry, jpegBytes: jpeg.length };
}

test('parseArguments reads both options and rejects unknown ones', () => {
  const parsed = parseArguments(['in.glb', 'out.glb', '--webp-quality', '70', '--max-texture', '2048']);
  assert.deepEqual(parsed.options, { webpQuality: 70, maxTexture: 2048 });
  assert.throws(() => parseArguments(['in.glb', 'out.glb', '--bogus', '1']), /Unknown or invalid option/);
  assert.throws(() => parseArguments(['only-one.glb']), /Pass <input.glb> and <output.glb>/);
});

test('textures become WebP and the meshopt data stays byte for byte', async () => {
  const { glb, geometry } = await buildGlb(256);
  const result = await recodeGlbTextures(glb, { webpQuality: 60, maxTexture: 4096 });
  const { json, binary } = readGlb(result.glb);
  assert.equal(json.images[0].mimeType, 'image/webp');
  assert.ok(json.extensionsRequired.includes('EXT_texture_webp'));
  const meshopt = json.bufferViews[0].extensions.EXT_meshopt_compression;
  assert.deepEqual([...binary.subarray(meshopt.byteOffset, meshopt.byteOffset + meshopt.byteLength)], [...geometry]);
  const view = json.bufferViews[1];
  const metadata = await sharp(binary.subarray(view.byteOffset, view.byteOffset + view.byteLength)).metadata();
  assert.equal(metadata.format, 'webp');
  assert.ok(json.buffers[0].byteLength <= binary.length);
  assert.equal(json.buffers[0].byteLength % 4, 0);
});

test('a texture above the cap is scaled down, keeping its aspect ratio', async () => {
  const { glb } = await buildGlb(512);
  const { json, binary } = readGlb((await recodeGlbTextures(glb, { webpQuality: 60, maxTexture: 128 })).glb);
  const view = json.bufferViews[1];
  const metadata = await sharp(binary.subarray(view.byteOffset, view.byteOffset + view.byteLength)).metadata();
  assert.deepEqual([metadata.width, metadata.height], [128, 128]);
});

test('an image whose WebP would be larger is left as it was', async () => {
  const { glb } = await buildGlb(64);
  const unchanged = await recodeGlbTextures(glb, { webpQuality: 100, maxTexture: 4096 });
  const { json } = readGlb(unchanged.glb);
  if (json.images[0].mimeType === 'image/jpeg') assert.equal(unchanged.imageBytesAfter, unchanged.imageBytesBefore);
  else assert.ok(unchanged.imageBytesAfter < unchanged.imageBytesBefore);
});
