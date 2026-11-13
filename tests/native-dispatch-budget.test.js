import assert from 'node:assert/strict';
import { createCamera } from '../src/path-tracer.js';
import { cookInstalled, cookModule, cookTest } from './support/cook.js';

const { buildNativeInputV2, createNativeSession, findNativeAddon, resolveSessionFrame, traceNative } = (await cookModule()) ?? {};
const { validatePackOptions } = (await cookModule('pack-input-v2')) ?? {};

const skipWithoutAddon = !cookInstalled || findNativeAddon() === null ? 'the native addon is not built' : false;

const UNIT_QUAD = {
  positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  colors: new Float32Array(12).fill(1),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

// Not a multiple of the 8 pixel workgroup in either direction, so the tiles at the right and bottom edges hang over.
const IMAGE_OPTIONS = { width: 37, height: 29, samples: 24, bounces: 3, seed: 5 };
const RESULT_PLANES = ['rgba', 'albedo', 'normal', 'depth', 'variance'];

function horizontalQuadMatrix(scale, height, facesUp) {
  const upOrDown = facesUp ? 1 : -1;
  return [scale, 0, 0, 0, 0, 0, -upOrDown * scale, 0, 0, upOrDown * scale, 0, 0, 0, height, 0, 1];
}

function buildRoomInput(options) {
  const scene = {
    materials: [{ color: [0.6, 0.6, 0.6], roughness: 0.8 }, { color: [1, 0.95, 0.9], emission: 5, roughness: 1 }],
    instances: [
      { geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(8, 0, true), materialIndex: 0 },
      { geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(2, 3, false), materialOverride: 1 },
    ],
  };
  const camera = createCamera({ eye: [0, 2.2, 6], target: [0, 0.5, 0], fov: 45 }, options.width, options.height);
  return buildNativeInputV2(scene, camera, options);
}

function assertSameBytes(first, second, message) {
  for (const plane of RESULT_PLANES) {
    const firstBytes = Buffer.from(first[plane].buffer, first[plane].byteOffset, first[plane].byteLength);
    const secondBytes = Buffer.from(second[plane].buffer, second[plane].byteOffset, second[plane].byteLength);
    assert.ok(firstBytes.equals(secondBytes), `${message}: the ${plane} plane differs`);
  }
}

cookTest('dispatchBudgetMs must be a finite number of milliseconds from 1 to 1000', () => {
  for (const accepted of [undefined, 1, 4, 8.5, 1000]) {
    assert.doesNotThrow(() => validatePackOptions({ dispatchBudgetMs: accepted }, 'test'));
  }
  for (const rejected of [0, 0.5, -3, 1001, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => validatePackOptions({ dispatchBudgetMs: rejected }, 'test'), { name: 'RangeError', message: /`dispatchBudgetMs`.*from 1 to 1000/ });
  }
  for (const wrongType of ['8', null, true, [8]]) {
    assert.throws(() => validatePackOptions({ dispatchBudgetMs: wrongType }, 'test'), { name: 'TypeError', message: /`dispatchBudgetMs` must be a number/ });
  }
});

cookTest('a session frame carries dispatchBudgetMs to the addon and checks it', () => {
  const sessionInput = buildRoomInput(IMAGE_OPTIONS);
  const frame = resolveSessionFrame(sessionInput, {}, { ...IMAGE_OPTIONS, dispatchBudgetMs: 8 });
  assert.equal(frame.dispatchBudgetMs, 8);
  assert.equal(resolveSessionFrame(sessionInput, {}, IMAGE_OPTIONS).dispatchBudgetMs, undefined);
  assert.throws(() => resolveSessionFrame(sessionInput, {}, { ...IMAGE_OPTIONS, dispatchBudgetMs: 0 }), { name: 'RangeError', message: /`dispatchBudgetMs`/ });
});

cookTest('the legacy kernel refuses dispatchBudgetMs instead of ignoring it', { skip: skipWithoutAddon }, () => {
  assert.throws(() => traceNative({}, { ...IMAGE_OPTIONS, kernel: 'legacy', dispatchBudgetMs: 8 }), { name: 'TypeError', message: /kernel "cycles"/ });
});

cookTest('a one-shot render under a dispatch budget gives the same bytes as without one', { skip: skipWithoutAddon }, () => {
  const input = buildRoomInput(IMAGE_OPTIONS);
  const whole = traceNative(input, { ...IMAGE_OPTIONS, kernel: 'cycles' });
  const tiled = traceNative(input, { ...IMAGE_OPTIONS, kernel: 'cycles', dispatchBudgetMs: 8 });
  assertSameBytes(whole, tiled, 'dispatchBudgetMs 8 against none');
  assert.ok(tiled.dispatchCount > 1, 'the budget cut the frame into several dispatches');
  assert.ok(tiled.smallestTilePixels >= 1 && tiled.smallestTilePixels <= tiled.largestTilePixels);
  assert.ok(tiled.largestTilePixels <= IMAGE_OPTIONS.width * IMAGE_OPTIONS.height);
  assert.ok(Number.isFinite(tiled.longestDispatchSeconds));
  assert.ok(whole.smallestTilePixels == null, 'without a budget no tile range is reported');
  assert.ok(whole.largestTilePixels == null);
});

cookTest('a one-shot render with a noise threshold gives the same bytes under a dispatch budget', { skip: skipWithoutAddon }, () => {
  const adaptiveOptions = { ...IMAGE_OPTIONS, samples: 96, noiseThreshold: 0.05 };
  const input = buildRoomInput(adaptiveOptions);
  const whole = traceNative(input, { ...adaptiveOptions, kernel: 'cycles' });
  const tiled = traceNative(input, { ...adaptiveOptions, kernel: 'cycles', dispatchBudgetMs: 4 });
  assertSameBytes(whole, tiled, 'noiseThreshold 0.05 with dispatchBudgetMs 4 against none');
  assert.equal(tiled.averageSamples, whole.averageSamples);
});

cookTest('samplesPerDispatch caps the samples of a dispatch under a dispatch budget', { skip: skipWithoutAddon }, () => {
  const input = buildRoomInput(IMAGE_OPTIONS);
  const capped = traceNative(input, { ...IMAGE_OPTIONS, kernel: 'cycles', dispatchBudgetMs: 1000, samplesPerDispatch: 3 });
  assert.ok(capped.samplesPerDispatch <= 3);
  assertSameBytes(traceNative(input, { ...IMAGE_OPTIONS, kernel: 'cycles' }), capped, 'capped budget against none');
});

cookTest('session frames under a dispatch budget give the same bytes as frames without one, also when accumulating', { skip: skipWithoutAddon }, () => {
  const input = buildRoomInput(IMAGE_OPTIONS);
  const session = createNativeSession(input, IMAGE_OPTIONS);
  try {
    const whole = session.render({ samples: IMAGE_OPTIONS.samples });
    const tiled = session.render({ samples: IMAGE_OPTIONS.samples, dispatchBudgetMs: 8 });
    assertSameBytes(whole, tiled, 'a session frame with dispatchBudgetMs 8 against none');
    assert.ok(tiled.dispatchCount > 1);

    const firstHalf = session.render({ samples: 10, accumulate: true, targetSamples: IMAGE_OPTIONS.samples, dispatchBudgetMs: 8 });
    const secondHalf = session.render({ samples: IMAGE_OPTIONS.samples - 10, accumulate: true });
    assert.equal(firstHalf.filmSamples, 10);
    assertSameBytes(whole, secondHalf, 'an accumulated image split across a budgeted call and a whole-image call against one frame');
  } finally {
    session.close();
  }
});

const TILE_ORIGIN_BYTE_OFFSET = 312;
const PARAMS_BYTES = 320;

function parameterBytes(input) {
  return Buffer.from(input.kernelParams.buffer, input.kernelParams.byteOffset, input.kernelParams.byteLength);
}

function withGarbageTileOrigin(input) {
  const copy = Buffer.from(parameterBytes(input));
  copy.writeUInt32LE(0xdeadbeef, TILE_ORIGIN_BYTE_OFFSET);
  copy.writeUInt32LE(0x12345678, TILE_ORIGIN_BYTE_OFFSET + 4);
  return { ...input, kernelParams: new Uint8Array(copy.buffer, copy.byteOffset, copy.byteLength) };
}

cookTest('the packer leaves the tile origin words 312 to 319 at zero and does not touch 304 to 311', () => {
  const input = buildRoomInput(IMAGE_OPTIONS);
  const bytes = parameterBytes(input);
  assert.equal(bytes.length, PARAMS_BYTES);
  assert.ok(bytes.subarray(TILE_ORIGIN_BYTE_OFFSET, PARAMS_BYTES).every((byte) => byte === 0));
  const withBudget = buildRoomInput({ ...IMAGE_OPTIONS, dispatchBudgetMs: 8 });
  assert.ok(parameterBytes(withBudget).equals(bytes), 'a dispatch budget does not change the packed bytes');
});

cookTest('a pack that carries garbage in the tile origin words renders the same picture, whole or tiled', { skip: skipWithoutAddon }, () => {
  const input = buildRoomInput(IMAGE_OPTIONS);
  const garbage = withGarbageTileOrigin(input);
  const reference = traceNative(input, { ...IMAGE_OPTIONS, kernel: 'cycles' });
  assertSameBytes(reference, traceNative(garbage, { ...IMAGE_OPTIONS, kernel: 'cycles' }), 'garbage tile origin, no budget');
  assertSameBytes(reference, traceNative(garbage, { ...IMAGE_OPTIONS, kernel: 'cycles', dispatchBudgetMs: 4 }), 'garbage tile origin, budget 4');
});

cookTest('a light tree probe render refuses a dispatch budget instead of tiling over itself', { skip: skipWithoutAddon }, () => {
  const probeInput = buildRoomInput({ ...IMAGE_OPTIONS, lightSampling: 'tree', lightTreeProbe: true });
  assert.throws(() => traceNative(probeInput, { ...IMAGE_OPTIONS, kernel: 'cycles', dispatchBudgetMs: 8 }), { message: /`dispatchBudgetMs` cannot be used with the light tree probe/ });
});
