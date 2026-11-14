import assert from 'node:assert/strict';
import { createCamera } from '../src/path-tracer.js';
import { cookModule, cookTest } from './support/cook.js';

const { buildNativeInputV2, packCameraParams, resolveSessionFrame, resolveSessionCreation } = (await cookModule()) ?? {};

const UNIT_QUAD = {
  positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  colors: new Float32Array(12).fill(1),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};
const IMAGE = { width: 48, height: 27, samples: 4, seed: 1 };
const CAMERA_FIRST_BYTE = 112;
const CAMERA_LAST_BYTE = 191;
const SEED_BYTE = 28;

function floorScene() {
  return {
    materials: [{ color: [0.6, 0.6, 0.6], roughness: 0.8 }],
    instances: [{ geometry: UNIT_QUAD, matrix: [8, 0, 0, 0, 0, 0, -8, 0, 0, 8, 0, 0, 0, 0, 0, 1], materialIndex: 0 }],
    farDistance: 123.5,
  };
}

function cameraFor(view, width = IMAGE.width, height = IMAGE.height) {
  return createCamera({ target: [0, 0.5, 0], fov: 45, ...view }, width, height);
}

function fullBlock(camera, options = {}) {
  return buildNativeInputV2(floorScene(), camera, { ...IMAGE, ...options }).kernelParams;
}

function differingBytes(first, second) {
  const offsets = [];
  for (let offset = 0; offset < first.byteLength; offset++) {
    if (first[offset] !== second[offset]) offsets.push(offset);
  }
  return offsets;
}

const pinholeView = { eye: [1.5, 2.2, 5] };
const thinLensView = { eye: [-2, 1.4, 4], fStop: 2.8, focusDistance: 4.5 };

for (const [name, view] of [['a pinhole camera', pinholeView], ['a thin lens camera', thinLensView]]) {
  cookTest(`packCameraParams equals a full repack with ${name}`, () => {
    const heldBlock = fullBlock(cameraFor({ eye: [0, 2.2, 6] }));
    const camera = cameraFor(view);
    const patched = packCameraParams(heldBlock, camera);
    assert.deepEqual(patched, fullBlock(camera));
    const changed = differingBytes(heldBlock, patched);
    assert.ok(changed.length > 0, 'the camera words changed');
    assert.ok(changed.every(offset => offset >= CAMERA_FIRST_BYTE && offset <= CAMERA_LAST_BYTE), `only camera bytes change, got ${changed}`);
  });
}

cookTest('packCameraParams leaves its input alone and writes the seed with the camera', () => {
  const heldBlock = fullBlock(cameraFor({ eye: [0, 2.2, 6] }));
  const copy = new Uint8Array(heldBlock);
  const camera = cameraFor(thinLensView);
  const patched = packCameraParams(heldBlock, camera, { seed: 4242 });
  assert.deepEqual(heldBlock, copy);
  assert.deepEqual(patched, fullBlock(camera, { seed: 4242 }));
  const changed = differingBytes(heldBlock, patched).filter(offset => offset < CAMERA_FIRST_BYTE || offset > CAMERA_LAST_BYTE);
  assert.deepEqual(changed.filter(offset => offset < SEED_BYTE || offset >= SEED_BYTE + 4), [], 'nothing outside the camera and seed words changes');
  assert.ok(changed.length > 0, 'the seed word changed');
});

cookTest('packCameraParams keeps the block seed when no seed is given and writes seed 0 and the largest seed', () => {
  const heldBlock = fullBlock(cameraFor({ eye: [0, 2.2, 6] }), { seed: 9 });
  const camera = cameraFor(pinholeView);
  assert.deepEqual(packCameraParams(heldBlock, camera), fullBlock(camera, { seed: 9 }));
  assert.deepEqual(packCameraParams(heldBlock, camera, { seed: 0 }), fullBlock(camera, { seed: 0 }));
  assert.deepEqual(packCameraParams(heldBlock, camera, { seed: 4294967295 }), fullBlock(camera, { seed: 4294967295 }));
});

cookTest('packCameraParams follows the camera options of the packer: orthographic bit, far plane and sensor shift', () => {
  const heldBlock = fullBlock(cameraFor({ eye: [0, 2.2, 6] }));
  const camera = { ...cameraFor(pinholeView), far: 77, lensShift: [0.1, -0.05], orthographic: true };
  assert.deepEqual(packCameraParams(heldBlock, camera), fullBlock(camera));
  const orthographicBlock = fullBlock(camera);
  const backToPerspective = cameraFor(pinholeView);
  assert.deepEqual(packCameraParams(orthographicBlock, backToPerspective, { far: 123.5, orthographic: false, lensShift: [0, 0] }), fullBlock(backToPerspective));
  assert.deepEqual(packCameraParams(orthographicBlock, { ...backToPerspective, orthographic: false }, { far: 123.5, lensShift: [0, 0] }), fullBlock(backToPerspective));
});

