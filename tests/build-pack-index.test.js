import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { buildPackIndex, createZip } from '../scripts/build-pack-index.mjs';

const EXAMPLE = new URL('../packs/example-starter', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function packsFolderWithExample(context) {
  const folder = mkdtempSync(join(tmpdir(), 'crucible-pack-index-'));
  context.after(() => rmSync(folder, { recursive: true, force: true }));
  cpSync(EXAMPLE, join(folder, 'packs/example-starter'), { recursive: true });
  return { packsDirectory: join(folder, 'packs'), outputDirectory: join(folder, 'out') };
}

test('a valid pack gives a zip, a preview and an index entry with the sha256 of the zip', async (context) => {
  const options = packsFolderWithExample(context);
  const packs = await buildPackIndex(options);
  assert.equal(packs.length, 1);
  const [pack] = packs;
  const zip = readFileSync(join(options.outputDirectory, 'example-starter-1.0.0.zip'));
  assert.equal(pack.sha256, createHash('sha256').update(zip).digest('hex'));
  assert.equal(pack.bytes, zip.length);
  assert.deepEqual(pack.items, { looks: 1, materials: 2, recipes: 1 });
  assert.equal(pack.engines, '>=0.19.0');
  assert.equal(pack.license, 'CC0-1.0');
  assert.equal(pack.preview, '/packs/example-starter-1.0.0-preview.png');
  assert.ok(readdirSync(options.outputDirectory).includes('example-starter-1.0.0-preview.png'));
  const index = JSON.parse(readFileSync(join(options.outputDirectory, 'index.json'), 'utf8'));
  assert.deepEqual(index.packs, packs);
});

test('an invalid pack stops the build with its own error', async (context) => {
  const options = packsFolderWithExample(context);
  writeFileSync(join(options.packsDirectory, 'example-starter/run.js'), 'console.log(1)');
  await assert.rejects(buildPackIndex(options), /Refusing to publish 1 invalid pack[\s\S]*example-starter[\s\S]*run\.js/);
  assert.ok(!readdirSync(options.outputDirectory).includes('index.json'));
});

test('two builds give identical bytes', async (context) => {
  const options = packsFolderWithExample(context);
  const readOutputs = () => ['example-starter-1.0.0.zip', 'index.json'].map(name => readFileSync(join(options.outputDirectory, name)));
  await buildPackIndex(options);
  const first = readOutputs();
  await buildPackIndex(options);
  assert.deepEqual(readOutputs(), first);
});

test('the zip sorts its entries and holds the original bytes', () => {
  const content = Buffer.from('hello hello hello hello hello hello');
  const zip = createZip(new Map([['b/second.txt', content], ['a.txt', Buffer.from('x')]]));
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const nameLength = zip.readUInt16LE(26);
  assert.equal(zip.subarray(30, 30 + nameLength).toString(), 'a.txt');
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), 2);
  const secondOffset = 30 + nameLength + 1;
  const secondNameLength = zip.readUInt16LE(secondOffset + 26);
  const compressedSize = zip.readUInt32LE(secondOffset + 18);
  const dataStart = secondOffset + 30 + secondNameLength;
  assert.deepEqual(inflateRawSync(zip.subarray(dataStart, dataStart + compressedSize)), content);
});
