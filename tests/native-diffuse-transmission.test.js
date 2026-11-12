import assert from 'node:assert/strict';
import test from 'node:test';
import { STRUCT_STRIDES_V2, findNativeAddon, prepareCyclesInput, probeCyclesLobe, traceNative } from '../packages/render-native/index.mjs';
import { buildFlattenedJobNativeInput, buildJobNativeInput, carriedMaterialFields } from '../packages/render-native/job-input.mjs';
import { packMaterialRecordV2 } from '../packages/render-native/pack-input-v2.mjs';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene, resolveTexture } from '../src/path-tracer-scene.js';

const WIDTH = 16;
const HEIGHT = 16;
const MATERIAL_STRIDE = STRUCT_STRIDES_V2.material;
const SUN_BEHIND_THE_SHEET = [0, 0, -1];
const SUN_IN_FRONT_OF_THE_SHEET = [0, 0, 1];
const SUN_COLOR = [3, 3, 3];
const camera = createCamera({ eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 30 }, WIDTH, HEIGHT);
const packOptions = { width: WIDTH, height: HEIGHT, samples: 64, bounces: 4, seed: 7, fireflyClamp: 0, noiseThreshold: 0 };
const traceOptions = { width: WIDTH, height: HEIGHT, samples: 64, maxSeconds: 60, kernel: 'cycles', noiseThreshold: 0 };

function sunEnvironment(lightDirection, keyColor = SUN_COLOR) {
  return { keyColor, lightDirection };
}

function sheet(material) {
  return {
    name: 'sheet',
    geometry: {
      positions: Float32Array.from([-3, -3, 0, 3, -3, 0, 3, 3, 0, -3, 3, 0]),
      normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    },
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    material: { roughness: 1, metallic: 0, specular: 0, ...material },
  };
}

function jobInputOf(parts, environment) {
  const scene = buildTraceScene(parts, environment);
  return buildFlattenedJobNativeInput(scene, camera, packOptions, pack, resolveTexture);
}

