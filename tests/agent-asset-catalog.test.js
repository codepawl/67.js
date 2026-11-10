import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mat4 } from 'gl-matrix';
import { box } from '../src/geometry.js';
import { exportGlb } from '../src/export.js';
import { createAgentAssetCatalog } from '../scripts/agent-asset-catalog.mjs';
import { AGENT_ASSET_LIMITS, agentAssetDecodeOptions, withCatalogLimitAdvice } from '../src/agent-asset-limits.js';
import { GLTF_CAPABILITIES, parseGltf } from '../src/gltf.js';

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), '67js-catalog-'));
  context.after(async () => {
    assert.equal(dirname(directory), tmpdir());
    await rm(directory, { recursive: true, force: true });
  });
  const bytes = Buffer.from(exportGlb([{ name: 'Cube', geometry: box(0), matrix: mat4.create(), material: { color: [0.2, 0.5, 0.7], roughness: 0.5, metallic: 0 } }]));
  await writeFile(join(directory, 'cube.glb'), bytes);
  return { directory, bytes };
}

function withDocument(bytes, edit) {
  const document = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
  edit(document);
  const json = Buffer.from(JSON.stringify(document));
  const length = Math.ceil(json.length / 4) * 4;
  const binary = bytes.subarray(20 + bytes.readUInt32LE(12));
  const result = Buffer.alloc(20 + length + binary.length, 32);
  bytes.copy(result, 0, 0, 20);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(length, 12);
  json.copy(result, 20);
  binary.copy(result, 20 + length);
  return result;
}

test('catalog IDs bind self-contained GLB content and metadata stays detached without paths', async context => {
  const { directory, bytes } = await fixture(context);
  await writeFile(join(directory, 'duplicate.glb'), bytes);
  await writeFile(join(directory, 'ignored.txt'), 'not an asset');
  const catalog = await createAgentAssetCatalog(directory);
  const listing = catalog.list();
  assert.equal(listing.assets.length, 1);
  assert.match(listing.assets[0].assetId, /^[a-f0-9]{64}$/);
  assert.equal(listing.assets[0].meshes, 1);
  assert.doesNotMatch(JSON.stringify(listing), /67js-catalog-/);
  const id = listing.assets[0].assetId;
  listing.assets[0].name = 'changed';
  assert.equal(catalog.list().assets[0].name, 'cube.glb');
  assert.deepEqual(await catalog.read(id), bytes);
  await assert.rejects(catalog.read('../cube.glb'), /Unknown asset/);
});

test('changed bytes cannot silently reuse a catalog digest', async context => {
  const { directory, bytes } = await fixture(context);
  const catalog = await createAgentAssetCatalog(directory);
  const id = catalog.list().assets[0].assetId;
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] ^= 1;
  await writeFile(join(directory, 'cube.glb'), changed);
  await assert.rejects(catalog.read(id), /bytes changed/);
});

test('catalog rejects external resources and malformed or over-budget GLBs before browser loading', async context => {
  const { directory, bytes } = await fixture(context);
  await writeFile(join(directory, 'cube.glb'), withDocument(bytes, document => { document.buffers[0].uri = 'https://example.invalid/private'; }));
  await assert.rejects(createAgentAssetCatalog(directory), /embed all/);
  await writeFile(join(directory, 'cube.glb'), Buffer.alloc(AGENT_ASSET_LIMITS.maxBytes + 1));
  await assert.rejects(createAgentAssetCatalog(directory), error => error instanceof RangeError
    && error.message.includes('cube.glb: Asset is 67108865 bytes, over the catalog maxBytes 67108864 (64 MiB)'));
  await writeFile(join(directory, 'cube.glb'), Buffer.alloc(28));
  await assert.rejects(createAgentAssetCatalog(directory), /complete glTF/);
});

test('declared clip metadata stays bounded even when a GLB contains many animation declarations', async context => {
  const { directory, bytes } = await fixture(context);
  await writeFile(join(directory, 'cube.glb'), withDocument(bytes, document => {
    document.animations = Array.from({ length: 100000 }, () => ({ name: 'x'.repeat(100) }));
  }));
  const catalog = await createAgentAssetCatalog(directory);
  const listing = catalog.list();
  assert.equal(listing.assets[0].animationCount, 100000);
  assert.equal(listing.assets[0].animations.length, 16);
  assert.equal(listing.assets[0].animationsTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(listing)) < 4096);
  await assert.rejects(catalog.read(listing.assets[0].assetId), /100000 animation clips, over the catalog maxClips 256/);
});

