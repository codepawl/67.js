import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { loadPack, loadPacks } from '../scripts/agent-packs.mjs';
import { validatePackScene } from '../scripts/pack-scene-validator.mjs';
import { MAXIMUM_PACK_ITEMS_PER_KIND, semverSatisfies, validatePackManifest } from '../src/pack-manifest.js';
import packageMetadata from '../package.json' with { type: 'json' };

const packageVersion = packageMetadata.version;
const EXAMPLE = new URL('../packs/example-starter', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

function tinyGlb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' } }).padEnd(32, ' '));
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, json]);
}

function temporaryFolder(context) {
  const folder = mkdtempSync(join(tmpdir(), 'crucible-packs-'));
  context.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

/** A copy of the example pack in `parent/name`, with `change(manifest, folder)` applied to its manifest. */
function installPack(parent, name, change = () => {}) {
  const folder = join(parent, name);
  cpSync(EXAMPLE, folder, { recursive: true });
  const manifestPath = join(folder, 'crucible-pack.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  change(manifest, folder);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return folder;
}

function loadFrom(folder) {
  return loadPack(folder, { packageVersion, validateScene: validatePackScene });
}

test('the example pack loads and lists its items', async () => {
  const pack = await loadFrom(EXAMPLE);
  assert.equal(pack.name, 'example-starter');
  assert.deepEqual(pack.items.materials.map(item => item.id), ['rusty-metal', 'warm-plaster']);
  assert.deepEqual(pack.items.recipes, [{ id: 'crates', preview: 'previews/crates.png' }]);
  assert.equal(pack.items.looks[0].assetId, createHash('sha256').update(readFileSync(join(EXAMPLE, 'looks/warm.cube'))).digest('hex'));
});

test('a pack with a model, image and HDRI gives each a content-hash ID', async context => {
  const folder = installPack(temporaryFolder(context), 'full', (manifest, root) => {
    mkdirSync(join(root, 'models'));
    writeFileSync(join(root, 'models/crate.glb'), tinyGlb());
    writeFileSync(join(root, 'models/bg.png'), PNG);
    writeFileSync(join(root, 'models/studio.hdr'), '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n\u0080\u0080\u0080\u0081');
    manifest.contents.assets = [{ id: 'crate', file: 'models/crate.glb' }];
    manifest.contents.images = [{ id: 'bg', file: 'models/bg.png' }];
    manifest.contents.environments = [{ id: 'studio', file: 'models/studio.hdr' }];
  });
  const pack = await loadFrom(folder);
  assert.equal(pack.items.assets[0].assetId, createHash('sha256').update(tinyGlb()).digest('hex'));
  assert.equal(pack.files.length, 4);
  assert.match(pack.items.environments[0].assetId, /^[a-f0-9]{64}$/);
});

async function assertRefused(context, change, pattern, prepare) {
  const parent = temporaryFolder(context);
  const folder = installPack(parent, 'bad-pack', (manifest, root) => {
    prepare?.(root);
    change(manifest, root);
  });
  await assert.rejects(() => loadFrom(folder), pattern);
}

test('a script file anywhere in the pack refuses the whole pack', async context => {
  await assertRefused(context, () => {}, /pack "bad-pack" extras\/run\.js: got "a script, page or program file"; expected data only/, root => {
    mkdirSync(join(root, 'extras'));
    writeFileSync(join(root, 'extras/run.js'), 'console.log(1)');
  });
});

test('a remote URL inside a recipe is refused with its location', async context => {
  await assertRefused(context, () => {}, /pack "bad-pack" recipes\/crates\.json \$\.nodes\[0\]\.note: got "https:\/\/example\.test\/x"; expected no remote URL/, root => {
    const path = join(root, 'recipes/crates.json');
    const recipe = JSON.parse(readFileSync(path, 'utf8'));
    recipe.nodes[0].note = 'https://example.test/x';
    writeFileSync(path, JSON.stringify(recipe));
  });
});

test('a recipe or material the scene validator rejects is refused', async context => {
  await assertRefused(context, () => {}, /pack "bad-pack" materials\/rusty-metal\.json: .*sparkle/, root => {
    writeFileSync(join(root, 'materials/rusty-metal.json'), JSON.stringify({ sparkle: 3 }));
  });
});

test('a file over 64 MiB is refused with the limit', async context => {
  await assertRefused(context, () => {}, /pack "bad-pack" big\.bin: got "67108865 bytes"; expected at most 67108864 bytes/, root => {
    writeFileSync(join(root, 'big.bin'), '');
    truncateSync(join(root, 'big.bin'), 64 * 1024 * 1024 + 1);
  });
});

test('JSON over 1 MiB is refused', async context => {
  await assertRefused(context, () => {}, /over 1048576 bytes|1 MiB/, root => {
    writeFileSync(join(root, 'materials/rusty-metal.json'), JSON.stringify({ color: [1, 1, 1], pad: 'x'.repeat(1024 * 1024) }));
  });
});

test('an engines range that excludes this version is refused', async context => {
  await assertRefused(context, manifest => { manifest.engines['crucible'] = '>=99.0.0'; }, /engines\.crucible: got ">=99\.0\.0"; expected a range that admits the installed Crucible/);
  await assertRefused(context, manifest => { manifest.engines['crucible'] = 'latest'; }, /engines\.crucible: got "latest"; expected a range of space-separated comparators/);
});

test('paths that leave the pack are refused', async context => {
  for (const file of ['../outside.json', '/etc/passwd', 'C:/Windows/x.json', 'materials\\rusty-metal.json', 'materials/../materials/rusty-metal.json', 'a//b.json']) {
    await assertRefused(context, manifest => { manifest.contents.materials[0].file = file; }, /materials\[0\]\.file: got .*; expected a relative path inside the pack/);
  }
});

test('a symbolic link in the pack is refused', async context => {
  const parent = temporaryFolder(context);
  const folder = installPack(parent, 'linked');
  try {
    symlinkSync(join(folder, 'materials/rusty-metal.json'), join(folder, 'materials/link.json'));
  } catch (error) {
    context.skip(`cannot create symbolic links here: ${error.code}`);
    return;
  }
  await assert.rejects(() => loadFrom(folder), /pack "linked" materials\/link\.json: got "a symbolic link"; expected a regular file/);
});

test('duplicate ids and unknown keys are refused', async context => {
  await assertRefused(context, manifest => { manifest.contents.materials[1].id = 'rusty-metal'; }, /materials\[1\]\.id: got "rusty-metal"; expected an id used once/);
  await assertRefused(context, manifest => { manifest.scripts = { build: 'x' }; }, /crucible-pack\.json\.scripts: got \{"build":"x"\}; expected no such key/);
  await assertRefused(context, manifest => { manifest.contents.materials[0].url = 'x'; }, /materials\[0\]\.url: got "x"; expected no such key/);
  await assertRefused(context, manifest => { manifest.contents.recipes[0].id = 'Not Kebab'; }, /recipes\[0\]\.id: got "Not Kebab"; expected a kebab-case id/);
  await assertRefused(context, manifest => { manifest.contents.materials[0].file = 'previews/crates.png'; }, /materials\[0\]\.file: got "previews\/crates\.png"; expected a file ending in \.json/);
});

test('a listed file that is missing, and a kind mismatch, are refused', async context => {
  await assertRefused(context, manifest => { manifest.contents.looks[0].file = 'looks/missing.cube'; }, /looks\[0\]\.file: got "looks\/missing\.cube"; expected a file that exists/);
  await assertRefused(context, manifest => { manifest.contents.images = [{ id: 'warm-image', file: 'looks/warm.cube' }]; }, /images\[0\]\.file: got "looks\/warm\.cube"; expected a file ending in \.png/);
  await assertRefused(context, manifest => { manifest.contents.looks = Array.from({ length: MAXIMUM_PACK_ITEMS_PER_KIND + 1 }, (_, index) => ({ id: `look-${index}`, file: 'looks/warm.cube' })); }, /contents\.looks: .*at most 64 items/);
});

test('semver ranges cover >=, >, <, <=, =, ^, ~ and space-AND', () => {
  const cases = [
    ['0.19.0', '>=0.19.0', true], ['0.19.0', '>0.19.0', false], ['0.19.1', '>0.19.0', true], ['0.19.0', '<0.20', true],
    ['0.20.0', '<0.20', false], ['0.19.0', '<=0.19.0', true], ['0.19.0', '<=0.18', false], ['0.19.5', '^0.19.0', true],
    ['0.20.0', '^0.19.0', false], ['1.4.0', '^1.2', true], ['2.0.0', '^1.2', false], ['0.19.9', '~0.19.1', true],
    ['0.20.0', '~0.19.1', false], ['1.9.0', '~1', true], ['0.19.0', '>=0.18.0 <1.0.0', true], ['1.0.0', '>=0.18.0 <1.0.0', false],
    ['0.19.0', '=0.19.0', true], ['0.19.1', '0.19.0', false], ['0.19.0', '0.19', true],
  ];
  for (const [version, range, expected] of cases) assert.equal(semverSatisfies(version, range), expected, `${version} ${range}`);
  for (const range of ['', 'abc', '>=1.0.0 ||2', '>=', '1.2.3.4', 'x'.repeat(65), '>=1 '.repeat(9)]) assert.equal(semverSatisfies('1.0.0', range), null, range);
});

test('manifest checks name the pack, the field and what to pass', () => {
  const valid = JSON.parse(readFileSync(join(EXAMPLE, 'crucible-pack.json'), 'utf8'));
  assert.equal(validatePackManifest(valid, { label: 'x', packageVersion }).name, 'example-starter');
  assert.throws(() => validatePackManifest({ ...valid, version: '1.0' }, { label: 'x', packageVersion }), /pack "x" crucible-pack\.json\.version: got "1\.0"; expected a version of three numbers/);
  assert.throws(() => validatePackManifest({ ...valid, format: 'other' }, { label: 'x', packageVersion }), /\.format: got "other"; expected "crucible\.pack"/);
});

test('loadPacks skips a bad pack, reports why, and rejects a repeated name', async context => {
  const parent = temporaryFolder(context);
  installPack(parent, 'good');
  installPack(parent, 'copy-of-good');
  installPack(parent, 'broken', manifest => { manifest.engines['crucible'] = '>=99'; });
  const { packs, rejected } = await loadPacks(parent, { packageVersion });
  assert.deepEqual(packs.map(pack => pack.folder), ['copy-of-good']);
  assert.equal(rejected.length, 2);
  assert.match(rejected.find(entry => entry.folder === 'broken').error, /engines\.crucible/);
  assert.match(rejected.find(entry => entry.folder === 'good').error, /another installed pack already uses the name "example-starter"/);
});

async function connect(context, runtime) {
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'packs-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

test('scene_asset_catalog lists installed packs and reads a recipe and a material from one', async context => {
  const parent = temporaryFolder(context);
  installPack(parent, 'example-starter', (manifest, root) => {
    mkdirSync(join(root, 'models'));
    writeFileSync(join(root, 'models/crate.glb'), tinyGlb());
    manifest.contents.assets = [{ id: 'crate', file: 'models/crate.glb' }];
  });
  installPack(parent, 'old-pack', manifest => { manifest.engines['crucible'] = '<0.1.0'; });
  const runtime = createAgentRuntime({ packs: parent, previewUrl: new URL('file:///unused.js') });
  context.after(() => runtime.close());
  const client = await connect(context, runtime);
  const listing = JSON.parse((await client.callTool({ name: 'scene_asset_catalog', arguments: {} })).content[0].text);
  assert.equal(listing.configured, true);
  const [pack] = listing.packs.packs;
  assert.equal(pack.name, 'example-starter');
  assert.equal(pack.license, 'CC0-1.0');
  assert.deepEqual(pack.items.materials.map(item => item.id), ['rusty-metal', 'warm-plaster']);
  assert.equal(listing.packs.rejected[0].folder, 'old-pack');
  const crateId = pack.items.assets[0].assetId;
  assert.ok(listing.assets.some(asset => asset.assetId === crateId && asset.kind === 'glb'), 'pack GLBs join the catalog under the same IDs');
  const recipe = JSON.parse((await client.callTool({ name: 'scene_asset_catalog', arguments: { pack: 'example-starter', recipe: 'crates' } })).content[0].text);
  assert.equal(recipe.json.format, 'crucible.scene');
  const material = JSON.parse((await client.callTool({ name: 'scene_asset_catalog', arguments: { pack: 'example-starter', material: 'rusty-metal' } })).content[0].text);
  assert.equal(material.json.metallic, 0.85);
  for (const argumentsValue of [{ recipe: 'crates' }, { pack: 'example-starter' }, { pack: 'example-starter', recipe: 'crates', material: 'rusty-metal' }, { pack: 'example-starter', recipe: 'nope' }, { pack: '../x', recipe: 'crates' }, { path: '/etc' }, { url: 'https://example.test/pack.zip' }]) {
    const rejected = await client.callTool({ name: 'scene_asset_catalog', arguments: argumentsValue }).catch(error => ({ isError: true, message: error.message }));
    assert.equal(rejected.isError, true, JSON.stringify(argumentsValue));
  }
  const topic = JSON.parse((await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'packs' } })).content[0].text);
  assert.equal(JSON.stringify(topic).includes('crucible.pack'), true);
});