function bytesOf(view) {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

function recordFloats(input, index) {
  const record = bytesOf(input.materials).subarray(index * MATERIAL_STRIDE, (index + 1) * MATERIAL_STRIDE);
  const copy = Uint8Array.from(record);
  return { floats: new Float32Array(copy.buffer), words: new Uint32Array(copy.buffer) };
}

test('a material without diffuse transmission packs the table it always did, also at weight 0', () => {
  const environment = sunEnvironment(SUN_BEHIND_THE_SHEET);
  const plain = jobInputOf([sheet({ color: [0.6, 0.5, 0.4] })], environment);
  const zeroWeight = jobInputOf([sheet({ color: [0.6, 0.5, 0.4], diffuseTransmission: 0 })], environment);
  const colorOnly = jobInputOf([sheet({ color: [0.6, 0.5, 0.4], diffuseTransmissionColor: [1, 0, 0] })], environment);
  assert.equal(plain.materials.byteLength, plain.materialCount * MATERIAL_STRIDE, 'no extension records');
  for (const other of [zeroWeight, colorOnly]) {
    assert.equal(Buffer.compare(bytesOf(other.materials), bytesOf(plain.materials)), 0);
    assert.equal(Buffer.compare(bytesOf(other.kernelParams), bytesOf(plain.kernelParams)), 0);
  }
});

test('diffuse transmission appends one extension record per material and leaves the material records alone', () => {
  const environment = sunEnvironment(SUN_BEHIND_THE_SHEET);
  const plainParts = [sheet({ color: [0.6, 0.5, 0.4] }), { ...sheet({ color: [0.2, 0.3, 0.9] }), name: 'second' }];
  const translucentParts = [
    sheet({ color: [0.6, 0.5, 0.4], diffuseTransmission: 0.5, diffuseTransmissionColor: [0.9, 0.8, 0.2] }),
    { ...sheet({ color: [0.2, 0.3, 0.9] }), name: 'second' },
  ];
  const plain = jobInputOf(plainParts, environment);
  const translucent = jobInputOf(translucentParts, environment);
  assert.equal(translucent.materialCount, plain.materialCount, 'the header still counts the material records only');
  assert.equal(translucent.materials.byteLength, 2 * plain.materials.byteLength);
  const records = bytesOf(translucent.materials).subarray(0, plain.materials.byteLength);
  assert.equal(Buffer.compare(records, bytesOf(plain.materials)), 0, 'the material records are the ones of the plain scene');

  const first = recordFloats(translucent, translucent.materialCount);
  assert.deepEqual(Array.from(first.floats.slice(0, 4)).map(value => Number(value.toFixed(4))), [0.9, 0.8, 0.2, 0.5]);
  assert.equal(first.words[48], 0, 'an explicit colour replaces the base colour');
  const second = recordFloats(translucent, translucent.materialCount + 1);
  assert.deepEqual(Array.from(second.floats.slice(0, 4)), [0, 0, 0, 0], 'a material without the field gets an empty extension record');
});

test('a colour left out tints the base colour, and the weight is the packed share of the diffuse layer', () => {
  const environment = sunEnvironment(SUN_BEHIND_THE_SHEET);
  const input = jobInputOf([sheet({ color: [0.6, 0.5, 0.4], diffuseTransmission: 0.25 })], environment);
  const extension = recordFloats(input, input.materialCount);
  assert.deepEqual(Array.from(extension.floats.slice(0, 4)), [1, 1, 1, 0.25]);
  assert.equal(extension.words[48], 1, 'the colour multiplies the base colour');
});

test('a flattened and an instanced job send the same extension records', () => {
  const environment = sunEnvironment(SUN_BEHIND_THE_SHEET);
  const shared = sheet({ color: [0.6, 0.5, 0.4] }).geometry;
  const parts = [
    { name: 'a', geometry: shared, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -4, 0, 0, 1], material: { color: [0.5, 0.5, 0.5], diffuseTransmission: 0.4 } },
    { name: 'b', geometry: shared, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1], material: { color: [0.2, 0.7, 0.3], diffuseTransmission: 0.8, diffuseTransmissionColor: [0.3, 0.9, 0.3] } },
  ];
  const flattened = buildFlattenedJobNativeInput(buildTraceScene(parts, environment), camera, packOptions, pack, resolveTexture);
  const instanced = buildJobNativeInput(buildTraceScene(parts, environment, { instancing: true }), camera, packOptions, pack, resolveTexture);
  assert.equal(Buffer.compare(bytesOf(instanced.materials), bytesOf(flattened.materials)), 0);
  assert.equal(flattened.materials.byteLength, 2 * flattened.materialCount * MATERIAL_STRIDE);
});

test('the packer reads the weight and colour of a bare material descriptor into the record info, not the 256 byte record', () => {
  const packed = packMaterialRecordV2({ baseColor: [0.5, 0.5, 0.5], diffuseTransmission: 1, diffuseTransmissionColor: [0.2, 0.4, 0.6] });
  assert.deepEqual(packed.diffuseTransmission, { weight: 1, color: [0.2, 0.4, 0.6], tintsBaseColor: false });
  assert.equal(packed.bytes.byteLength, MATERIAL_STRIDE);
  assert.equal(packMaterialRecordV2({ baseColor: [0.5, 0.5, 0.5] }).diffuseTransmission, null);
});

