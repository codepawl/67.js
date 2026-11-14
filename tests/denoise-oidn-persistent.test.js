import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createOidnDenoiser, denoiseWithOidn, findOidnBinary, findOidnLibrary } from '../packages/denoise-oidn/index.mjs';
import { denoiseFrameWithOidn } from '../scripts/agent-native-trace.mjs';
import { cookInstalled, cookModule, cookTest } from './support/cook.js';

const { createNativeOidnDenoiser, findNativeAddon } = (await cookModule()) ?? {};

const LIBRARY_LAYOUTS = {
  win32: { directory: 'bin', name: 'OpenImageDenoise.dll', tool: 'oidnDenoise.exe' },
  darwin: { directory: 'lib', name: 'libOpenImageDenoise.2.dylib', tool: 'oidnDenoise' },
  linux: { directory: 'lib', name: 'libOpenImageDenoise.so.2', tool: 'oidnDenoise' },
};

function withEnvironment(context, values) {
  const saved = {};
  for (const [name, value] of Object.entries(values)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  context.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function fakeNative(calls) {
  return options => {
    calls.push({ type: 'create', options });
    return {
      deviceSeconds: 0.25,
      denoise(frame) {
        calls.push({ type: 'denoise', width: frame.width, hasAlbedo: Boolean(frame.albedo) });
        return { color: new Float32Array(frame.color).map(value => value * 2), recommitted: calls.length < 3, commitSeconds: 0.1, writeSeconds: 0.01, executeSeconds: 0.02, readSeconds: 0.01 };
      },
      close() { calls.push({ type: 'close' }); },
    };
  };
}

const FRAME = { width: 1, height: 2, color: new Float32Array([1, 2, 3, 4, 5, 6]), albedo: new Float32Array(6), normal: new Float32Array(6) };

test('findOidnLibrary reads OIDN_LIBRARY_PATH and the release folder of the tool', context => {
  const layout = LIBRARY_LAYOUTS[process.platform];
  if (!layout) return context.skip('no official OIDN build for this platform');
  const release = mkdtempSync(join(tmpdir(), 'crucible-oidn-layout-'));
  context.after(() => rmSync(release, { recursive: true, force: true }));
  mkdirSync(join(release, 'bin'), { recursive: true });
  mkdirSync(join(release, layout.directory), { recursive: true });
  writeFileSync(join(release, 'bin', layout.tool), '');
  withEnvironment(context, { OIDN_LIBRARY_PATH: undefined, OIDN_DENOISE_PATH: join(release, 'bin', layout.tool) });
  assert.equal(findOidnLibrary(), null);
  writeFileSync(join(release, layout.directory, layout.name), '');
  assert.equal(findOidnLibrary(), join(release, layout.directory, layout.name));
  process.env.OIDN_LIBRARY_PATH = join(release, 'missing.so');
  assert.equal(findOidnLibrary(), null);
  process.env.OIDN_LIBRARY_PATH = join(release, layout.directory, layout.name);
  assert.equal(findOidnLibrary(), join(release, layout.directory, layout.name));
});

test('createOidnDenoiser says what to pass or install, and passes the options to the native object', () => {
  assert.throws(() => createOidnDenoiser({}), /createNative/);
  assert.throws(() => createOidnDenoiser({ createNative: fakeNative([]), libraryPath: '' }), /npm run fetch/);
  assert.throws(() => createOidnDenoiser({ createNative: fakeNative([]), libraryPath: 'oidn.so', device: 'tpu' }), /device "tpu" is unknown/);
  const calls = [];
  const denoiser = createOidnDenoiser({ createNative: fakeNative(calls), libraryPath: 'oidn.so', device: 'cuda', quality: 'balanced', cleanAux: true, threads: 4 });
  assert.deepEqual(calls[0].options, { libraryPath: 'oidn.so', device: 'cuda', quality: 'balanced', cleanAux: true, threads: 4 });
  assert.equal(denoiser.deviceSeconds, 0.25);
  assert.equal(denoiser.lastTimings, null);
  denoiser.close();
  assert.equal(calls.at(-1).type, 'close');
});

test('a persistent denoiser resolves with the filtered pixels and keeps the timings apart', async () => {
  const calls = [];
  const denoiser = createOidnDenoiser({ createNative: fakeNative(calls), libraryPath: 'oidn.so' });
  const filtered = await denoiser.denoise(FRAME);
  assert.deepEqual([...filtered], [2, 4, 6, 8, 10, 12]);
  assert.deepEqual(Object.keys(denoiser.lastTimings).sort(), ['commitSeconds', 'executeSeconds', 'readSeconds', 'recommitted', 'writeSeconds']);
});

cookTest('createNativeOidnDenoiser asks for the library path before it loads anything', () => {
  assert.throws(() => createNativeOidnDenoiser({}), /libraryPath/);
  assert.throws(() => createNativeOidnDenoiser({ libraryPath: '' }), /libraryPath/);
});

test('a job frame uses one persistent device per package and the tool when it cannot', async () => {
  const created = [];
  const persistentPackage = {
    createOidnDenoiser: options => {
      created.push(options);
      return { denoise: async frame => new Float32Array(frame.color) };
    },
    denoiseWithOidn: async () => { throw new Error('the tool must not run'); },
  };
  const tracer = { createNativeOidnDenoiser: () => ({}) };
  const first = await denoiseFrameWithOidn({ tracer, denoiser: persistentPackage, ...FRAME });
  const second = await denoiseFrameWithOidn({ tracer, denoiser: persistentPackage, ...FRAME });
  assert.equal(first.mode, 'in-process');
  assert.equal(second.mode, 'in-process');
  assert.equal(created.length, 1);
  assert.equal(created[0].createNative, tracer.createNativeOidnDenoiser);

  const toolOnly = { denoiseWithOidn: async frame => frame.color };
  const withoutPersistence = await denoiseFrameWithOidn({ tracer, denoiser: toolOnly, ...FRAME });
  assert.deepEqual({ mode: withoutPersistence.mode, note: withoutPersistence.note }, { mode: 'cli', note: undefined });

  const missingLibrary = { createOidnDenoiser: () => { throw new Error('The OIDN shared library is not installed'); }, denoiseWithOidn: async frame => frame.color };
  const afterMissing = await denoiseFrameWithOidn({ tracer, denoiser: missingLibrary, ...FRAME });
  assert.equal(afterMissing.mode, 'cli');
  assert.match(afterMissing.note, /not installed.*oidnDenoise tool ran instead/);

  const crashing = { createOidnDenoiser: () => ({ denoise: async () => { throw new Error('CUDA out of memory'); } }), denoiseWithOidn: async frame => frame.color };
  const afterCrash = await denoiseFrameWithOidn({ tracer, denoiser: crashing, ...FRAME });
  assert.equal(afterCrash.mode, 'cli');
  assert.match(afterCrash.note, /CUDA out of memory/);

  const tracerWithoutSupport = await denoiseFrameWithOidn({ tracer: {}, denoiser: { ...persistentPackage, denoiseWithOidn: async frame => frame.color }, ...FRAME });
  assert.equal(tracerWithoutSupport.mode, 'cli');
});

const skipWithoutLibrary = !cookInstalled || !findOidnLibrary() || !findOidnBinary() || !findNativeAddon() ? 'needs the OIDN release (npm run fetch) and the built Cook addon' : false;

function noisyFrame(width, height) {
  const pixels = width * height * 3;
  const color = new Float32Array(pixels);
  const albedo = new Float32Array(pixels).fill(0.5);
  const normal = new Float32Array(pixels);
  let state = 7;
  for (let index = 0; index < pixels; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    color[index] = 0.5 + state / 4294967296;
    if (index % 3 === 1) normal[index] = 1;
  }
  return { width, height, color, albedo, normal };
}

cookTest('the in-process device matches the tool and repeats exactly on the CPU', { skip: skipWithoutLibrary }, async () => {
  const frame = noisyFrame(48, 32);
  const denoiser = createOidnDenoiser({ createNative: createNativeOidnDenoiser, device: 'cpu' });
  try {
    const first = await denoiser.denoise(frame);
    assert.equal(denoiser.lastTimings.recommitted, true);
    const warm = await denoiser.denoise(frame);
    assert.equal(denoiser.lastTimings.recommitted, false);
    assert.deepEqual(warm, first);
    const viaTool = await denoiseWithOidn({ ...frame, device: 'cpu' });
    let largest = 0;
    for (let index = 0; index < warm.length; index++) largest = Math.max(largest, Math.abs(warm[index] - viaTool[index]));
    assert.ok(largest < 1e-4, `in-process and tool differ by ${largest}`);
    await denoiser.denoise(noisyFrame(16, 16));
    assert.equal(denoiser.lastTimings.recommitted, true);
    await assert.rejects(denoiser.denoise({ ...frame, color: new Float32Array(3) }), /color/);
  } finally {
    denoiser.close();
  }
  await assert.rejects(denoiser.denoise(frame), /closed/);
});
