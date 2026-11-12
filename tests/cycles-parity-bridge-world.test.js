import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { reconstructTraceSceneSource } from '../bench/cycles-parity/scene-bridge.mjs';

const ENVIRONMENT = { keyColor: [0, 0, 0], lightDirection: [0, 1, 0], pointLights: [], spotLights: [], areaLights: [] };

function describeScene(world) {
  return { geometries: [], materials: [], parts: [], world, environment: ENVIRONMENT, camera: {} };
}

test('a constant world with a colour fills the environment map with that colour', async () => {
  const source = await reconstructTraceSceneSource(describeScene({ type: 'constant', value: 0.5, color: [0.25, 0.5, 1] }));
  const { data } = source.environment.map;
  assert.deepEqual([...data.slice(0, 3)], [0.25, 0.5, 1]);
  assert.deepEqual([...data.slice(-3)], [0.25, 0.5, 1]);
});

test('a constant world without a colour stays grey, as the parity bridges write it', async () => {
  const source = await reconstructTraceSceneSource(describeScene({ type: 'constant', value: 0.5 }));
  assert.deepEqual([...source.environment.map.data.slice(0, 3)], [0.5, 0.5, 0.5]);
});

test('an HDRI world is read from an absolute path as well as from a path under the repository root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-world-'));
  const hdrPath = join(directory, 'sky.hdr');
  const header = Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 4\n', 'ascii');
  // Eight pixels: the first is (1, 1, 1), written as mantissa 128 with exponent 129; the others are black.
  await writeFile(hdrPath, Buffer.concat([header, Buffer.from([128, 128, 128, 129, ...new Array(28).fill(0)])]));
  const source = await reconstructTraceSceneSource(describeScene({ type: 'hdri', file: hdrPath, intensity: 1, radianceLimit: 60000 }));
  assert.equal(source.environment.map.width, 4);
  assert.deepEqual([...source.environment.map.data.slice(0, 3)], [1, 1, 1]);
});
