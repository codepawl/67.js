import assert from 'node:assert/strict';
import test from 'node:test';
import { createGaussianSplats, createGaussianSplatsAsync, parseGaussianSplatPly, parseGaussianSplatPlyAsync } from '../src/gaussian-splats.js';

const PROPERTIES = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

function buildPly(splats) {
  const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${splats.length}`, ...PROPERTIES.map(name => `property float ${name}`), 'end_header', ''].join('\n');
  const headerBytes = new TextEncoder().encode(header);
  const body = new Float32Array(splats.length * PROPERTIES.length);
  splats.forEach((values, index) => body.set(values, index * PROPERTIES.length));
  const file = new Uint8Array(headerBytes.length + body.byteLength);
  file.set(headerBytes, 0);
  file.set(new Uint8Array(body.buffer), headerBytes.length);
  return file.buffer;
}

function buildManySplats(count) {
  const splats = [];
  for (let index = 0; index < count; index++) {
    const angle = index * 0.37;
    splats.push([Math.cos(angle) * index * 0.01, Math.sin(angle) * 2, index * 0.003, Math.sin(index), Math.cos(index), 0.3, Math.sin(angle) * 2, Math.log(0.05 + (index % 7) * 0.01), Math.log(0.1), Math.log(0.2), Math.cos(angle), Math.sin(angle), 0.2, 0.1]);
  }
  return splats;
}

function assertSameBytes(actual, expected) {
  const actualBytes = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength);
  const expectedBytes = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
  assert.equal(Buffer.compare(actualBytes, expectedBytes), 0);
}

test('async parse and pack equal the sync path byte for byte and report rising progress up to 1', async () => {
  const file = buildPly(buildManySplats(5000));
  const expected = parseGaussianSplatPly(file);
  const parseProgress = [];
  const parsed = await parseGaussianSplatPlyAsync(file, { chunkSize: 700, onProgress: fraction => parseProgress.push(fraction) });
  for (const name of ['positions', 'colors', 'scales', 'rotations']) assertSameBytes(parsed[name], expected[name]);
  assert.deepEqual(parsed.bounds, expected.bounds);
  assert.equal(parsed.count, expected.count);
  assert.equal(parseProgress.length, 8);
  assert.equal(parseProgress.at(-1), 1);
  assert.ok(parseProgress.every((fraction, index) => index === 0 || fraction > parseProgress[index - 1]));

  const packProgress = [];
  const packedAsync = await createGaussianSplatsAsync(parsed, { chunkSize: 1000, onProgress: fraction => packProgress.push(fraction) });
  const packedSync = createGaussianSplats(expected);
  assertSameBytes(packedAsync.packed.words, packedSync.packed.words);
  assert.equal(packedAsync.packed.rows, packedSync.packed.rows);
  assert.deepEqual(packedAsync.statistics, packedSync.statistics);
  assert.deepEqual(packProgress, [0.2, 0.4, 0.6, 0.8, 1]);
});

test('async steps yield to the event loop between slices', async () => {
  let macrotaskRan = false;
  setImmediate(() => { macrotaskRan = true; });
  await parseGaussianSplatPlyAsync(buildPly(buildManySplats(300)), { chunkSize: 100 });
  assert.equal(macrotaskRan, true);
});

test('async steps stop on an aborted signal with an AbortError and reject bad options', async () => {
  const file = buildPly(buildManySplats(1000));
  const controller = new AbortController();
  const abortAfterThirtyPercent = fraction => {
    if (fraction >= 0.3) controller.abort();
  };
  await assert.rejects(
    parseGaussianSplatPlyAsync(file, { chunkSize: 100, signal: controller.signal, onProgress: abortAfterThirtyPercent }),
    error => error.name === 'AbortError' && /parseGaussianSplatPlyAsync was aborted/.test(error.message),
  );
  await assert.rejects(createGaussianSplatsAsync(parseGaussianSplatPly(file), { signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(parseGaussianSplatPlyAsync(file, { chunkSize: 0 }), /chunkSize must be a positive whole number/);
  await assert.rejects(parseGaussianSplatPlyAsync(file, { onProgress: 3 }), /onProgress must be a function/);
  await assert.rejects(parseGaussianSplatPlyAsync(file, { signal: {} }), /signal must be an AbortSignal/);
  await assert.rejects(parseGaussianSplatPlyAsync(file, { maximumCount: 10 }), RangeError);
  await assert.rejects(createGaussianSplatsAsync({ count: 0 }), /at least one splat/);
});
