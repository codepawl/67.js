import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { parseGaussianSplatPly, parseGaussianSplatSpz, parseGaussianSplatSpzAsync } from '../src/gaussian-splats.js';

// A small SPZ encoder written from the format in github.com/nianticlabs/spz (load-spz.cc, splat-utils.h).
const FRACTIONAL_BITS = 12;

function encodeRotationFirstThree(quaternion) {
  const [w, x, y, z] = quaternion;
  const sign = w < 0 ? -1 : 1;
  return [x, y, z].map(component => Math.round(Math.max(-1, Math.min(1, component * sign)) * 127.5 + 127.5));
}

function encodeRotationSmallestThree(quaternion) {
  const [w, x, y, z] = quaternion;
  const components = [x, y, z, w];
  let largest = 0;
  for (let index = 1; index < 4; index++) {
    if (Math.abs(components[index]) > Math.abs(components[largest])) largest = index;
  }
  const flip = components[largest] < 0 ? -1 : 1;
  let packed = largest;
  for (let index = 0; index < 4; index++) {
    if (index === largest) continue;
    const value = components[index] * flip;
    const magnitude = Math.round(511 * Math.abs(value) / Math.SQRT1_2);
    packed = ((packed << 10) | ((value < 0 ? 1 : 0) << 9) | magnitude) >>> 0;
  }
  return [packed & 255, (packed >>> 8) & 255, (packed >>> 16) & 255, packed >>> 24];
}

function buildSpz(splats, { version = 3, shDegree = 0, extraTrailing = 0, compress = true } = {}) {
  const count = splats.length;
  const shValues = [0, 3, 8, 15, 24][shDegree] * 3;
  const rotationBytes = version >= 3 ? 4 : 3;
  const body = new Uint8Array(16 + count * (9 + 1 + 3 + 3 + rotationBytes + shValues) + extraTrailing);
  const view = new DataView(body.buffer);
  view.setUint32(0, 0x5053474e, true);
  view.setUint32(4, version, true);
  view.setUint32(8, count, true);
  body[12] = shDegree;
  body[13] = FRACTIONAL_BITS;
  const alphasOffset = 16 + count * 9;
  const colorsOffset = alphasOffset + count;
  const scalesOffset = colorsOffset + count * 3;
  const rotationsOffset = scalesOffset + count * 3;
  splats.forEach((splat, index) => {
    splat.position.forEach((coordinate, axis) => {
      const fixed = Math.round(coordinate * 2 ** FRACTIONAL_BITS) & 0xffffff;
      const offset = 16 + (index * 3 + axis) * 3;
      body[offset] = fixed & 255;
      body[offset + 1] = (fixed >>> 8) & 255;
      body[offset + 2] = fixed >>> 16;
    });
    body[alphasOffset + index] = Math.round(splat.alpha * 255);
    splat.colorHarmonic.forEach((harmonic, axis) => {
      body[colorsOffset + index * 3 + axis] = Math.round(Math.max(0, Math.min(255, (harmonic * 0.15 + 0.5) * 255)));
    });
    splat.logScale.forEach((logScale, axis) => {
      body[scalesOffset + index * 3 + axis] = Math.round((logScale + 10) * 16);
    });
    const encoded = version >= 3 ? encodeRotationSmallestThree(splat.rotation) : encodeRotationFirstThree(splat.rotation);
    body.set(encoded, rotationsOffset + index * rotationBytes);
  });
  body.fill(77, rotationsOffset + count * rotationBytes);
  return compress ? new Uint8Array(gzipSync(body)) : body;
}

function normalized(quaternion) {
  const length = Math.hypot(...quaternion);
  return quaternion.map(component => component / length);
}

const SPLATS = [
  { position: [0, 0, 0], alpha: 0.5, colorHarmonic: [0, 0, 0], logScale: [-3, -2, -1], rotation: [1, 0, 0, 0] },
  { position: [1.25, -2.5, 3.75], alpha: 1, colorHarmonic: [1, -1, 0.5], logScale: [-4.5, -0.25, 0], rotation: normalized([0.3, -0.5, 0.7, 0.4]) },
  { position: [-100.125, 50.5, -0.001], alpha: 0.1, colorHarmonic: [-2, 2, 0], logScale: [1, 2, -9], rotation: normalized([-0.1, 0.8, -0.2, -0.5]) },
];