test('a weight or a colour out of range is refused with the field and the fix', () => {
  const resolved = { transmission: 0, clearcoat: 0 };
  const carried = material => carriedMaterialFields(material, resolved, resolveTexture);
  assert.throws(() => carried({ diffuseTransmission: 1.2 }), /diffuseTransmission must be a number between 0 and 1, got 1.2/);
  assert.throws(() => carried({ diffuseTransmission: -0.1 }), /diffuseTransmission must be a number between 0 and 1/);
  assert.throws(() => carried({ diffuseTransmission: 'half' }), /diffuseTransmission must be a number between 0 and 1, got half/);
  assert.throws(() => carried({ diffuseTransmission: Number.NaN }), /diffuseTransmission must be a number between 0 and 1/);
  assert.throws(() => carried({ diffuseTransmission: 0.5, diffuseTransmissionColor: [1, 1] }), /diffuseTransmissionColor must be three linear RGB numbers/);
  assert.throws(() => carried({ diffuseTransmission: 0.5, diffuseTransmissionColor: [1, 2, 1] }), /diffuseTransmissionColor must be three linear RGB numbers/);
  assert.throws(() => carried({ diffuseTransmissionColor: 'red' }), /diffuseTransmissionColor must be three linear RGB numbers/);
});

test('only a weight above 0 is carried, with its colour when one is set', () => {
  const resolved = { transmission: 0, clearcoat: 0 };
  const carried = material => carriedMaterialFields(material, resolved, resolveTexture);
  assert.deepEqual(carried({ diffuseTransmission: 0 }), {});
  assert.deepEqual(carried({ diffuseTransmissionColor: [1, 0, 0] }), {});
  assert.deepEqual(carried({ diffuseTransmission: 0.5 }), { diffuseTransmission: 0.5 });
  assert.deepEqual(carried({ diffuseTransmission: 0.5, diffuseTransmissionColor: [0.1, 0.2, 0.3] }), { diffuseTransmission: 0.5, diffuseTransmissionColor: [0.1, 0.2, 0.3] });
});

const addonSkip = findNativeAddon() ? false : 'the native addon is not built';

// The mean linear colour of the middle of the picture, with the colour a render without the sun gives taken off.
function sheetRadiance(material, lightDirection) {
  const lit = renderCentre(material, sunEnvironment(lightDirection));
  const dark = renderCentre(material, sunEnvironment(lightDirection, [0, 0, 0]));
  return lit.map((value, channel) => value - dark[channel]);
}

function renderCentre(material, environment) {
  const input = jobInputOf([sheet(material)], environment);
  const traced = traceNative(prepareCyclesInput(input, traceOptions), traceOptions);
  const sums = [0, 0, 0];
  const first = WIDTH / 2 - 2;
  for (let row = first; row < first + 4; row++) {
    for (let column = first; column < first + 4; column++) {
      const offset = (row * WIDTH + column) * 4;
      for (let channel = 0; channel < 3; channel++) sums[channel] += traced.rgba[offset + channel] / 16;
    }
  }
  return sums;
}

// A sheet of weight w and colour a, lit from behind by the irradiance E, shines w * a * E / pi on its front. The irradiance
// is taken from the same sheet as a plain diffuse surface of albedo a lit from the front: that gives a * E / pi.
test('a sheet lit from behind shines weight * colour * E / pi on its front', { skip: addonSkip }, () => {
  const weight = 0.5;
  const color = [0.2, 0.8, 0.5];
  const behind = sheetRadiance({ color: [0.7, 0.7, 0.7], diffuseTransmission: weight, diffuseTransmissionColor: color }, SUN_BEHIND_THE_SHEET);
  const reference = sheetRadiance({ color }, SUN_IN_FRONT_OF_THE_SHEET);
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(reference[channel] > 0.05, `the front lit reference is lit: ${reference[channel]}`);
    const ratio = behind[channel] / reference[channel];
    assert.ok(Math.abs(ratio - weight) < 0.02, `channel ${channel}: ${behind[channel]} over ${reference[channel]} is ${ratio}, expected ${weight}`);
  }
});

test('a sheet lit from the front keeps the share of the diffuse layer that reflects', { skip: addonSkip }, () => {
  const weight = 0.4;
  const color = [0.6, 0.5, 0.4];
  const reflecting = sheetRadiance({ color, diffuseTransmission: weight }, SUN_IN_FRONT_OF_THE_SHEET);
  const reference = sheetRadiance({ color }, SUN_IN_FRONT_OF_THE_SHEET);
  for (let channel = 0; channel < 3; channel++) {
    const ratio = reflecting[channel] / reference[channel];
    assert.ok(Math.abs(ratio - (1 - weight)) < 0.02, `channel ${channel}: ratio ${ratio}, expected ${1 - weight}`);
  }
});

