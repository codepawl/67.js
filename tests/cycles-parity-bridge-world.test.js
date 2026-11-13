import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { reconstructTraceSceneSource, resolveAssetFile } from '../bench/cycles-parity/scene-bridge.mjs';

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

const SMALL_HDR_HEADER = '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 4\n';
const SMALL_HDR_BODY = [128, 128, 128, 129, ...new Array(28).fill(0)];

async function writeSceneFolder() {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-assets-'));
  await writeFile(join(directory, 'world.hdr'), Buffer.concat([Buffer.from(SMALL_HDR_HEADER, 'ascii'), Buffer.from(SMALL_HDR_BODY)]));
  await writeFile(join(directory, 'texture-0.rgba'), Buffer.from([10, 20, 30, 255, 40, 50, 60, 255]));
  return directory;
}

test('images and the world image named by assetFile are read from the scene folder', async () => {
  const directory = await writeSceneFolder();
  const description = {
    ...describeScene({ type: 'hdri', assetFile: 'world.hdr', intensity: 1, radianceLimit: 60000 }),
    images: [{ width: 2, height: 1, assetFile: 'texture-0.rgba' }],
    materials: [{ tag: 'surface', map: { image: { imageId: 0 }, colorSpace: 'srgb' } }],
  };
  const source = await reconstructTraceSceneSource(description, undefined, { assetDirectory: directory });
  assert.deepEqual([...source.environment.map.data.slice(0, 3)], [1, 1, 1]);
  assert.equal(source.environment.map.width, 4);
});

test('an asset file that is not a bare name in the scene folder is refused', async () => {
  const directory = await writeSceneFolder();
  const outsideFile = join(directory, '..', 'outside.rgba');
  const backslash = String.fromCharCode(92);
  const windowsPaths = [`..${backslash}outside.rgba`, `C:${backslash}Windows${backslash}win.ini`];
  for (const fileName of ['../outside.rgba', ...windowsPaths, outsideFile, '/etc/passwd', 'sub/texture-0.rgba', '', '.', '..', 'nul\u0000.rgba']) {
    assert.throws(() => resolveAssetFile(directory, fileName), RangeError, `refused ${JSON.stringify(fileName)}`);
  }
  assert.equal(resolveAssetFile(directory, 'texture-0.rgba'), join(directory, 'texture-0.rgba'));
});

test('an assetFile without an asset directory is refused with a message that says what to pass', async () => {
  assert.throws(() => resolveAssetFile(undefined, 'world.hdr'), /assetDirectory/);
  await assert.rejects(
    reconstructTraceSceneSource(describeScene({ type: 'hdri', assetFile: 'world.hdr', intensity: 1, radianceLimit: 60000 })),
    /assetDirectory/,
  );
});

test('a scene that names a path through assetFile cannot make the reader open it', async () => {
  const directory = await writeSceneFolder();
  const escaping = describeScene({ type: 'hdri', assetFile: '../world.hdr', intensity: 1, radianceLimit: 60000 });
  await assert.rejects(reconstructTraceSceneSource(escaping, undefined, { assetDirectory: directory }), /not a bare file name/);
  const escapingImage = { ...describeScene({ type: 'constant', value: 0.5 }), images: [{ width: 2, height: 1, assetFile: '../texture-0.rgba' }] };
  await assert.rejects(reconstructTraceSceneSource(escapingImage, undefined, { assetDirectory: directory }), /not a bare file name/);
});

test('an image file whose size does not match its width and height is refused', async () => {
  const directory = await writeSceneFolder();
  const wrongSize = { ...describeScene({ type: 'constant', value: 0.5 }), images: [{ width: 4, height: 4, assetFile: 'texture-0.rgba' }] };
  await assert.rejects(reconstructTraceSceneSource(wrongSize, undefined, { assetDirectory: directory }), /needs 64/);
});
