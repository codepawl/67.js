// scene_create_asset then scene_export_glb through the real MCP server on the CPU backend (issue 1197):
// the exported file keeps the source JPEG and PNG bytes instead of growing to stored PNGs.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mat4 } from 'gl-matrix';
import sharp from 'sharp';
import { readGlb, writeGlb } from '../scripts/recode-glb-textures.mjs';
import { exportGlb } from '../src/export.js';
import { box } from '../src/geometry.js';

const IMAGE_SIZE = 1024;
let directory;
let client;
let sourceGlb;

async function encodedImage(format) {
  const raw = Buffer.alloc(IMAGE_SIZE * IMAGE_SIZE * 3);
  for (let index = 0; index < raw.length; index++) raw[index] = (Math.floor(index / 3) % IMAGE_SIZE >> 2) + index % 3 * 40 & 255;
  const image = sharp(raw, { raw: { width: IMAGE_SIZE, height: IMAGE_SIZE, channels: 3 } });
  return format === 'jpeg' ? image.jpeg({ quality: 80 }).toBuffer() : image.png().toBuffer();
}

// A box whose base color is a JPEG and whose normal map is a PNG, stored as the files' own bytes.
async function buildCatalogGlb() {
  const geometry = box();
  geometry.uvs = new Float32Array(geometry.positions.length / 3 * 2).map((_, index) => index % 7 / 7);
  const placeholder = () => ({ width: 2, height: 2, data: new Uint8ClampedArray(16) });
  const material = { color: [1, 1, 1], metallic: 0, roughness: 1, map: { image: placeholder(), colorSpace: 'srgb' }, normalMap: { image: placeholder(), colorSpace: 'linear' } };
  const { json, binary } = readGlb(Buffer.from(exportGlb([{ name: 'Crate', geometry, matrix: mat4.create(), material }])));
  const padded = bytes => Buffer.concat([bytes, Buffer.alloc((4 - bytes.length % 4) % 4)]);
  const jpegBytes = await encodedImage('jpeg');
  const pngBytes = await encodedImage('png');
  const base = padded(binary);
  json.bufferViews.push({ buffer: 0, byteOffset: base.length, byteLength: jpegBytes.length }, { buffer: 0, byteOffset: base.length + padded(jpegBytes).length, byteLength: pngBytes.length });
  json.images = [{ bufferView: json.bufferViews.length - 2, mimeType: 'image/jpeg' }, { bufferView: json.bufferViews.length - 1, mimeType: 'image/png' }];
  json.textures = json.textures.map((texture, index) => ({ ...texture, source: index }));
  const combined = Buffer.concat([base, padded(jpegBytes), padded(pngBytes)]);
  json.buffers[0].byteLength = combined.length;
  return writeGlb(json, combined);
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'crucible-export-images-'));
  await mkdir(join(directory, 'assets'));
  sourceGlb = await buildCatalogGlb();
  await writeFile(join(directory, 'assets', 'crate.glb'), sourceGlb);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('bin/crucible-mcp.mjs'), '--backend', 'cpu', '--memory', '96', '--assets', join(directory, 'assets'), '--jobs', join(directory, 'jobs')], cwd: directory, stderr: 'pipe' });
  client = new Client({ name: 'crucible-export-images-test', version: '1' });
  await client.connect(transport, { timeout: 240000 });
});

after(async () => {
  await client?.close();
  await rm(directory, { recursive: true, force: true });
});

test('scene_export_glb of a catalog asset stays near the size of the source file', { timeout: 300000 }, async () => {
  const catalog = (await client.callTool({ name: 'scene_asset_catalog', arguments: {} })).structuredContent;
  const assetId = catalog.assets.find(asset => asset.name === 'crate.glb' || asset.filename === 'crate.glb')?.id ?? catalog.assets[0].assetId ?? catalog.assets[0].id;
  const created = await client.callTool({ name: 'scene_create_asset', arguments: { recipe: { format: 'crucible.asset', schemaVersion: 1, assetId } } }, { timeout: 120000 });
  assert.equal(created.isError, undefined, created.content?.[0]?.text);
  const exported = await client.callTool({ name: 'scene_export_glb', arguments: { sessionId: created.structuredContent.sessionId } }, { timeout: 120000 });
  assert.equal(exported.isError, undefined, exported.content?.[0]?.text);
  const bytes = await readFile(exported.structuredContent.path);
  console.log(`source ${sourceGlb.length} bytes, exported ${bytes.length} bytes`);
  assert.ok(bytes.length < sourceGlb.length * 1.2, `exported ${bytes.length} bytes from a ${sourceGlb.length} byte source`);
});
