import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareFileScene } from '../scripts/file-scene.mjs';
import { inWholeWorldOrder, readPartRanks } from '../src/showcase-download.js';

async function writeStagedWorld(description) {
  const folder = await mkdtemp(join(tmpdir(), 'file-scene-staged-'));
  const worldFolder = join(folder, 'public/world');
  await mkdir(worldFolder, { recursive: true });
  for (const name of ['scene.glb', 'rest-1.glb', 'rest-2.glb', 'sky.hdr']) await writeFile(join(worldFolder, name), 'data');
  const config = join(folder, 'scene.json');
  await writeFile(config, JSON.stringify({ glb: '/world/scene.glb', hdri: '/world/sky.hdr', ...description }));
  return { root: join(folder, 'public'), config };
}

function glbWithRankRuns(partRankRuns) {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ extras: { partRankRuns } }] }));
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return new Blob([header, json]);
}

test('a staged scene routes every glbRest path like glb and drops the first-view fields', async () => {
  const { root, config } = await writeStagedWorld({
    glbRest: ['/world/rest-1.glb', '/world/rest-2.glb'],
    hdriPreview: '/world/sky-small.hdr',
    glbFirstView: [[0, 0, 0]],
  });
  const { description, assets } = prepareFileScene({ configPath: config, root });
  assert.deepEqual(description.glbRest, ['/__file/asset/2/rest-1.glb', '/__file/asset/3/rest-2.glb']);
  assert.equal(assets.length, 4);
  assert.equal('hdriPreview' in description, false);
  assert.equal('glbFirstView' in description, false);
});

test('a glbRest that is not a list of paths is refused by name', async () => {
  const { root, config } = await writeStagedWorld({ glbRest: '/world/rest-1.glb' });
  assert.throws(() => prepareFileScene({ configPath: config, root }), /"glbRest" must be a list/);
});

test('the parts of a two-file scene join in the rank order the files record', async () => {
  const firstFile = { parts: ['a0', 'a1', 'a2'], ranks: await readPartRanks(glbWithRankRuns([[0, 1], [3, 2]])) };
  const restFile = { parts: ['b0', 'b1'], ranks: await readPartRanks(glbWithRankRuns([[1, 2]])) };
  assert.deepEqual(firstFile.ranks, [0, 3, 4]);
  assert.deepEqual(inWholeWorldOrder([firstFile, restFile]), ['a0', 'b0', 'b1', 'a1', 'a2']);
  assert.deepEqual(inWholeWorldOrder([firstFile, { parts: ['b0'], ranks: null }]), ['a0', 'a1', 'a2', 'b0']);
});