function assertClose(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} differs from ${expected} by more than ${tolerance}`);
}

function quaternionDot(data, index, expected) {
  let dot = 0;
  for (let component = 0; component < 4; component++) dot += data.rotations[index * 4 + component] * expected[component];
  return Math.abs(dot);
}

for (const version of [2, 3]) {
  test(`SPZ version ${version} decodes to the expected splats within quantization error`, async () => {
    const data = await parseGaussianSplatSpz(buildSpz(SPLATS, { version }));
    assert.equal(data.count, SPLATS.length);
    SPLATS.forEach((splat, index) => {
      splat.position.forEach((coordinate, axis) => assertClose(data.positions[index * 3 + axis], coordinate, 1 / 2 ** FRACTIONAL_BITS, 'position'));
      splat.logScale.forEach((logScale, axis) => assertClose(Math.log(data.scales[index * 3 + axis]), logScale, 1 / 32 + 1e-6, 'log scale'));
      assertClose(data.colors[index * 4 + 3], splat.alpha * 255, 0.51, 'alpha');
      splat.colorHarmonic.forEach((harmonic, axis) => {
        const expected = Math.max(0, Math.min(255, (0.5 + 0.28209479177387814 * harmonic) * 255));
        assertClose(data.colors[index * 4 + axis], expected, 3, 'color');
      });
      assert.ok(quaternionDot(data, index, splat.rotation) > 0.995, `rotation ${index} should match up to sign`);
    });
    assert.deepEqual(data.bounds.minimum.map(value => Math.round(value * 1000)), [-100125, -2500, -1]);
    assert.deepEqual(data.bounds.maximum.map(value => Math.round(value * 1000)), [1250, 50500, 3750]);
  });
}

test('SPZ skips spherical harmonic bands and ignores trailing bytes', async () => {
  const plain = await parseGaussianSplatSpz(buildSpz(SPLATS));
  const withBands = await parseGaussianSplatSpz(buildSpz(SPLATS, { shDegree: 2, extraTrailing: 40 }));
  assert.deepEqual(withBands.positions, plain.positions);
  assert.deepEqual(withBands.colors, plain.colors);
});

test('SPZ result has the same shape and types as the PLY result', async () => {
  const plyHeader = ['ply', 'format binary_little_endian 1.0', 'element vertex 1', ...['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'].map(name => `property float ${name}`), 'end_header', ''].join('\n');
  const headerBytes = new TextEncoder().encode(plyHeader);
  const ply = new Uint8Array(headerBytes.length + 14 * 4);
  ply.set(headerBytes);
  const fromPly = parseGaussianSplatPly(ply.buffer);
  const fromSpz = await parseGaussianSplatSpz(buildSpz(SPLATS.slice(0, 1)));
  assert.deepEqual(Object.keys(fromSpz), Object.keys(fromPly));
  for (const key of ['positions', 'colors', 'scales', 'rotations']) {
    assert.equal(fromSpz[key].constructor, fromPly[key].constructor, key);
  }
});

test('SPZ async twin returns the same data, reports progress up to 1 and honours abort', async () => {
  const splats = Array.from({ length: 25 }, (_, index) => ({ ...SPLATS[1], position: [index, 0, -index] }));
  const file = buildSpz(splats);
  const direct = await parseGaussianSplatSpz(file);
  const fractions = [];
  const sliced = await parseGaussianSplatSpzAsync(file, { chunkSize: 10, onProgress: fraction => fractions.push(fraction) });
  assert.deepEqual(sliced.positions, direct.positions);
  assert.deepEqual(sliced.rotations, direct.rotations);
  assert.deepEqual(fractions, [0.4, 0.8, 1]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(parseGaussianSplatSpzAsync(file, { signal: controller.signal }), { name: 'AbortError' });
});

test('SPZ rejects bad input with clear errors', async () => {
  const good = buildSpz(SPLATS);
  await assert.rejects(parseGaussianSplatSpz('nope'), { name: 'TypeError', message: /ArrayBuffer or a typed array/ });
  await assert.rejects(parseGaussianSplatSpz(new Uint8Array([1, 2, 3, 4])), { message: /must be a gzip stream/ });
  const badMagic = buildSpz(SPLATS, { compress: false });
  badMagic[0] = 0;
  await assert.rejects(parseGaussianSplatSpz(new Uint8Array(gzipSync(badMagic))), { message: /magic "NGSP"/ });
  await assert.rejects(parseGaussianSplatSpz(buildSpz(SPLATS, { version: 3, compress: false })), { message: /SPZ version 4|gzip/ });
  await assert.rejects(parseGaussianSplatSpz(good.subarray(0, good.length - 12)), { message: /Error|truncated|gzip/i });
  const truncatedBody = buildSpz(SPLATS, { compress: false }).subarray(0, 40);
  await assert.rejects(parseGaussianSplatSpz(new Uint8Array(gzipSync(truncatedBody))), { message: /truncated: 3 splats need/ });
  await assert.rejects(parseGaussianSplatSpz(new Uint8Array(gzipSync(new Uint8Array(8)))), { message: /shorter than the 16 byte header/ });
});

test('SPZ rejects unsupported versions, degrees and over-limit counts before reading splats', async () => {
  for (const version of [1, 4, 9]) {
    await assert.rejects(parseGaussianSplatSpz(buildSpz(SPLATS, { version })), { message: new RegExp(`version ${version} is not supported`) });
  }
  const badDegree = buildSpz(SPLATS, { compress: false });
  badDegree[12] = 5;
  await assert.rejects(parseGaussianSplatSpz(new Uint8Array(gzipSync(badDegree))), { message: /degree 5/ });
  await assert.rejects(parseGaussianSplatSpz(buildSpz(SPLATS), { maximumCount: 2 }), { name: 'RangeError', message: /holds 3 splats, over the limit of 2/ });
  await assert.rejects(parseGaussianSplatSpz(buildSpz(SPLATS), { maximumBytes: 20 }), { name: 'RangeError', message: /over the limit of 20/ });
  const repetitive = buildSpz(Array.from({ length: 500 }, () => SPLATS[0]));
  assert.ok(repetitive.length < 1000, 'repetitive file compresses well');
  await assert.rejects(parseGaussianSplatSpz(repetitive, { maximumBytes: 1000 }), { name: 'RangeError', message: /inflates to 10016 bytes, over the limit of 1000/ });
  const hugeCount = buildSpz(SPLATS, { compress: false });
  new DataView(hugeCount.buffer).setUint32(8, 4_000_001, true);
  await assert.rejects(parseGaussianSplatSpz(new Uint8Array(gzipSync(hugeCount)), { maximumCount: 10_000_000 }), { name: 'RangeError', message: /over the limit of 4000000/ });
  await assert.rejects(parseGaussianSplatSpz(buildSpz(SPLATS), { maximumCount: 0 }), { name: 'RangeError' });
});
