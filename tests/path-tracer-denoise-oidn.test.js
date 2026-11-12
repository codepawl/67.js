import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { decodePfm, denoiseWithOidn, encodePfm, findOidnBinary } from '../packages/denoise-oidn/index.mjs';
import { PATH_TRACER_DENOISERS as JOB_DENOISERS } from '../src/path-tracer-capabilities.js';
import { normalizePathTracerOptions, PATH_TRACER_DENOISERS, renderPathTracedImage } from '../src/path-tracer.js';
import { chooseDenoiser } from '../scripts/agent-path-trace-denoise.mjs';

test('denoise takes a boolean or a name and keeps the boolean the tracer reports', () => {
  assert.equal(normalizePathTracerOptions({}).denoiser, 'wavelet');
  assert.equal(normalizePathTracerOptions({ denoise: false }).denoiser, 'none');
  for (const name of PATH_TRACER_DENOISERS) {
    const options = normalizePathTracerOptions({ denoise: name });
    assert.equal(options.denoiser, name);
    assert.equal(options.denoise, name !== 'none');
  }
  assert.deepEqual([...JOB_DENOISERS], [...PATH_TRACER_DENOISERS]);
  assert.throws(() => normalizePathTracerOptions({ denoise: 'bm3d' }), /denoise must be/);
  assert.throws(() => normalizePathTracerOptions({ denoise: 1 }), /denoise must be/);
});

test('denoise "oidn" leaves the colour as traced and returns the feature images for the caller', async () => {
  const quad = { name: 'floor', geometry: { positions: new Float32Array([-4, 0, -4, 4, 0, -4, 4, 0, 4, -4, 0, 4]), normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), indices: new Uint32Array([0, 2, 1, 0, 3, 2]) },
    matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), material: { tag: 'surface', color: [0.8, 0.8, 0.8], metallic: 0, roughness: 0.5 } };
  const scene = { parts: [quad], environment: { skyColor: [0.5, 0.6, 0.8] }, camera: { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 } };
  const options = { width: 16, height: 16, samples: 4, bounces: 1, threads: 1 };
  const external = await renderPathTracedImage(scene, { ...options, denoise: 'oidn' });
  const none = await renderPathTracedImage(scene, { ...options, denoise: false });
  assert.deepEqual(external.linear, none.linear);
  assert.equal(external.report.denoiser, 'oidn');
  assert.equal(external.report.denoised, false);
  assert.equal(external.features.albedo.length, 16 * 16 * 3);
  assert.equal(external.features.normal.length, 16 * 16 * 3);
});

test('a job that asks for oidn without the binary runs the wavelet filter and says why', async context => {
  const saved = process.env.OIDN_DENOISE_PATH;
  process.env.OIDN_DENOISE_PATH = 'does-not-exist/oidnDenoise';
  context.after(() => {
    if (saved === undefined) delete process.env.OIDN_DENOISE_PATH;
    else process.env.OIDN_DENOISE_PATH = saved;
  });
  const choice = await chooseDenoiser('oidn');
  assert.equal(choice.denoise, 'wavelet');
  assert.match(choice.note, /oidn.*wavelet filter ran instead/s);
  assert.deepEqual(await chooseDenoiser(true), { denoise: true });
  await assert.rejects(denoiseWithOidn({ width: 1, height: 1, color: new Float32Array(3), albedo: new Float32Array(3), normal: new Float32Array(3) }), /not installed/);
});

test('PFM files keep the pixels and store rows bottom to top', () => {
  const pixels = Float32Array.from({ length: 4 * 3 * 3 }, (_, index) => index / 7);
  const bytes = encodePfm(pixels, 4, 3);
  assert.equal(bytes.toString('latin1', 0, 12), 'PF\n4 3\n-1.0\n');
  const firstStoredRow = new Float32Array(bytes.buffer.slice(bytes.byteOffset + 12, bytes.byteOffset + 12 + 48));
  assert.deepEqual(firstStoredRow, pixels.subarray(24, 36));
  assert.deepEqual(decodePfm(bytes, 4, 3), pixels);
  assert.throws(() => decodePfm(bytes, 5, 3), /not the expected/);
});

test('the installed OIDN removes noise from a flat image and gives the same bytes twice', { skip: findOidnBinary() ? false : 'the oidnDenoise binary is not fetched' }, async () => {
  assert.ok(existsSync(findOidnBinary()));
  const width = 64;
  const height = 64;
  let state = 12345;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const color = Float32Array.from({ length: width * height * 3 }, () => 0.5 + (random() - 0.5) * 0.4);
  const albedo = new Float32Array(width * height * 3).fill(0.8);
  const normal = Float32Array.from({ length: width * height * 3 }, (_, index) => (index % 3 === 1 ? 1 : 0));
  const spread = values => Math.max(...values) - Math.min(...values);
  const first = await denoiseWithOidn({ width, height, color, albedo, normal });
  const second = await denoiseWithOidn({ width, height, color, albedo, normal });
  assert.ok(spread(first) < spread(color), `spread ${spread(first)} against ${spread(color)}`);
  assert.deepEqual(first, second);
});

test('the native default (denoise true) picks OIDN when it is installed and the GPU a-trous filter with a note when it is not', async () => {
  const installed = { findOidnBinary: () => 'oidn' };
  const withOidn = await chooseDenoiser(true, { preferOidn: true, loadOidn: async () => installed });
  assert.equal(withOidn.denoise, 'oidn');
  assert.equal(withOidn.denoiser, installed);
  assert.match(withOidn.note, /OIDN and the albedo and normal guides by default/);
  const without = await chooseDenoiser(true, { preferOidn: true, loadOidn: async () => null });
  assert.equal(without.denoise, 'atrous');
  assert.match(without.note, /native backend denoises with OIDN.*GPU a-trous filter ran instead/s);
  const explicit = await chooseDenoiser('oidn', { preferOidn: true, loadOidn: async () => null });
  assert.equal(explicit.denoise, 'atrous');
  assert.match(explicit.note, /denoise "oidn".*GPU a-trous filter ran instead/s);
  const otherBackends = await chooseDenoiser(true, { loadOidn: async () => null });
  assert.deepEqual(otherBackends, { denoise: true });
  assert.equal((await chooseDenoiser('oidn', { loadOidn: async () => null })).denoise, 'wavelet');
});

test('explicit denoise values keep their meaning on native and the other backends keep the plain default', async () => {
  const loadOidn = async () => { throw new Error('must not load OIDN'); };
  assert.deepEqual(await chooseDenoiser(false, { preferOidn: true, loadOidn }), { denoise: false });
  assert.deepEqual(await chooseDenoiser('wavelet', { preferOidn: true, loadOidn }), { denoise: 'wavelet' });
  assert.deepEqual(await chooseDenoiser('none', { preferOidn: true, loadOidn }), { denoise: 'none' });
  assert.deepEqual(await chooseDenoiser(true, { loadOidn }), { denoise: true });
});

test('a source checkout finds the fetched OIDN package without it being installed under node_modules', { skip: findOidnBinary() ? false : 'the oidnDenoise binary is not fetched' }, async () => {
  const choice = await chooseDenoiser('oidn');
  assert.equal(choice.denoise, 'oidn');
  assert.equal(typeof choice.denoiser.denoiseWithOidn, 'function');
});