const packOptionsForCamera = {
  near: 0.25,
  far: 90,
  orthographic: true,
  lensShift: [0.05, -0.02],
  apertureRadius: 0.02,
  focalDistance: 5.5,
  apertureBlades: 6,
  apertureRotation: 0.3,
};

cookTest('packCameraParams keeps what the block was packed with through pack options when the camera leaves it out', () => {
  const heldBlock = fullBlock(cameraFor({ eye: [0, 2.2, 6] }), packOptionsForCamera);
  const bareCamera = cameraFor(pinholeView);
  const patched = packCameraParams(heldBlock, bareCamera);
  const expected = fullBlock(bareCamera, packOptionsForCamera);
  assert.deepEqual(patched, expected, 'the same bytes as a full pack with the same pack options and the new camera');
  assert.notDeepEqual(patched.slice(CAMERA_FIRST_BYTE, CAMERA_LAST_BYTE + 1), heldBlock.slice(CAMERA_FIRST_BYTE, CAMERA_LAST_BYTE + 1), 'the camera words changed');
  const words = new Float32Array(patched.buffer, patched.byteOffset, patched.byteLength / 4);
  const wordsAsIntegers = new Uint32Array(patched.buffer, patched.byteOffset, patched.byteLength / 4);
  assert.equal(words[31], 0.25, 'near plane kept');
  assert.equal(words[35], 90, 'far plane kept');
  assert.deepEqual([words[44], words[45]].map(value => Math.round(value * 1000)), [50, -20], 'sensor shift kept');
  assert.ok(Math.abs(words[39] - 0.02) < 1e-7, 'aperture radius kept');
  assert.equal(words[43], 5.5, 'focal distance kept');
  assert.equal(wordsAsIntegers[46], 6, 'aperture blades kept');
  assert.ok(Math.abs(words[47] - 0.3) < 1e-6, 'aperture rotation kept');
  assert.notEqual(wordsAsIntegers[8] & 8, 0, 'orthographic bit kept');
});

cookTest('packCameraParams lets a field the camera or the options carry win over the block', () => {
  const heldBlock = fullBlock(cameraFor({ eye: [0, 2.2, 6] }), packOptionsForCamera);
  const ownCamera = {
    ...cameraFor(thinLensView),
    near: 0.5,
    far: 40,
    lensShift: [0.2, 0.1],
    orthographic: false,
    apertureBlades: 0,
  };
  const patched = packCameraParams(heldBlock, ownCamera);
  assert.deepEqual(patched, fullBlock(ownCamera), 'every field comes from the camera or from the thin lens it carries');
  const words = new Float32Array(patched.buffer, patched.byteOffset, patched.byteLength / 4);
  assert.equal(words[31], 0.5);
  assert.equal(words[35], 40);
  assert.equal(new Uint32Array(patched.buffer, patched.byteOffset, patched.byteLength / 4)[8] & 8, 0, 'orthographic bit cleared by the camera');
  const withOptions = packCameraParams(heldBlock, cameraFor(pinholeView), { near: 0.75, apertureRadius: 0 });
  const optionWords = new Float32Array(withOptions.buffer, withOptions.byteOffset, withOptions.byteLength / 4);
  assert.equal(optionWords[31], 0.75, 'near from the options');
  assert.equal(optionWords[39], 0, 'aperture radius from the options');
  assert.equal(optionWords[43], 5.5, 'focal distance still from the block');
});

cookTest('packCameraParams validates the block, the camera, the seed and the aspect', () => {
  const heldBlock = fullBlock(cameraFor({ eye: [0, 2.2, 6] }));
  const camera = cameraFor(pinholeView);
  assert.throws(() => packCameraParams(new Uint8Array(8), camera), { name: 'TypeError', message: /320 bytes/ });
  assert.throws(() => packCameraParams([], camera), { name: 'TypeError', message: /Uint8Array/ });
  const wrongMagic = new Uint8Array(heldBlock);
  wrongMagic[0] ^= 0xff;
  assert.throws(() => packCameraParams(wrongMagic, camera), { name: 'TypeError', message: /magic and version 2/ });
  const wrongVersion = new Uint8Array(heldBlock);
  wrongVersion[4] = 1;
  assert.throws(() => packCameraParams(wrongVersion, camera), { name: 'TypeError', message: /magic and version 2/ });
  assert.throws(() => packCameraParams(heldBlock, undefined), { name: 'TypeError', message: /camera object/ });
  assert.throws(() => packCameraParams(heldBlock, camera, null), { name: 'TypeError', message: /options/ });
  for (const badSeed of [-1, 1.5, 4294967296, NaN, '3', null]) {
    assert.throws(() => packCameraParams(heldBlock, camera, { seed: badSeed }), { name: 'RangeError', message: /seed.*0 to 4294967295/ }, `seed ${badSeed}`);
  }
  const squareCamera = cameraFor(pinholeView, 40, 40);
  assert.throws(() => packCameraParams(heldBlock, squareCamera), { name: 'RangeError', message: /ratio.*48x27/ });
  assert.deepEqual(packCameraParams(heldBlock, squareCamera, { width: 40, height: 40 }).slice(CAMERA_FIRST_BYTE, CAMERA_LAST_BYTE + 1), fullBlock(squareCamera).slice(CAMERA_FIRST_BYTE, CAMERA_LAST_BYTE + 1));
  assert.throws(() => packCameraParams(heldBlock, { ...camera, aperture: 0, apertureRadius: -1 }), { name: 'RangeError', message: /apertureRadius/ });
});

