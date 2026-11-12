import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildNativeInputV2,
  createNativeSession,
  findNativeAddon,
  resolveSessionCreation,
  resolveSessionFrame,
  traceNative,
  wrapNativeSession,
  KERNEL_PARAMS_V2_FILTER_GLOSSY_BYTE_OFFSET,
} from '../packages/render-native/index.mjs';
import { KERNEL_FLAG_WHITE_NOISE_SAMPLER, KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET } from '../packages/render-native/pack-input-v2.mjs';
import { createCamera } from '../src/path-tracer.js';

const addonIsBuilt = findNativeAddon() !== null;
const skipWithoutAddon = addonIsBuilt ? false : 'the native addon is not built';
const skipWithAddon = addonIsBuilt ? 'the addon is built; this test covers the missing addon' : false;

const UNIT_QUAD = {
  positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  colors: new Float32Array(12).fill(1),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

const IMAGE_OPTIONS = { width: 24, height: 16, samples: 32, bounces: 3, seed: 11 };
const RESULT_PLANES = ['rgba', 'albedo', 'normal', 'depth', 'variance'];
const MATERIAL_COUNT_BYTE_OFFSET = 92;

function horizontalQuadMatrix(scale, height, facesUp) {
  const upOrDown = facesUp ? 1 : -1;
  return [scale, 0, 0, 0, 0, 0, -upOrDown * scale, 0, 0, upOrDown * scale, 0, 0, 0, height, 0, 1];
}

// A lit floor with two emissive ceiling quads, so light picking and several bounces take part.
function buildRoomScene() {
  return {
    materials: [{ color: [0.6, 0.6, 0.6], roughness: 0.8 }, { color: [1, 0.95, 0.9], emission: 5, roughness: 1 }],
    instances: [
      { geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(8, 0, true), materialIndex: 0 },
      { geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(2, 3, false), materialOverride: 1 },
      { geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(1, 2, false), materialOverride: 1 },
    ],
  };
}

function roomInput(eye, options = IMAGE_OPTIONS) {
  const camera = createCamera({ eye, target: [0, 0.5, 0], fov: 45 }, options.width, options.height);
  return buildNativeInputV2(buildRoomScene(), camera, options);
}

function bytesOf(result, plane) {
  const values = result[plane];
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

function assertSameBytes(first, second, message) {
  for (const plane of RESULT_PLANES) {
    assert.ok(bytesOf(first, plane).equals(bytesOf(second, plane)), `${message}: the ${plane} plane differs`);
  }
}

function readKernelFlags(kernelParams) {
  return new DataView(kernelParams.buffer, kernelParams.byteOffset, kernelParams.byteLength).getUint32(KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET, true);
}

// ---- Argument checks: these run without the addon ----

test('createNativeSession refuses an input that is not FORMAT-v2', () => {
  assert.throws(() => createNativeSession(undefined), { name: 'TypeError', message: /FORMAT-v2 input object/ });
  assert.throws(() => createNativeSession(null), { name: 'TypeError' });
  assert.throws(() => createNativeSession({ schemaVersion: 1 }), { name: 'TypeError', message: /schemaVersion.*must be 2/ });
  assert.throws(() => createNativeSession({ triangles: new Float32Array(36), triangleCount: 1 }), { name: 'TypeError', message: /schemaVersion/ });
});

test('createNativeSession refuses a kernel parameter block of the wrong size', () => {
  const input = roomInput([0, 2.2, 6]);
  assert.throws(
    () => createNativeSession({ ...input, kernelParams: new Uint8Array(12) }),
    { name: 'TypeError', message: /320 bytes/ }
  );
  assert.throws(() => createNativeSession({ ...input, kernelParams: undefined }), { name: 'TypeError', message: /kernelParams/ });
});

test('createNativeSession runs the cycles kernel only', () => {
  const input = roomInput([0, 2.2, 6]);
  assert.throws(() => createNativeSession(input, { kernel: 'legacy' }), { name: 'TypeError', message: /"cycles" kernel only/ });
  assert.throws(() => createNativeSession(input, { kernel: 'nonsense' }), { message: /Invalid native kernel/ });
  assert.throws(() => createNativeSession(input, null), { name: 'TypeError', message: /options/ });
});

test('createNativeSession checks its default options like traceNative does', () => {
  const input = roomInput([0, 2.2, 6]);
  assert.throws(() => createNativeSession(input, { samples: 0 }), { name: 'RangeError', message: /samples/ });
  assert.throws(() => createNativeSession(input, { sampler: 'nonsense' }), { message: /sampler/ });
  assert.throws(() => createNativeSession(input, { pathRegeneration: 'yes' }), { name: 'TypeError', message: /pathRegeneration/ });
  assert.throws(() => createNativeSession(input, { maxSeconds: -1 }), { name: 'RangeError', message: /maxSeconds/ });
});

test('createNativeSession without the built addon says how to build it', { skip: skipWithAddon }, () => {
  assert.throws(() => createNativeSession(roomInput([0, 2.2, 6])), { message: /not built/ });
});

test('a session input carries the kernel parameters patched by the default options', () => {
  const input = roomInput([0, 2.2, 6]);
  const unpatchedFlags = readKernelFlags(input.kernelParams);
  assert.equal(unpatchedFlags & KERNEL_FLAG_WHITE_NOISE_SAMPLER, 0, 'the packed input uses the blue-noise sampler');
  const sessionInput = resolveSessionCreation(input, { sampler: 'white' });
  assert.notEqual(readKernelFlags(sessionInput.kernelParams) & KERNEL_FLAG_WHITE_NOISE_SAMPLER, 0);
  assert.equal(readKernelFlags(input.kernelParams), unpatchedFlags, 'the caller input is not modified');
});

test('a frame needs the size and the samples, from the defaults or from the call', () => {
  const sessionInput = resolveSessionCreation(roomInput([0, 2.2, 6]), { width: 24, height: 16 });
  assert.throws(
    () => resolveSessionFrame(sessionInput, { width: 24, height: 16 }, {}),
    { name: 'TypeError', message: /samples/ }
  );
  const frame = resolveSessionFrame(sessionInput, { width: 24, height: 16 }, { samples: 8 });
  assert.equal(frame.width, 24);
  assert.equal(frame.height, 16);
  assert.equal(frame.samples, 8);
  assert.equal(frame.kernelParams.byteLength, 320);
});

test('a frame option replaces the default and an undefined one does not', () => {
  const sessionInput = resolveSessionCreation(roomInput([0, 2.2, 6]), {});
  const defaults = { width: 24, height: 16, samples: 32 };
  const frame = resolveSessionFrame(sessionInput, defaults, { samples: 64, width: undefined });
  assert.equal(frame.samples, 64);
  assert.equal(frame.width, 24);
});

test('a frame patches the sampler flag on its own copy of the parameters', () => {
  const sessionInput = resolveSessionCreation(roomInput([0, 2.2, 6]), {});
  const defaults = { width: 24, height: 16, samples: 4 };
  const white = resolveSessionFrame(sessionInput, defaults, { sampler: 'white' });
  const blueNoise = resolveSessionFrame(sessionInput, defaults, { sampler: 'sobol-burley' });
  assert.notEqual(readKernelFlags(white.kernelParams) & KERNEL_FLAG_WHITE_NOISE_SAMPLER, 0);
  assert.equal(readKernelFlags(blueNoise.kernelParams) & KERNEL_FLAG_WHITE_NOISE_SAMPLER, 0);
  assert.equal(readKernelFlags(sessionInput.kernelParams) & KERNEL_FLAG_WHITE_NOISE_SAMPLER, 0);
});

test('a frame patches the glossy filter into the parameters it was given', () => {
  const sessionInput = resolveSessionCreation(roomInput([0, 2.2, 6]), {});
  const defaults = { width: 24, height: 16, samples: 4 };
  const frame = resolveSessionFrame(sessionInput, defaults, { filterGlossy: 0 });
  const view = new DataView(frame.kernelParams.buffer, frame.kernelParams.byteOffset, frame.kernelParams.byteLength);
  assert.equal(view.getFloat32(KERNEL_PARAMS_V2_FILTER_GLOSSY_BYTE_OFFSET, true), 0);
});

test('a frame takes the camera of another packing through kernelParams', () => {
  const first = roomInput([0, 2.2, 6]);
  const second = roomInput([1.5, 2.2, 5]);
  assert.notDeepEqual(first.kernelParams, second.kernelParams);
  const sessionInput = resolveSessionCreation(first, {});
  const defaults = { width: 24, height: 16, samples: 4 };
  const frame = resolveSessionFrame(sessionInput, defaults, { kernelParams: second.kernelParams });
  assert.deepEqual(frame.kernelParams, second.kernelParams);
  assert.throws(
    () => resolveSessionFrame(sessionInput, defaults, { kernelParams: new Uint8Array(8) }),
    { name: 'TypeError', message: /320 bytes/ }
  );
});

test('a frame refuses the legacy kernel, bad options and a bad options object', () => {
  const sessionInput = resolveSessionCreation(roomInput([0, 2.2, 6]), {});
  const defaults = { width: 24, height: 16, samples: 4 };
  assert.throws(() => resolveSessionFrame(sessionInput, defaults, { kernel: 'legacy' }), { name: 'TypeError', message: /"cycles" kernel only/ });
  assert.throws(() => resolveSessionFrame(sessionInput, defaults, { samples: 1.5 }), { name: 'RangeError', message: /integer/ });
  assert.throws(() => resolveSessionFrame(sessionInput, defaults, null), { name: 'TypeError', message: /renderOptions/ });
});

test('a wrapped session passes the frame to the addon and joins the reuse flags to the result', () => {
  const sessionInput = resolveSessionCreation(roomInput([0, 2.2, 6]), {});
  const calls = [];
  const nativeSession = {
    render(frame) {
      calls.push(frame);
      return { trace: { rgba: new Float32Array(4), tracedSeconds: 0.5 }, session: { pipelineReused: calls.length > 1, frameIndex: calls.length - 1 } };
    },
    close() {
      calls.push('closed');
    },
  };
  const session = wrapNativeSession(nativeSession, sessionInput, { width: 24, height: 16 });
  const first = session.render({ samples: 4 });
  const second = session.render({ samples: 8 });
  assert.equal(calls[0].samples, 4);
  assert.equal(calls[1].samples, 8);
  assert.equal(first.pipelineReused, false);
  assert.equal(second.pipelineReused, true);
  assert.equal(second.frameIndex, 1);
  assert.equal(second.tracedSeconds, 0.5);
  assert.equal(session.closed, false);
});

test('a closed session refuses to render and closing twice frees the card once', () => {
  const sessionInput = resolveSessionCreation(roomInput([0, 2.2, 6]), {});
  const calls = [];
  const nativeSession = {
    render() {
      calls.push('render');
      return { trace: {}, session: {} };
    },
    close() {
      calls.push('close');
    },
  };
  const session = wrapNativeSession(nativeSession, sessionInput, {});
  session.close();
  session.close();
  assert.equal(session.closed, true);
  assert.throws(() => session.render({ width: 24, height: 16, samples: 4 }), { message: /closed/ });
  assert.deepEqual(calls, ['close']);
});

// ---- Renders on the GPU ----

test('a session render equals the one-shot render byte for byte and the second frame reuses the setup', { skip: skipWithoutAddon }, () => {
  const input = roomInput([0, 2.2, 6]);
  const options = { ...IMAGE_OPTIONS, kernel: 'cycles' };
  const oneShot = traceNative(input, options);
  const session = createNativeSession(input);
  try {
    const first = session.render(options);
    assertSameBytes(oneShot, first, 'the first session frame against the one-shot render');
    assert.equal(first.frameIndex, 0);
    assert.equal(first.accelerationReused, false);
    assert.equal(first.pipelineReused, false);
    assert.equal(first.filmReused, false);

    const second = session.render(options);
    assertSameBytes(oneShot, second, 'the second session frame against the one-shot render');
    assert.equal(second.frameIndex, 1);
    assert.equal(second.accelerationReused, true);
    assert.equal(second.pipelineReused, true);
    assert.equal(second.filmReused, true);
    assert.equal(second.accelerationBuildSeconds, 0);
    assert.equal(second.setupSeconds, 0);
  } finally {
    session.close();
  }
});

test('a frame that changes only the camera equals a fresh one-shot render of that camera', { skip: skipWithoutAddon }, () => {
  const firstInput = roomInput([0, 2.2, 6]);
  const secondInput = roomInput([1.5, 2.2, 5]);
  const options = { ...IMAGE_OPTIONS, kernel: 'cycles' };
  const session = createNativeSession(firstInput);
  try {
    const firstFrame = session.render(options);
    const movedFrame = session.render({ ...options, kernelParams: secondInput.kernelParams });
    assertSameBytes(traceNative(secondInput, options), movedFrame, 'the moved camera against a one-shot render of it');
    assert.ok(!bytesOf(firstFrame, 'rgba').equals(bytesOf(movedFrame, 'rgba')), 'the two cameras must give different images');
    assert.equal(movedFrame.accelerationReused, true);
    assert.equal(movedFrame.pipelineReused, true);
    assert.equal(movedFrame.accelerationBuildSeconds, 0);
    const backFrame = session.render(options);
    assertSameBytes(firstFrame, backFrame, 'the first camera again');
  } finally {
    session.close();
  }
});

test('a frame with another sample count or image size equals the one-shot render and keeps what it can', { skip: skipWithoutAddon }, () => {
  const input = roomInput([0, 2.2, 6]);
  const options = { ...IMAGE_OPTIONS, kernel: 'cycles' };
  const session = createNativeSession(input);
  try {
    session.render(options);
    const moreSamples = session.render({ ...options, samples: 48 });
    assertSameBytes(traceNative(input, { ...options, samples: 48 }), moreSamples, 'another sample count');
    assert.equal(moreSamples.filmReused, true);
    assert.equal(moreSamples.pipelineReused, true);

    const larger = session.render({ ...options, width: 32, height: 20 });
    assertSameBytes(traceNative(input, { ...options, width: 32, height: 20 }), larger, 'another image size');
    assert.equal(larger.filmReused, false);
    assert.equal(larger.pipelineReused, true);
    assert.equal(larger.accelerationReused, true);
    assert.equal(larger.rgba.length, 32 * 20 * 4);
  } finally {
    session.close();
  }
});

test('a session takes its default options and a frame option overrides them', { skip: skipWithoutAddon }, () => {
  const input = roomInput([0, 2.2, 6]);
  const options = { ...IMAGE_OPTIONS, kernel: 'cycles' };
  const session = createNativeSession(input, { ...IMAGE_OPTIONS, sampler: 'white' });
  try {
    assertSameBytes(traceNative(input, { ...options, sampler: 'white' }), session.render({}), 'the default sampler');
    assertSameBytes(traceNative(input, { ...options, sampler: 'sobol-burley' }), session.render({ sampler: 'sobol-burley' }), 'a frame sampler');
  } finally {
    session.close();
  }
});

test('a frame of another scene is refused', { skip: skipWithoutAddon }, () => {
  const input = roomInput([0, 2.2, 6]);
  const session = createNativeSession(input);
  try {
    const otherScene = new Uint8Array(input.kernelParams);
    new DataView(otherScene.buffer).setUint32(MATERIAL_COUNT_BYTE_OFFSET, 9, true);
    assert.throws(() => session.render({ ...IMAGE_OPTIONS, kernelParams: otherScene }), { message: /materialCount/ });
    assert.ok(session.render(IMAGE_OPTIONS).rgba.every(Number.isFinite), 'the session still renders after a refused frame');
  } finally {
    session.close();
  }
});

test('rendering after close throws and the card is free for a new session', { skip: skipWithoutAddon }, () => {
  const input = roomInput([0, 2.2, 6]);
  const options = { ...IMAGE_OPTIONS, kernel: 'cycles' };
  const session = createNativeSession(input);
  session.render(options);
  session.close();
  assert.throws(() => session.render(options), { message: /closed/ });
  const fresh = createNativeSession(input);
  try {
    assertSameBytes(traceNative(input, options), fresh.render(options), 'a new session after a close');
  } finally {
    fresh.close();
  }
});

const ENV_WIDTH_BYTE_OFFSET = 192;
const SOBOL_TABLE_OFFSET_BYTE_OFFSET = 296;

test('a frame that changes the environment table shape or a texel pool offset is refused', { skip: skipWithoutAddon }, () => {
  const input = roomInput([0, 2.2, 6]);
  const session = createNativeSession(input);
  try {
    for (const [byteOffset, fieldName] of [[ENV_WIDTH_BYTE_OFFSET, /envWidth/], [SOBOL_TABLE_OFFSET_BYTE_OFFSET, /sobolTableOffset/]]) {
      const changed = new Uint8Array(input.kernelParams);
      const view = new DataView(changed.buffer);
      view.setUint32(byteOffset, view.getUint32(byteOffset, true) + 64, true);
      assert.throws(() => session.render({ ...IMAGE_OPTIONS, kernelParams: changed }), { message: fieldName });
    }
  } finally {
    session.close();
  }
});

test('a first frame that fails leaves the creation costs for the retry', { skip: skipWithoutAddon }, () => {
  const input = roomInput([0, 2.2, 6]);
  const options = { ...IMAGE_OPTIONS, kernel: 'cycles' };
  const session = createNativeSession(input);
  try {
    assert.throws(() => session.render({ ...options, samples: 4096, maxSeconds: 1e-6 }), { message: /time limit/ });
    const retry = session.render(options);
    assert.equal(retry.frameIndex, 0);
    assert.equal(retry.accelerationReused, false);
    assert.ok(retry.setupSeconds > 0, 'the creation setup seconds are reported by the first frame that succeeds');
    assertSameBytes(traceNative(input, options), retry, 'the retry against the one-shot render');
    assert.equal(session.render(options).accelerationReused, true);
  } finally {
    session.close();
  }
});