test('catalog rejects linked assets and requires an explicitly absolute directory', async context => {
  const { directory } = await fixture(context);
  await assert.rejects(createAgentAssetCatalog('relative-assets'), /absolute/);
  await symlink(join(directory, 'cube.glb'), join(directory, 'linked.glb'), 'file');
  await assert.rejects(createAgentAssetCatalog(directory), /without links/);
});

test('the catalog limits are the documented values and never exceed the loadGltf defaults', () => {
  assert.deepEqual({ ...AGENT_ASSET_LIMITS }, {
    maxBytes: 64 * 1024 * 1024, maxAssets: 64, maxCombinedBytes: 64 * 1024 * 1024, maxVertices: 1_000_000, maxParts: 4096,
    maxTexturePixels: 4_194_304, maxJoints: 1024, maxClips: 256,
  });
  const defaults = GLTF_CAPABILITIES.limits;
  for (const [name, value] of Object.entries(agentAssetDecodeOptions())) {
    assert.ok(value <= defaults[name], `${name} ${value} is above the loadGltf default ${defaults[name]}`);
    assert.equal(value, AGENT_ASSET_LIMITS[name]);
  }
});

test('no MCP script writes an asset limit as a literal number', async () => {
  const names = (await readdir(new URL('../scripts/', import.meta.url))).filter(name => /^agent-.*\.(mjs|js)$/.test(name));
  for (const name of names) {
    const source = await readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /maxVertices: 250000|maximumVertices: 250000|MAXIMUM_ASSET_BYTES = 16|MAXIMUM_BYTES = 16/, name);
  }
});

test('a decode limit error names the catalog limit and the value the file hit, with no code-only advice', async context => {
  const { bytes } = await fixture(context);
  const tight = { ...agentAssetDecodeOptions(), maxVertices: 4 };
  const failure = await parseGltf(new Uint8Array(bytes).buffer, tight).then(() => null, error => error);
  assert.ok(failure instanceof RangeError);
  const advised = withCatalogLimitAdvice(failure);
  assert.match(advised.message, /vertices \d+, over maxVertices 4/);
  assert.match(advised.message, new RegExp(`MCP catalog limits are maxBytes ${AGENT_ASSET_LIMITS.maxBytes}, maxVertices ${AGENT_ASSET_LIMITS.maxVertices}`));
  assert.doesNotMatch(advised.message, /Fix: pass/);
  const other = new Error('unrelated');
  assert.equal(withCatalogLimitAdvice(other), other);
});

test('a Radiance .hdr and a .cube file are listed as environment and look entries and read back by ID', async context => {
  const { directory } = await fixture(context);
  const radiance = await readFile(new URL('../assets/looks/studio-softbox.hdr', import.meta.url));
  const cube = await readFile(new URL('../assets/looks/noir.cube', import.meta.url));
  await writeFile(join(directory, 'room.hdr'), radiance);
  await writeFile(join(directory, 'grade.cube'), cube);
  const catalog = await createAgentAssetCatalog(directory);
  const entries = Object.fromEntries(catalog.list().assets.map(entry => [entry.name, entry]));
  assert.equal(entries['room.hdr'].kind, 'environment');
  assert.equal(entries['grade.cube'].kind, 'look');
  assert.deepEqual(await catalog.read(entries['room.hdr'].assetId), radiance);
});

test('an .hdr that is not Radiance data and a .cube that is not a 3D look are refused', async context => {
  const { directory } = await fixture(context);
  await writeFile(join(directory, 'fake.hdr'), Buffer.alloc(64, 1));
  await assert.rejects(createAgentAssetCatalog(directory), /Radiance/);
  await rm(join(directory, 'fake.hdr'));
  await writeFile(join(directory, 'fake.cube'), 'LUT_1D_SIZE 2\n0 0 0\n1 1 1\n'.padEnd(64, ' '));
  await assert.rejects(createAgentAssetCatalog(directory), /LUT_3D_SIZE/);
});