cookTest('a frame with a camera and a seed carries them in its block and refuses a bad seed or a camera of another aspect', () => {
  const input = buildNativeInputV2(floorScene(), cameraFor({ eye: [0, 2.2, 6] }), IMAGE);
  const sessionInput = resolveSessionCreation(input, {});
  const defaults = { width: IMAGE.width, height: IMAGE.height, samples: 4 };
  const heldBlock = new Uint8Array(sessionInput.kernelParams);
  const camera = cameraFor(thinLensView);
  const frame = resolveSessionFrame(sessionInput, defaults, { camera, seed: 77 });
  const expected = resolveSessionFrame({ ...sessionInput, kernelParams: fullBlock(camera, { seed: 77 }) }, defaults, {});
  assert.deepEqual(frame.kernelParams, expected.kernelParams);
  assert.deepEqual(sessionInput.kernelParams, heldBlock, 'the session block is not modified');

  const seedOnly = resolveSessionFrame(sessionInput, defaults, { seed: 5 });
  assert.deepEqual(seedOnly.kernelParams, resolveSessionFrame({ ...sessionInput, kernelParams: fullBlock(cameraFor({ eye: [0, 2.2, 6] }), { seed: 5 }) }, defaults, {}).kernelParams);
  const sessionWithSeed = resolveSessionCreation(input, { seed: 6 });
  const explicitBlock = fullBlock(cameraFor({ eye: [3, 2, 5] }), { seed: 9 });
  const readSeed = kernelParams => new DataView(kernelParams.buffer, kernelParams.byteOffset).getUint32(SEED_BYTE, true);
  assert.equal(readSeed(resolveSessionFrame(sessionWithSeed, { ...defaults, seed: 6 }, { kernelParams: explicitBlock }).kernelParams), 9, 'a session seed leaves the seed of an explicit block alone');
  assert.equal(readSeed(resolveSessionFrame(sessionWithSeed, { ...defaults, seed: 6 }, {}).kernelParams), readSeed(sessionInput.kernelParams), 'a session seed leaves the packed seed alone');
  assert.deepEqual(
    resolveSessionFrame(sessionWithSeed, { ...defaults, seed: 6 }, { kernelParams: explicitBlock }).kernelParams,
    resolveSessionFrame(sessionInput, defaults, { kernelParams: explicitBlock }).kernelParams,
    'a frame without a seed of its own is byte identical with or without a session seed'
  );
  assert.equal(readSeed(resolveSessionFrame(sessionWithSeed, { ...defaults, seed: 6 }, { kernelParams: explicitBlock, seed: 12 }).kernelParams), 12, 'a seed given to render wins');

  assert.throws(() => resolveSessionFrame(sessionInput, defaults, { seed: -3 }), { name: 'RangeError', message: /NativeSession.render.*seed/ });
  assert.throws(() => resolveSessionFrame(sessionInput, defaults, { seed: 2.5 }), { name: 'RangeError', message: /seed/ });
  assert.throws(() => resolveSessionFrame(sessionInput, defaults, { camera: cameraFor(pinholeView, 20, 20) }), { name: 'RangeError', message: /ratio/ });
  assert.deepEqual(
    resolveSessionFrame(sessionInput, { ...defaults, width: 20, height: 20 }, { camera: cameraFor(pinholeView, 20, 20) }).kernelParams.slice(CAMERA_FIRST_BYTE, CAMERA_LAST_BYTE + 1),
    fullBlock(cameraFor(pinholeView, 20, 20)).slice(CAMERA_FIRST_BYTE, CAMERA_LAST_BYTE + 1),
    'the frame size is the size the camera is checked against'
  );
});
