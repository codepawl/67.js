import assert from 'node:assert/strict';
import test from 'node:test';
import { cameraFocalLength, resolveThinLens } from '../src/camera.js';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import { cookInstalled, cookModule, cookTest } from './support/cook.js';

const cook = await cookModule();
const packInput = await cookModule('pack-input');
const packInputV2 = await cookModule('pack-input-v2');
const { buildNativeInputV2, findNativeAddon, traceNative, upgradeNativeInputV1ToV2 } = cook ?? {};
const { buildNativeInput } = packInput ?? {};
const { resolveThinLensParameters } = packInputV2 ?? {};

const skipWithoutAddon = !cookInstalled || findNativeAddon() === null ? 'the native addon is not built' : false;

// Word indexes in the 320-byte KernelParamsV2 block (abi.wgsl): aperture_radius, focal_distance, aperture_blades, aperture_rotation.
const APERTURE_RADIUS_WORD = 39;
const FOCAL_DISTANCE_WORD = 43;
const APERTURE_BLADES_WORD = 46;
const APERTURE_ROTATION_WORD = 47;
const LENS_WORDS = [APERTURE_RADIUS_WORD, FOCAL_DISTANCE_WORD, APERTURE_BLADES_WORD, APERTURE_ROTATION_WORD];

const PINHOLE_SPEC = { eye: [0, 0, 4], target: [0, 0, 0], fov: 45 };
const LENS_OF_50_MM = { ...PINHOLE_SPEC, focalLength: 50, fStop: 2.8 };
// The pinhole camera with an f-stop added: same view, so the params block differs only in the lens words.
const LENS_ON_PINHOLE = { ...PINHOLE_SPEC, fStop: 2.8 };