test('a sheet without the field stays dark when the sun is behind it, and one at weight 1 shows no reflection', { skip: addonSkip }, () => {
  const opaque = sheetRadiance({ color: [0.6, 0.5, 0.4] }, SUN_BEHIND_THE_SHEET);
  for (const value of opaque) assert.ok(Math.abs(value) < 1e-4, `an opaque sheet lit from behind is dark: ${value}`);
  const fullTransmission = sheetRadiance({ color: [0.6, 0.5, 0.4], diffuseTransmission: 1 }, SUN_IN_FRONT_OF_THE_SHEET);
  for (const value of fullTransmission) assert.ok(Math.abs(value) < 1e-4, `a sheet that transmits all its diffuse light reflects none: ${value}`);
});

test('the sun irradiance behind the sheet matches the front lit reference to the closed form', { skip: addonSkip }, () => {
  const reference = sheetRadiance({ color: [1, 1, 1] }, SUN_IN_FRONT_OF_THE_SHEET);
  const expectedEOverPi = SUN_COLOR[0] / Math.PI;
  for (const value of reference) {
    assert.ok(Math.abs(value / expectedEOverPi - 1) < 0.05, `E / pi is ${value}, expected ${expectedEOverPi}`);
  }
});

// The lobe probe compiles the kernel without specialization and gives it a table of exactly `materialCount` records. A
// metallic material there must not be read as a transmitting one: its metallic weight sits where an extension record keeps
// the diffuse transmission weight, one table length further on.
test('the lobe probe of a metallic material has no light on the far side', { skip: addonSkip }, () => {
  const width = 16;
  const height = 8;
  const planes = probeCyclesLobe({
    width,
    height,
    mode: 1,
    seed: 42,
    wo: [0, 0.6, 0.8],
    frontFace: true,
    material: { color: [0.8, 0.4, 0.2], roughness: 1, metallic: 0.5, specular: 0 },
    bootstrapKernel: true,
  });
  // Mode 1 evaluates the closure for directions over the whole sphere, from z = 1 in the first row to z = -1 in the last.
  let nearSide = 0;
  let farSide = 0;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const offset = (row * width + column) * 4;
      const brightness = planes[offset] + planes[offset + 1] + planes[offset + 2];
      if (row < height / 2) nearSide += brightness;
      else farSide += brightness;
    }
  }
  assert.ok(nearSide > 0, `the near side of a metal and diffuse material is lit: ${nearSide}`);
  assert.equal(farSide, 0, 'no light leaves through the far side');
});

test('the exported packer refuses a weight or a colour that would render wrong', () => {
  const pack = fields => () => packMaterialRecordV2({ baseColor: [0.5, 0.5, 0.5], ...fields });
  assert.throws(pack({ diffuseTransmission: 1.5 }), /diffuseTransmission must be a number between 0 and 1, got 1.5/);
  assert.throws(pack({ diffuseTransmission: '0.5' }), /diffuseTransmission must be a number between 0 and 1/);
  assert.throws(pack({ diffuseTransmission: Number.NaN }), /diffuseTransmission must be a number between 0 and 1/);
  assert.throws(pack({ diffuseTransmission: 0.5, diffuseTransmissionColor: [1, 1] }), /diffuseTransmissionColor must be three linear RGB numbers/);
  assert.throws(pack({ diffuseTransmission: 0.5, diffuseTransmissionColor: [2, 0, 0] }), /diffuseTransmissionColor must be three linear RGB numbers/);
  assert.throws(pack({ diffuseTransmission: 0.5, diffuseTransmissionColor: [0, 0, Number.NaN] }), /diffuseTransmissionColor must be three linear RGB numbers/);
});
