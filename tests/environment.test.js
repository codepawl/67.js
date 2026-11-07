import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentMap, computeIrradianceCoefficients, evaluateIrradiance, estimateEnvironmentBytes, environmentSpecularLayout, ENVIRONMENT_BRDF_SIZE, environmentShadingGlsl } from '../src/environment.js';
import { createFragmentShader } from '../src/shaders.js';
import { parseRadianceHdr, loadHdri } from '../src/hdri.js';

function filledMap(width, height, fillPixel, extra = {}) {
  const data = new Float32Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      data.set(fillPixel(column, row), (row * width + column) * 3);
    }
  }
  return createEnvironmentMap({ width, height, data, ...extra });
}

function hdrHeader(width, height) {
  return `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
}

function concatenate(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

test('spherical harmonic irradiance of a constant environment is constant in every direction', () => {
  const map = filledMap(64, 32, () => [0.5, 1, 2]);
  const coefficients = computeIrradianceCoefficients(map);
  for (const normal of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0, 0, -1], [0.577, 0.577, 0.577]]) {
    const irradiance = evaluateIrradiance(coefficients, normal);
    assert.ok(Math.abs(irradiance[0] - 0.5) < 0.01, `red ${irradiance[0]}`);
    assert.ok(Math.abs(irradiance[1] - 1) < 0.01, `green ${irradiance[1]}`);
    assert.ok(Math.abs(irradiance[2] - 2) < 0.02, `blue ${irradiance[2]}`);
  }
});

test('spherical harmonic irradiance follows a sky above, ground below split', () => {
  const map = filledMap(64, 32, (column, row) => (row < 16 ? [1, 1, 1] : [0, 0, 0]));
  const coefficients = computeIrradianceCoefficients(map);
  const up = evaluateIrradiance(coefficients, [0, 1, 0])[0];
  const down = evaluateIrradiance(coefficients, [0, -1, 0])[0];
  const side = evaluateIrradiance(coefficients, [1, 0, 0])[0];
  assert.ok(up > 0.9 && up < 1.05, `up ${up}`);
  assert.ok(down < 0.1, `down ${down}`);
  assert.ok(Math.abs(side - 0.5) < 0.05, `side ${side}`);
});

test('RGBE parsing decodes flat and run-length scanlines', () => {
  const flatPixels = Uint8Array.from([128, 64, 0, 129, 0, 0, 0, 0, 255, 255, 255, 128, 1, 2, 3, 136]);
  const flat = parseRadianceHdr(concatenate(new TextEncoder().encode(hdrHeader(4, 1)), flatPixels));
  assert.equal(flat.width, 4);
  assert.equal(flat.height, 1);
  assert.deepEqual(Array.from(flat.data.slice(0, 6)), [1, 0.5, 0, 0, 0, 0]);
  assert.ok(Math.abs(flat.data[6] - 255 / 256) < 1e-6);
  assert.deepEqual(Array.from(flat.data.slice(9, 12)), [1, 2, 3]);

  const width = 8;
  const runLengthRow = [2, 2, 0, width];
  for (const value of [128, 64, 32, 130]) runLengthRow.push(128 + width, value);
  const encoded = parseRadianceHdr(concatenate(new TextEncoder().encode(hdrHeader(width, 1)), Uint8Array.from(runLengthRow)));
  assert.deepEqual(Array.from(encoded.data.slice(0, 3)), [2, 1, 0.5]);
  assert.deepEqual(Array.from(encoded.data.slice(21, 24)), [2, 1, 0.5]);
});

test('RGBE parsing rejects malformed files', () => {
  const encoder = new TextEncoder();
  assert.throws(() => parseRadianceHdr(encoder.encode('not an hdr\n')), /#\?/);
  assert.throws(() => parseRadianceHdr(encoder.encode('#?RADIANCE\nFORMAT=32-bit_rle_xyze\n\n-Y 1 +X 1\n')), /Unsupported Radiance HDR format/);
  assert.throws(() => parseRadianceHdr(encoder.encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n+Y 1 +X 1\n')), /orientation/);
  assert.throws(() => parseRadianceHdr(concatenate(encoder.encode(hdrHeader(4, 1)), Uint8Array.from([1, 2, 3]))), /truncated/);
  const badRun = concatenate(encoder.encode(hdrHeader(8, 1)), Uint8Array.from([2, 2, 0, 8, 128 + 9, 1]));
  assert.throws(() => parseRadianceHdr(badRun), /run length/);
});

test('loadHdri fetches and wraps the parsed file in an environment map', async () => {
  const bytes = concatenate(new TextEncoder().encode(hdrHeader(4, 2)), new Uint8Array(4 * 2 * 4).fill(128));
  const fetchImplementation = async (url) => ({ ok: url.endsWith('.hdr'), status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  const map = await loadHdri('sky.hdr', { intensity: 2, showBackground: true, fetchImplementation });
  assert.equal(map.width, 4);
  assert.equal(map.intensity, 2);
  assert.equal(map.showBackground, true);
  await assert.rejects(loadHdri('sky.png', { fetchImplementation }), /HTTP/);
});

test('environment map validation names the offending field', () => {
  const data = new Float32Array(8 * 4 * 3);
  assert.throws(() => createEnvironmentMap({ width: 8.5, height: 4, data }), /width/);
  assert.throws(() => createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(10) }), /data length/);
  assert.throws(() => createEnvironmentMap({ width: 8, height: 4, data: Array.from(data) }), /Float32Array/);
  assert.throws(() => createEnvironmentMap({ width: 8, height: 4, data, intensity: -1 }), /intensity/);
  assert.throws(() => createEnvironmentMap({ width: 8, height: 4, data, rotation: Number.NaN }), /rotation/);
  assert.throws(() => createEnvironmentMap({ width: 8, height: 4, data, backgroundBlur: 2 }), /backgroundBlur/);
  assert.throws(() => createEnvironmentMap({ width: 8, height: 4, data, showBackground: 'yes' }), /showBackground/);
  const infinite = new Float32Array(data);
  infinite[5] = Number.POSITIVE_INFINITY;
  assert.throws(() => createEnvironmentMap({ width: 8, height: 4, data: infinite }), /finite/);
  const map = createEnvironmentMap({ width: 8, height: 4, data });
  assert.equal(Object.isFrozen(map), true);
  assert.equal(map.channels, 3);
  assert.equal(createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 4) }).channels, 4);
});

test('environment memory accounting counts the half-float chain and the BRDF lookup', () => {
  const map = { kind: 'environment-map', width: 2048, height: 1024, channels: 3, data: new Float32Array(2048 * 1024 * 3), intensity: 1, rotation: 0, showBackground: false, backgroundBlur: 0 };
  const layout = environmentSpecularLayout(map);
  assert.equal(layout.width, 1024);
  assert.equal(layout.height, 512);
  assert.equal(layout.levelCount, 7);
  let expected = ENVIRONMENT_BRDF_SIZE * ENVIRONMENT_BRDF_SIZE * 4;
  for (let level = 0; level < 7; level++) expected += (1024 >> level) * (512 >> level) * 8;
  assert.equal(estimateEnvironmentBytes(map, 4096), expected);
  assert.ok(expected < 8 * 1024 ** 2);
  assert.throws(() => estimateEnvironmentBytes(map, 1024), /texture limit/);
  const small = createEnvironmentMap({ width: 16, height: 8, data: new Float32Array(16 * 8 * 3) });
  assert.equal(environmentSpecularLayout(small).levelCount, 5);
  assert.throws(() => estimateEnvironmentBytes({ ...small, data: new Float32Array(3) }, 4096), /data length/);
});

test('environment specular adds the energy a rough surface scatters a second time', () => {
  assert.match(environmentShadingGlsl, /missingEnergy/);
  assert.match(environmentShadingGlsl, /return 1\.0 \/ \(1\.0 - missingEnergy \* averageFresnel\)/);
  assert.match(environmentShadingGlsl, /singleScatter \* multipleScatterGain\(lookup, baseReflectance\)/);
});

test('direct light specular takes the same multiple scatter gain once per fragment', () => {
  const source = createFragmentShader(['environmentMap']);
  assert.match(source, /specular \*= directSpecularGain;/);
  assert.equal(source.match(/directSpecularGain = multipleScatterGain/g).length, 1);
  assert.equal(source.match(/texture\(environmentBrdf/g).length, 2);
});

test('sunFromEnvironmentMap finds a synthetic sun at a known direction with rotation applied', async () => {
  const { sunFromEnvironmentMap, keyLightFromHdri } = await import('../src/hdri.js');
  const width = 256;
  const height = 128;
  const sunRow = 40;
  const sunColumn = 70;
  const rotation = 1.1;
  const map = filledMap(width, height, (column, row) => {
    const nearSun = Math.abs(column - sunColumn) <= 2 && Math.abs(row - sunRow) <= 2;
    return nearSun ? [400, 320, 200] : [0.4, 0.5, 0.6];
  }, { rotation });
  const azimuth = ((sunColumn + 0.5) / width - 0.5) * 2 * Math.PI;
  const polar = ((sunRow + 0.5) / height) * Math.PI;
  const inMap = [Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), -Math.sin(polar) * Math.cos(azimuth)];
  // The shader turns world into map by (cos x - sin z, y, sin x + cos z); the sun's world direction is the inverse turn.
  const expected = [Math.cos(rotation) * inMap[0] + Math.sin(rotation) * inMap[2], inMap[1], -Math.sin(rotation) * inMap[0] + Math.cos(rotation) * inMap[2]];
  const sun = sunFromEnvironmentMap(map);
  const dot = sun.lightDirection.reduce((sum, component, axis) => sum + component * expected[axis], 0);
  assert.ok(Math.acos(Math.min(1, dot)) < 0.01, 'within about half a degree');
  assert.equal(Math.max(...sun.keyColor), 1);
  assert.ok(sun.keyColor[2] < sun.keyColor[0]);
  assert.ok(sun.keyIntensity > 0);
  const lit = keyLightFromHdri(map, { min: [-1, 0, -1], max: [1, 2, 1] });
  assert.deepEqual(lit.shadowBounds.target, [0, 1, 0]);
  const toEye = lit.shadowBounds.eye.map((component, axis) => component - lit.shadowBounds.target[axis]);
  const eyeDot = toEye.reduce((sum, component, axis) => sum + component * sun.lightDirection[axis], 0) / Math.hypot(...toEye);
  assert.ok(eyeDot > 0.9999);
});

test('sunFromEnvironmentMap returns null for an overcast map', async () => {
  const { sunFromEnvironmentMap, keyLightFromHdri } = await import('../src/hdri.js');
  const map = filledMap(64, 32, (column, row) => [0.5 + row * 0.01, 0.5, 0.5]);
  assert.equal(sunFromEnvironmentMap(map), null);
  assert.equal(keyLightFromHdri(map, { min: [0, 0, 0], max: [1, 1, 1] }), null);
});