function cardGeometry(left, right) {
  return {
    positions: new Float32Array([left, -1.5, 0, right, -1.5, 0, right, 1.5, 0, left, 1.5, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    colors: new Float32Array(12).fill(1),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

// An emissive card whose right edge crosses the middle of the image, in front of nothing.
function buildEdgeScene() {
  return buildTraceScene([{ name: 'card', geometry: cardGeometry(-1.5, 0), material: { color: [1, 1, 1], emission: 4 } }], {});
}

function kernelWords(input) {
  const { buffer, byteOffset, byteLength } = input.kernelParams;
  return new Uint32Array(buffer.slice(byteOffset, byteOffset + byteLength));
}

function floatOfWord(word) {
  return new Float32Array(new Uint32Array([word]).buffer)[0];
}

function differingWords(first, second) {
  return [...first.keys()].filter((index) => first[index] !== second[index]);
}

function packWithCamera(spec, size = 16) {
  const camera = createCamera(spec, size, size);
  return buildNativeInputV2(buildEdgeScene(), camera, { width: size, height: size, samples: 1 });
}

test('the aperture radius is focal length over twice the f-stop, in metres', () => {
  const lens = resolveThinLens(LENS_OF_50_MM, { aspect: 1, eye: [0, 0, 4], target: [0, 0, 0] });
  assert.ok(Math.abs(lens.apertureRadius - 0.05 / (2 * 2.8)) < 1e-12);
  assert.equal(lens.focalDistance, 4, 'focus defaults to the eye-to-target distance');
  assert.equal(lens.apertureBlades, 0);
  assert.equal(lens.apertureRotation, 0);
});

test('a camera given only a field of view uses the focal length that field gives on the sensor', () => {
  const aspect = 16 / 9;
  const focalLength = cameraFocalLength({ fov: 50 }, aspect);
  assert.ok(Math.abs(focalLength - 36 / aspect / (2 * Math.tan(25 * Math.PI / 180))) < 1e-9);
  const wideSensor = cameraFocalLength({ fov: 50, sensorWidth: 72 }, aspect);
  assert.ok(Math.abs(wideSensor - 2 * focalLength) < 1e-9, 'twice the sensor, twice the focal length');
  assert.equal(cameraFocalLength({ fov: 50, focalLength: 85 }, aspect), 85, 'an explicit focal length wins');
});

test('focus distance, blades and rotation come through; rotation turns from degrees to radians', () => {
  const lens = resolveThinLens(
    { ...LENS_OF_50_MM, focusDistance: 2.5, apertureBlades: 6, apertureRotation: 30 },
    { aspect: 1, eye: [0, 0, 4], target: [0, 0, 0] },
  );
  assert.equal(lens.focalDistance, 2.5);
  assert.equal(lens.apertureBlades, 6);
  assert.ok(Math.abs(lens.apertureRotation - Math.PI / 3) < 1e-12, 'a hexagon at 30 degrees is the kernel at 30 degrees plus half a corner step (30)');
  assert.equal(resolveThinLens({ ...LENS_OF_50_MM, apertureRotation: 0 }, { aspect: 1, eye: [0, 0, 4], target: [0, 0, 0] }).apertureRotation, 0, 'a round aperture has no offset');
});

test('a camera without an fStop is a pinhole: no lens fields, no change to the view', () => {
  assert.equal(resolveThinLens(PINHOLE_SPEC, { aspect: 1, eye: [0, 0, 4], target: [0, 0, 0] }), null);
  const view = createCamera(PINHOLE_SPEC, 16, 16);
  assert.deepEqual(Object.keys(view).sort(), ['above', 'eye', 'forward', 'halfHeight', 'halfWidth', 'right']);
});

test('a lens that cannot be built says what to pass', () => {
  const frame = { eye: [0, 0, 4], target: [0, 0, 0] };
  const make = (extra) => () => resolveThinLens({ ...LENS_OF_50_MM, ...extra }, { aspect: 1, ...frame });
  assert.throws(make({ fStop: 0 }), /fStop must be a positive finite number/);
  assert.throws(make({ focusDistance: -1 }), /focusDistance must be a positive finite number/);
  assert.throws(make({ apertureBlades: 2 }), /apertureBlades must be 0 .* 3 to 64/);
  assert.throws(make({ apertureBlades: 4.5 }), /apertureBlades must be 0/);
  assert.throws(make({ apertureBlades: 65 }), /apertureBlades must be 0/);
  assert.throws(make({ apertureRotation: Number.NaN }), /apertureRotation must be a finite number of degrees/);
  assert.throws(make({ focalLength: -5 }), /focalLength must be a positive finite number/);
});

cookTest('with depth of field off, the lens words of the params block hold the values they always held', () => {
  const words = kernelWords(packWithCamera(PINHOLE_SPEC));
  assert.equal(words[APERTURE_RADIUS_WORD], 0);
  assert.equal(floatOfWord(words[FOCAL_DISTANCE_WORD]), 10);
  assert.equal(words[APERTURE_BLADES_WORD], 0);
  assert.equal(words[APERTURE_ROTATION_WORD], 0);
});

cookTest('depth of field changes only its own words of the params block', () => {
  const pinhole = kernelWords(packWithCamera(PINHOLE_SPEC));
  const round = kernelWords(packWithCamera({ ...LENS_ON_PINHOLE, focusDistance: 3 }));
  assert.deepEqual(differingWords(pinhole, round), [APERTURE_RADIUS_WORD, FOCAL_DISTANCE_WORD]);
  assert.equal(floatOfWord(round[APERTURE_RADIUS_WORD]), Math.fround(cameraFocalLength(PINHOLE_SPEC, 1) / 1000 / 5.6));
  assert.equal(floatOfWord(round[FOCAL_DISTANCE_WORD]), 3);

  const hexagon = kernelWords(packWithCamera({ ...LENS_ON_PINHOLE, apertureBlades: 6, apertureRotation: 90 }));
  assert.deepEqual(differingWords(pinhole, hexagon), LENS_WORDS);
  assert.equal(hexagon[APERTURE_BLADES_WORD], 6);
  assert.equal(floatOfWord(hexagon[APERTURE_ROTATION_WORD]), Math.fround(Math.PI / 2 + Math.PI / 6));
});

cookTest('a v1 input carries the lens in the free fourth floats and upgrades to the same v2 words', () => {
  const scene = buildEdgeScene();
  const options = { width: 16, height: 16, samples: 1 };
  const lensCamera = createCamera({ ...LENS_ON_PINHOLE, focusDistance: 3, apertureBlades: 5, apertureRotation: 12 }, 16, 16);
  const v1 = buildNativeInput(scene, lensCamera, options, pack);
  const floats = new Float32Array(v1.parameters.buffer, v1.parameters.byteOffset, 64);
  assert.deepEqual([floats[3], floats[7], floats[11], floats[15]],
    [lensCamera.apertureRadius, lensCamera.focalDistance, lensCamera.apertureBlades, lensCamera.apertureRotation].map(Math.fround));

  const direct = kernelWords(buildNativeInputV2(scene, lensCamera, options));
  const upgraded = kernelWords(upgradeNativeInputV1ToV2(v1, options));
  for (const wordIndex of LENS_WORDS) {
    assert.equal(upgraded[wordIndex], direct[wordIndex], `word ${wordIndex}`);
  }
});

cookTest('a pinhole v1 input keeps its camera vectors at 0 in the fourth float and upgrades to the default lens words', () => {
  const options = { width: 16, height: 16, samples: 1 };
  const v1 = buildNativeInput(buildEdgeScene(), createCamera(PINHOLE_SPEC, 16, 16), options, pack);
  const floats = new Float32Array(v1.parameters.buffer, v1.parameters.byteOffset, 64);
  assert.deepEqual([floats[3], floats[7], floats[11], floats[15]], [0, 0, 0, 0]);
  const upgraded = kernelWords(upgradeNativeInputV1ToV2(v1, options));
  const direct = kernelWords(packWithCamera(PINHOLE_SPEC));
  for (const wordIndex of LENS_WORDS) {
    assert.equal(upgraded[wordIndex], direct[wordIndex], `word ${wordIndex}`);
  }
});

cookTest('the packer rejects lens values the kernel cannot use, naming the field and what to pass', () => {
  const caller = 'buildNativeInputV2';
  assert.throws(() => resolveThinLensParameters({ apertureRadius: -1 }, {}, caller), /buildNativeInputV2: camera `apertureRadius` must be a number of scene units, 0 or more/);
  assert.throws(() => resolveThinLensParameters({ apertureRadius: Number.NaN }, {}, caller), /apertureRadius/);
  assert.throws(() => resolveThinLensParameters({ apertureRadius: 0.01, focalDistance: 0 }, {}, caller), /`focalDistance` must be a distance along the view axis above 0/);
  assert.throws(() => resolveThinLensParameters({}, { apertureBlades: 2 }, caller), /`apertureBlades` must be 0 for a round aperture or a whole number from 3 to 64/);
  assert.throws(() => resolveThinLensParameters({}, { apertureRotation: Infinity }, caller), /`apertureRotation` must be a finite number of radians/);
  assert.deepEqual(resolveThinLensParameters({}, {}, caller), { apertureRadius: 0, focalDistance: 10, apertureBlades: 0, apertureRotation: 0 });
});

// Pixels along the middle row whose value lies between 5 and 95 percent of the row's brightest: the width of the edge.
function edgeWidth(rgba, width, height) {
  const row = Math.floor(height / 2);
  const values = Array.from({ length: width }, (_, column) => rgba[(row * width + column) * 4]);
  const brightest = Math.max(...values);
  assert.ok(brightest > 0.5, 'the card is visible');
  return values.filter((value) => value > 0.05 * brightest && value < 0.95 * brightest).length;
}

cookTest('the cycles kernel blurs an edge off the focus plane and keeps it sharp on it', { skip: skipWithoutAddon }, () => {
  const size = { width: 64, height: 32 };
  const traceOptions = { ...size, samples: 96, bounces: 1, seed: 5, kernel: 'cycles' };
  // 200 mm at f/2 is a 5 cm aperture radius; the card edge is 4 m away.
  const lensSpec = { eye: [0, 0, 4], target: [0, 0, 0], focalLength: 200, fStop: 2 };
  const traceWith = (spec) => {
    const camera = createCamera(spec, size.width, size.height);
    return traceNative(buildNativeInputV2(buildEdgeScene(), camera, traceOptions), traceOptions);
  };
  const pinhole = traceWith({ eye: lensSpec.eye, target: lensSpec.target, focalLength: 200 });
  const onFocus = traceWith(lensSpec);
  const nearFocus = traceWith({ ...lensSpec, focusDistance: 1.5 });
  const hexagon = traceWith({ ...lensSpec, focusDistance: 1.5, apertureBlades: 6 });

  const pinholeEdge = edgeWidth(pinhole.rgba, size.width, size.height);
  const onFocusEdge = edgeWidth(onFocus.rgba, size.width, size.height);
  const nearFocusEdge = edgeWidth(nearFocus.rgba, size.width, size.height);
  assert.ok(pinholeEdge <= 3, `pinhole edge is ${pinholeEdge} pixels wide`);
  assert.ok(onFocusEdge <= 3, `an edge on the focus plane is ${onFocusEdge} pixels wide`);
  assert.ok(nearFocusEdge >= onFocusEdge + 5, `an edge 2.5 m behind the focus is ${nearFocusEdge} pixels wide`);
  assert.ok(edgeWidth(hexagon.rgba, size.width, size.height) >= onFocusEdge + 5, 'a hexagonal aperture blurs it too');
  assert.ok(nearFocus.rgba.every(Number.isFinite));
});

cookTest('the cycles kernel draws the same bytes for a pinhole whether or not the camera names a lens of aperture 0', { skip: skipWithoutAddon }, () => {
  const traceOptions = { width: 16, height: 16, samples: 8, bounces: 1, seed: 3, kernel: 'cycles', samplesPerDispatch: 8 };
  const camera = createCamera(PINHOLE_SPEC, 16, 16);
  const plain = traceNative(buildNativeInputV2(buildEdgeScene(), camera, traceOptions), traceOptions);
  const explicit = traceNative(buildNativeInputV2(buildEdgeScene(), { ...camera, apertureRadius: 0, focalDistance: 7 }, traceOptions), traceOptions);
  assert.ok(Buffer.from(plain.rgba.buffer, plain.rgba.byteOffset, plain.rgba.byteLength)
    .equals(Buffer.from(explicit.rgba.buffer, explicit.rgba.byteOffset, explicit.rgba.byteLength)));
});
