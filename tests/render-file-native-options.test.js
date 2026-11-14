import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { findNativeAddon } from '../packages/render-native/index.mjs';
import { MissingAddonError, USAGE, listIgnoredFrameEffects, missingAddonMessage, parseArguments, readCameraFile } from '../scripts/render-file-native-options.mjs';

const REQUIRED = ['--config', 'scene.json', '--out', 'out/frame'];
const COMMAND = fileURLToPath(new URL('../scripts/render-file-native.mjs', import.meta.url));

function withTemporaryFile(contents, run) {
  const directory = mkdtempSync(join(tmpdir(), 'render-file-native-'));
  try {
    const file = join(directory, 'camera.json');
    writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
    return run(file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the defaults are 800 x 450, 128 samples, 8 bounces, seed 1, OIDN and no camera override', () => {
  const options = parseArguments(REQUIRED);
  assert.equal(options.config, resolve('scene.json'));
  assert.equal(options.outputPrefix, resolve('out/frame'));
  assert.deepEqual([options.width, options.height, options.samples, options.bounces, options.seed, options.maxSeconds], [800, 450, 128, 8, 1, 600]);
  assert.equal(options.denoise, 'oidn');
  assert.equal(options.camera, null);
  assert.equal(options.writeRaw, false);
  assert.equal(options.instancing, false);
  assert.deepEqual(options.patchMaterials, []);
});

test('numbers, switches and strings are read from the command line', () => {
  const options = parseArguments([...REQUIRED, '--width', '1280', '--height', '720', '--samples', '512', '--bounces', '12', '--seed', '0', '--max-seconds', '30',
    '--denoise', 'none', '--write-raw', '--instancing', '--software-gl', '--chrome', 'chrome.exe', '--list-parts', 'glass', '--hide-parts', 'roof']);
  assert.deepEqual([options.width, options.height, options.samples, options.bounces, options.seed, options.maxSeconds], [1280, 720, 512, 12, 0, 30]);
  assert.equal(options.denoise, 'none');
  assert.equal(options.writeRaw && options.instancing && options.softwareGl, true);
  assert.equal(options.chrome, 'chrome.exe');
  assert.equal(options.listParts, 'glass');
  assert.equal(options.hideParts, 'roof');
});

test('--help returns the usage request without needing the other options', () => {
  assert.deepEqual(parseArguments(['--help']), { help: true });
  assert.match(USAGE, /--camera <camera\.json>/);
  assert.match(USAGE, /--write-raw/);
});

test('missing required options and unknown arguments say what to pass', () => {
  assert.throws(() => parseArguments([]), /Pass --config <scene\.json> and --out <prefix>/);
  assert.throws(() => parseArguments(['--config', 'a.json']), /Pass --config/);
  assert.throws(() => parseArguments([...REQUIRED, '--sample', '5']), /Unknown argument "--sample"/);
  assert.throws(() => parseArguments([...REQUIRED, '--width']), /Flag --width requires a value/);
});

test('each numeric option is checked with a message that names the range', () => {
  const cases = [
    ['--samples', '0', /--samples must be a whole number from 1 to 100000, got "0"/],
    ['--bounces', '17', /--bounces must be a whole number from 1 to 16/],
    ['--seed', '-1', /--seed must be a whole number from 0 to 2147483647/],
    ['--width', '8', /--width must be a whole number from 16 to 8192/],
    ['--height', '1.5', /--height must be a whole number from 16 to 8192, got "1\.5"/],
    ['--max-seconds', 'soon', /--max-seconds must be a whole number from 1 to 86400, got "soon"/],
  ];
  for (const [flag, value, message] of cases) {
    assert.throws(() => parseArguments([...REQUIRED, flag, value]), message, flag);
  }
});

test('--denoise accepts oidn, atrous and none only', () => {
  assert.equal(parseArguments([...REQUIRED, '--denoise', 'atrous']).denoise, 'atrous');
  assert.throws(() => parseArguments([...REQUIRED, '--denoise', 'wavelet']), /--denoise must be oidn, atrous or none, got "wavelet"/);
});

test('--patch-materials is repeatable and validated', () => {
  const options = parseArguments([...REQUIRED, '--patch-materials', 'glass={"alphaMode":"OPAQUE"}', '--patch-materials', 'leaf={"opacity":1}']);
  assert.deepEqual(options.patchMaterials, [{ pattern: 'glass', patch: { alphaMode: 'OPAQUE' } }, { pattern: 'leaf', patch: { opacity: 1 } }]);
  assert.throws(() => parseArguments([...REQUIRED, '--patch-materials', 'glass']), /needs "<part regex>=\{json\}"/);
  assert.throws(() => parseArguments([...REQUIRED, '--patch-materials', 'glass={oops}']), /JSON that does not parse/);
});

test('--camera reads eye, target and verticalFovDegrees or fov', () => {
  withTemporaryFile({ eye: [0, 1, 5], target: [0, 1, 0], verticalFovDegrees: 40 }, file => {
    assert.deepEqual(parseArguments([...REQUIRED, '--camera', file]).camera, { eye: [0, 1, 5], target: [0, 1, 0], fov: 40 });
  });
  withTemporaryFile({ eye: [1, 2, 3], target: [0, 0, 0], fov: 55 }, file => {
    assert.equal(readCameraFile(file).fov, 55);
  });
});

test('--camera names the field that is missing or wrong', () => {
  withTemporaryFile({ target: [0, 0, 0], fov: 40 }, file => assert.throws(() => readCameraFile(file), /needs "eye" as \[x, y, z\]/));
  withTemporaryFile({ eye: [0, 0, 1], target: [0, 0], fov: 40 }, file => assert.throws(() => readCameraFile(file), /needs "target" as \[x, y, z\]/));
  withTemporaryFile({ eye: [0, 0, 1], target: [0, 0, 0] }, file => assert.throws(() => readCameraFile(file), /needs "verticalFovDegrees" \(or "fov"\)/));
  withTemporaryFile({ eye: [0, 0, 1], target: [0, 0, 0], fov: 200 }, file => assert.throws(() => readCameraFile(file), /between 1 and 170/));
  withTemporaryFile('not json', file => assert.throws(() => readCameraFile(file), /could not read .* as JSON/));
  assert.throws(() => readCameraFile(join(tmpdir(), 'no-such-camera-file.json')), /Option --camera could not read/);
});

test('the missing-addon message names what is missing and the build command', () => {
  const message = missingAddonMessage();
  assert.match(message, /render-native addon/);
  assert.match(message, /node build\.mjs" in packages\/render-native/);
  assert.equal(new MissingAddonError().message, message);
});

test('frame effects the traced picture does not get are listed', () => {
  assert.deepEqual(listIgnoredFrameEffects({}), []);
  assert.deepEqual(listIgnoredFrameEffects({ exposure: 1, frame: { effects: { saturation: 1, vignette: 0 } } }), []);
  const ignored = listIgnoredFrameEffects({ exposure: 1.4, frame: { effects: { saturation: 1.2, contrast: 1.1, vignette: 0.3, bloom: { strength: 0.2 } }, cinematic: true } });
  assert.deepEqual(ignored, ['exposure', 'saturation', 'contrast', 'vignette', 'bloom', 'cinematic']);
});

test('--help on the command prints the usage and exits 0', () => {
  const result = spawnSync(process.execPath, [COMMAND, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: node scripts\/render-file-native\.mjs/);
});

test('without the built addon the command exits 2 with one message and no stack trace', { skip: findNativeAddon() ? 'the render-native addon is built here' : false }, () => {
  const result = spawnSync(process.execPath, [COMMAND, '--config', 'scene.json', '--out', join(tmpdir(), 'render-file-native-unused')], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stderr.trim(), missingAddonMessage());
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});
