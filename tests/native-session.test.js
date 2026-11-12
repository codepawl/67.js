import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildNativeInputV2,
  createNativeSession,
  findNativeAddon,
  planNativeSessionUpdate,
  resolveSessionCreation,
  resolveSessionFrame,
  traceNative,
  withPathRegenerationFlag,
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
  assert.deepEqual(frame.kernelParams, withPathRegenerationFlag(second.kernelParams, true));
  const withoutRegeneration = resolveSessionFrame(sessionInput, defaults, { kernelParams: second.kernelParams, pathRegeneration: false });
  assert.deepEqual(withoutRegeneration.kernelParams, withPathRegenerationFlag(second.kernelParams, false));
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

// ---- Progressive film and scene updates: argument checks and the wrapper, without the addon ----

function roomInputWith(changeScene, eye = [0, 2.2, 6], options = IMAGE_OPTIONS) {
  const scene = buildRoomScene();
  changeScene(scene);
  const camera = createCamera({ eye, target: [0, 0.5, 0], fov: 45 }, options.width, options.height);
  return buildNativeInputV2(scene, camera, options);
}

const DEFAULT_FRAME = { width: 24, height: 16, samples: 8 };

test('a frame passes accumulate and targetSamples on and checks them', () => {
  const sessionInput = resolveSessionCreation(roomInput([0, 2.2, 6]), {});
  const frame = resolveSessionFrame(sessionInput, DEFAULT_FRAME, { accumulate: true, targetSamples: 32 });
  assert.equal(frame.accumulate, true);
  assert.equal(frame.targetSamples, 32);
  const plain = resolveSessionFrame(sessionInput, DEFAULT_FRAME, {});
  assert.equal(plain.accumulate, undefined);
  assert.equal(plain.targetSamples, undefined);
  const fromDefaults = resolveSessionFrame(sessionInput, { ...DEFAULT_FRAME, accumulate: true, targetSamples: 64 }, {});
  assert.equal(fromDefaults.targetSamples, 64);

  assert.throws(() => resolveSessionFrame(sessionInput, DEFAULT_FRAME, { accumulate: 'yes' }), { name: 'TypeError', message: /accumulate/ });
  assert.throws(() => resolveSessionFrame(sessionInput, DEFAULT_FRAME, { targetSamples: 32 }), { name: 'TypeError', message: /accumulate: true/ });
  assert.throws(() => resolveSessionFrame(sessionInput, DEFAULT_FRAME, { accumulate: true, targetSamples: 1.5 }), { name: 'RangeError', message: /targetSamples/ });
  assert.throws(() => resolveSessionFrame(sessionInput, DEFAULT_FRAME, { accumulate: true, targetSamples: 0 }), { name: 'RangeError', message: /targetSamples/ });
  assert.throws(() => resolveSessionFrame(sessionInput, DEFAULT_FRAME, { accumulate: true, targetSamples: 4 }), { name: 'RangeError', message: /more than .targetSamples/ });
});

test('planNativeSessionUpdate sends nothing for the same input and only the tables whose bytes changed', () => {
  const current = roomInput([0, 2.2, 6]);
  assert.deepEqual(planNativeSessionUpdate(current, roomInput([1.5, 2.2, 5])), {}, 'a camera is not a table');

  const recoloured = roomInputWith((scene) => {
    scene.materials[0].color = [0.2, 0.5, 0.8];
  });
  const colourPlan = planNativeSessionUpdate(current, recoloured);
  assert.deepEqual(Object.keys(colourPlan), ['materials']);
  assert.equal(colourPlan.materials, recoloured.materials);

  const moved = roomInputWith((scene) => {
    scene.instances[0].matrix = horizontalQuadMatrix(8, -0.25, true);
  });
  const movePlan = planNativeSessionUpdate(current, moved);
  assert.ok(Object.keys(movePlan).includes('instances'));
  assert.ok(!Object.keys(movePlan).includes('materials'));
});

test('planNativeSessionUpdate refuses a change of record counts and names it', () => {
  const current = roomInput([0, 2.2, 6]);
  const withExtraQuad = roomInputWith((scene) => {
    scene.instances.push({ geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(1, 1, true), materialIndex: 0 });
  });
  assert.throws(() => planNativeSessionUpdate(current, withExtraQuad), { message: /`instanceCount` changes from 3 to 4.*createNativeSession/ });
  const withExtraMaterial = roomInputWith((scene) => {
    scene.materials.push({ color: [1, 0, 0] });
  });
  assert.throws(() => planNativeSessionUpdate(current, withExtraMaterial), { message: /`materialCount` changes from 2 to 3/ });
});

test('planNativeSessionUpdate refuses other geometry, other textures and an instance that places another mesh', () => {
  const current = roomInput([0, 2.2, 6]);
  const bent = { ...current, triangles: new Uint8Array(current.triangles) };
  new DataView(bent.triangles.buffer).setFloat32(8, 0.5, true);
  assert.throws(() => planNativeSessionUpdate(current, bent), { message: /`triangles` differs.*the geometry/ });
  const otherMesh = roomInputWith((scene) => {
    scene.instances[0].geometry = { ...UNIT_QUAD, positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0.5, -1, 1, 0]) };
  });
  assert.throws(() => planNativeSessionUpdate(current, otherMesh), { message: /`triangleCount` changes from 2 to 4/ });

  const otherTexels = { ...current, textureTexels: new Uint32Array([1, 2, 3, 4]) };
  assert.throws(() => planNativeSessionUpdate({ ...current, textureTexels: new Uint32Array(4) }, otherTexels), { message: /`textureTexels` differs.*the textures/ });

  const swappedMesh = { ...current, instances: new Uint8Array(current.instances) };
  new DataView(swappedMesh.instances.buffer).setUint32(160 + 100, 77, true);
  assert.throws(() => planNativeSessionUpdate(current, swappedMesh), { message: /instance 1 changes `triangleOffset` from \d+ to 77.*not change the mesh/ });
});

test('a wrapped session resets, resolves and updates through the addon and keeps the new defaults', () => {
  const first = roomInput([0, 2.2, 6]);
  const second = roomInputWith((scene) => {
    scene.materials[0].color = [0.2, 0.5, 0.8];
  }, [1.5, 2.2, 5]);
  const calls = [];
  const nativeSession = {
    render(frame) {
      calls.push(['render', frame]);
      return { trace: { rgba: new Float32Array(4) }, session: { filmSamples: frame.samples } };
    },
    reset() {
      calls.push(['reset']);
    },
    resolve(options) {
      calls.push(['resolve', options]);
      return { trace: { rgba: new Float32Array(4), tracedSeconds: 0 }, session: { filmSamples: 8 } };
    },
    update(options) {
      calls.push(['update', options]);
      return { uploadedTables: Object.keys(options).filter((name) => name !== 'kernelParams'), accelerationRebuilt: false };
    },
    close() {
      calls.push(['close']);
    },
  };
  const sessionInput = resolveSessionCreation(first, {});
  const session = wrapNativeSession(nativeSession, sessionInput, { width: 24, height: 16, samples: 4 });

  session.reset();
  assert.equal(session.resolve().filmSamples, 8);
  assert.deepEqual(calls[1], ['resolve', { denoise: undefined }]);
  session.resolve({ denoise: 'atrous' });
  assert.deepEqual(calls[2], ['resolve', { denoise: 'atrous' }]);
  assert.throws(() => session.resolve({ denoise: 'bilateral' }), { message: /denoise/ });
  assert.throws(() => session.resolve(null), { name: 'TypeError', message: /resolveOptions/ });

  const report = session.update(second);
  assert.deepEqual(report.uploadedTables, ['materials']);
  const updateCall = calls.find(([name]) => name === 'update')[1];
  assert.deepEqual(Object.keys(updateCall).sort(), ['kernelParams', 'materials']);
  assert.deepEqual(updateCall.kernelParams, resolveSessionCreation(second, {}).kernelParams);

  session.render({});
  const frameAfterUpdate = calls.filter(([name]) => name === 'render').pop()[1];
  assert.deepEqual(frameAfterUpdate.kernelParams, updateCall.kernelParams, 'a frame after the update starts from the new kernel parameters');
});

test('a refused update changes nothing and a closed session refuses reset, resolve and update', () => {
  const current = roomInput([0, 2.2, 6]);
  const calls = [];
  const nativeSession = {
    update() {
      calls.push('update');
      return {};
    },
    reset() {
      calls.push('reset');
    },
    resolve() {
      calls.push('resolve');
      return { trace: {}, session: {} };
    },
    close() {},
  };
  const session = wrapNativeSession(nativeSession, resolveSessionCreation(current, {}), {});
  const withExtraQuad = roomInputWith((scene) => {
    scene.instances.push({ geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(1, 1, true), materialIndex: 0 });
  });
  assert.throws(() => session.update(withExtraQuad), { message: /instanceCount/ });
  assert.throws(() => session.update(undefined), { name: 'TypeError', message: /^NativeSession.update: `input` must be a FORMAT-v2/ });
  assert.deepEqual(calls, [], 'the addon is not called for a refused update');
  session.close();
  for (const method of ['reset', 'resolve']) {
    assert.throws(() => session[method](), { message: new RegExp(`NativeSession.${method}: this session is closed`) });
  }
  assert.throws(() => session.update(current), { message: /NativeSession.update: this session is closed/ });
  assert.deepEqual(calls, []);
});

test('an update the addon refuses leaves the wrapper diffing against the scene the addon still holds', () => {
  const current = roomInputWith(() => {});
  const changed = roomInputWith((scene) => {
    scene.materials[0].color = [0.2, 0.5, 0.8];
  });
  const updates = [];
  let refuse = true;
  const nativeSession = {
    update(options) {
      updates.push(options);
      if (refuse) throw new Error('The update failed part way');
      return {};
    },
    close() {},
  };
  const session = wrapNativeSession(nativeSession, resolveSessionCreation(current, {}), {});
  assert.throws(() => session.update(changed), { message: /failed part way/ });
  refuse = false;
  session.update(changed);
  assert.equal(updates.length, 2);
  assert.deepEqual(Object.keys(updates[1]).sort(), Object.keys(updates[0]).sort(), 'the retry diffs against the old scene, so it sends the same tables');
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

// ---- Progressive film on the GPU ----

const FILM_SAMPLES = 32;
const FILM_SPLITS = [[16, 16], [8, 8, 16], [5, 11, 7, 9], [1, 31]];

function renderInParts(session, options, parts, targetSamples = FILM_SAMPLES) {
  let drawn = 0;
  let last;
  for (const samples of parts) {
    last = session.render({ ...options, samples, accumulate: true, ...(drawn === 0 ? { targetSamples } : {}) });
    assert.equal(last.firstSample, drawn, 'the call continues where the film left off');
    drawn += samples;
    assert.equal(last.filmSamples, drawn);
    assert.equal(last.targetSamples, targetSamples);
  }
  return last;
}

test('one image over several calls equals one render of the same samples, for both samplers, with and without path regeneration', { skip: skipWithoutAddon }, () => {
  const input = roomInput([0, 2.2, 6]);
  const session = createNativeSession(input);
  try {
    for (const sampler of ['sobol-burley', 'white']) {
      for (const pathRegeneration of [true, false]) {
        for (const samplesPerDispatch of [undefined, 3]) {
          const options = { ...IMAGE_OPTIONS, samples: FILM_SAMPLES, kernel: 'cycles', sampler, pathRegeneration, samplesPerDispatch };
          const oneShot = traceNative(input, options);
          for (const parts of FILM_SPLITS) {
            session.reset();
            const label = `${sampler}, regeneration ${pathRegeneration}, samplesPerDispatch ${samplesPerDispatch}, split ${parts.join('+')}`;
            const split = renderInParts(session, options, parts);
            assertSameBytes(oneShot, split, label);
            assertSameBytes(oneShot, session.resolve(), `${label}, resolved without tracing`);
          }
        }
      }
    }
  } finally {
    session.close();
  }
});

test('resolve gives the a-trous image of the film and traces nothing', { skip: skipWithoutAddon }, () => {
  const input = roomInput([0, 2.2, 6]);
  const options = { ...IMAGE_OPTIONS, samples: FILM_SAMPLES, kernel: 'cycles', denoise: 'atrous' };
  const oneShot = traceNative(input, options);
  const session = createNativeSession(input);
  try {
    renderInParts(session, options, [10, 22]);
    const resolved = session.resolve({ denoise: 'atrous' });
    assertSameBytes(oneShot, resolved, 'the film');
    assert.ok(bytesOf(oneShot, 'denoisedRgba').equals(bytesOf(resolved, 'denoisedRgba')), 'the denoised image');
    assert.equal(resolved.tracedSeconds, 0);
    assert.equal(resolved.compileSeconds, 0);
    assert.equal(resolved.accelerationBuildSeconds, 0);
    assert.equal(resolved.pipelineReused, true);
    assert.equal(resolved.filmSamples, FILM_SAMPLES);
    assert.equal(resolved.denoisedRgba.length, 24 * 16 * 4);
    assert.ok([null, undefined].includes(session.resolve().denoisedRgba), 'no denoise unless asked');
  } finally {
    session.close();
  }
});

test('a call that does not belong to the film is refused and leaves the film as it was', { skip: skipWithoutAddon }, () => {
  const input = roomInput([0, 2.2, 6]);
  const movedCamera = roomInput([1.5, 2.2, 5]);
  const options = { ...IMAGE_OPTIONS, samples: 16, kernel: 'cycles' };
  const session = createNativeSession(input);
  try {
    assert.throws(() => session.render({ ...options, accumulate: true }), { message: /needs targetSamples/ });
    session.render({ ...options, accumulate: true, targetSamples: FILM_SAMPLES });
    assert.throws(() => session.render({ ...options, accumulate: true, kernelParams: movedCamera.kernelParams }), { message: /kernel parameters.*reset\(\)/ });
    assert.throws(() => session.render({ ...options, samples: 20, accumulate: true }), { message: /Ask for 16 or fewer/ });
    assert.throws(() => session.render({ ...options, width: 32, height: 20, accumulate: true }), { message: /24x16.*32x20/ });
    assert.throws(() => session.render({ ...options, accumulate: true, targetSamples: 64 }), { message: /started for 32/ });
    const finished = session.render({ ...options, accumulate: true });
    assert.equal(finished.firstSample, 16);
    assertSameBytes(traceNative(input, { ...options, samples: FILM_SAMPLES }), finished, 'after the refused calls');
    assert.throws(() => session.render({ ...options, samples: 1, accumulate: true }), { message: /more would pass targetSamples/ });
  } finally {
    session.close();
  }
});

test('reset starts over, a plain frame discards the image and resolve needs samples', { skip: skipWithoutAddon }, () => {
  const input = roomInput([0, 2.2, 6]);
  const options = { ...IMAGE_OPTIONS, samples: FILM_SAMPLES, kernel: 'cycles' };
  const oneShot = traceNative(input, options);
  const session = createNativeSession(input);
  try {
    assert.throws(() => session.resolve(), { message: /holds no samples/ });
    renderInParts(session, options, [10]);
    session.reset();
    assert.throws(() => session.resolve(), { message: /holds no samples/ });
    assertSameBytes(oneShot, renderInParts(session, options, [12, 20]), 'after a reset');

    const plain = session.render(options);
    assertSameBytes(oneShot, plain, 'a plain frame');
    assert.equal(plain.firstSample, 0);
    assert.equal(plain.filmSamples, FILM_SAMPLES);
    assert.ok(plain.targetSamples === null || plain.targetSamples === undefined, 'a plain frame has no target');
    assert.throws(() => session.render({ ...options, samples: 4, accumulate: true }), { message: /needs targetSamples/ });
    assertSameBytes(oneShot, session.resolve(), 'the plain frame as the film');
  } finally {
    session.close();
  }
});

// ---- Scene updates on the GPU ----

function recolourFloor(scene) {
  scene.materials[0].color = [0.2, 0.5, 0.8];
}

function moveFloorAndLamp(scene) {
  scene.instances[0].matrix = horizontalQuadMatrix(8, -0.25, true);
  scene.instances[2].matrix = horizontalQuadMatrix(1, 2.4, false);
}

test('an update of material values equals a fresh render of the final input and keeps the pipeline and the BLAS', { skip: skipWithoutAddon }, () => {
  const options = { ...IMAGE_OPTIONS, kernel: 'cycles' };
  const before = roomInput([0, 2.2, 6]);
  const after = roomInputWith(recolourFloor);
  const session = createNativeSession(before);
  try {
    const cold = session.render(options);
    const report = session.update(after);
    assert.deepEqual(report.uploadedTables, ['materials']);
    assert.equal(report.accelerationRebuilt, false);
    assert.equal(report.changedInstances, 0);
    assert.equal(report.kernelRespecialized, false);
    const warm = session.render(options);
    assertSameBytes(traceNative(after, options), warm, 'the update then render against a fresh one-shot render');
    assert.ok(!bytesOf(cold, 'rgba').equals(bytesOf(warm, 'rgba')), 'the new colour must show');
    assert.equal(warm.accelerationReused, true);
    assert.equal(warm.pipelineReused, true);
    assert.equal(warm.accelerationBuildSeconds, 0);
  } finally {
    session.close();
  }
});

test('moving instances rebuilds only the TLAS and the next render equals a fresh render of the moved scene', { skip: skipWithoutAddon }, () => {
  const options = { ...IMAGE_OPTIONS, kernel: 'cycles' };
  const before = roomInput([0, 2.2, 6]);
  const after = roomInputWith(moveFloorAndLamp);
  const session = createNativeSession(before);
  try {
    const cold = session.render(options);
    const report = session.update(after);
    assert.ok(report.uploadedTables.includes('instances'));
    assert.equal(report.accelerationRebuilt, true);
    assert.equal(report.changedInstances, 2);
    const moved = session.render(options);
    assertSameBytes(traceNative(after, options), moved, 'the moved scene');
    assert.ok(!bytesOf(cold, 'rgba').equals(bytesOf(moved, 'rgba')));
    assert.equal(moved.accelerationReused, true);
    assert.equal(moved.accelerationBuildSeconds, 0);
    assert.equal(moved.pipelineReused, true);

    const back = session.update(before);
    assert.equal(back.accelerationRebuilt, true);
    assertSameBytes(cold, session.render(options), 'moved back to the first placement');
  } finally {
    session.close();
  }
});

test('an update that changes what the kernel is specialized for compiles again and still equals a fresh render', { skip: skipWithoutAddon }, () => {
  const options = { ...IMAGE_OPTIONS, kernel: 'cycles' };
  const before = roomInput([0, 2.2, 6]);
  const glass = roomInputWith((scene) => {
    scene.materials[0].transmission = 0.8;
  });
  const session = createNativeSession(before);
  try {
    session.render(options);
    const report = session.update(glass);
    assert.equal(report.kernelRespecialized, true);
    const rendered = session.render(options);
    assert.equal(rendered.pipelineReused, false);
    assert.equal(rendered.accelerationReused, true);
    assertSameBytes(traceNative(glass, options), rendered, 'the transmissive floor');
  } finally {
    session.close();
  }
});

test('an update with a new camera only sends no table, and the same input again changes nothing', { skip: skipWithoutAddon }, () => {
  const options = { ...IMAGE_OPTIONS, kernel: 'cycles' };
  const first = roomInput([0, 2.2, 6]);
  const moved = roomInput([1.5, 2.2, 5]);
  const session = createNativeSession(first);
  try {
    session.render(options);
    const same = session.update(first);
    assert.deepEqual(same.uploadedTables, []);
    assert.equal(same.accelerationRebuilt, false);
    const cameraOnly = session.update(moved);
    assert.deepEqual(cameraOnly.uploadedTables, []);
    assertSameBytes(traceNative(moved, options), session.render(options), 'the new default camera');
  } finally {
    session.close();
  }
});

test('an update ends the progressive image and the next one equals a fresh render of the final input', { skip: skipWithoutAddon }, () => {
  const options = { ...IMAGE_OPTIONS, samples: FILM_SAMPLES, kernel: 'cycles' };
  const before = roomInput([0, 2.2, 6]);
  const after = roomInputWith(moveFloorAndLamp);
  const session = createNativeSession(before);
  try {
    renderInParts(session, options, [10]);
    session.update(after);
    assert.throws(() => session.resolve(), { message: /holds no samples/ });
    assert.throws(() => session.render({ ...options, samples: 4, accumulate: true }), { message: /needs targetSamples/ });
    assertSameBytes(traceNative(after, options), renderInParts(session, options, [7, 25]), 'the image after the update');
  } finally {
    session.close();
  }
});

test('an update that cannot be applied is refused before anything changes', { skip: skipWithoutAddon }, () => {
  const options = { ...IMAGE_OPTIONS, kernel: 'cycles' };
  const before = roomInput([0, 2.2, 6]);
  const session = createNativeSession(before);
  try {
    const oneShot = traceNative(before, options);
    assertSameBytes(oneShot, session.render(options), 'before the refused updates');
    const withExtraQuad = roomInputWith((scene) => {
      scene.instances.push({ geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(1, 1, true), materialIndex: 0 });
    });
    assert.throws(() => session.update(withExtraQuad), { message: /instanceCount.*createNativeSession/ });
    const otherEnvironment = new Uint8Array(before.kernelParams);
    new DataView(otherEnvironment.buffer).setUint32(ENV_WIDTH_BYTE_OFFSET, 64, true);
    assert.throws(() => session.update({ ...before, kernelParams: otherEnvironment }), { message: /envWidth.*create a new session/ });
    assertSameBytes(oneShot, session.render(options), 'after the refused updates');
  } finally {
    session.close();
  }
  assert.throws(() => session.update(before), { message: /closed/ });
});

test('an updated session renders like a new session and the timings of both are printed', { skip: skipWithoutAddon }, () => {
  const options = { ...IMAGE_OPTIONS, samples: 4, kernel: 'cycles' };
  const before = roomInput([0, 2.2, 6]);
  const after = roomInputWith(moveFloorAndLamp);
  const session = createNativeSession(before);
  try {
    session.render(options);
    const updateStarted = performance.now();
    const report = session.update(after);
    const updated = session.render(options);
    const updateMilliseconds = performance.now() - updateStarted;
    const newSessionStarted = performance.now();
    const fresh = createNativeSession(after);
    let newSessionFrame;
    try {
      newSessionFrame = fresh.render(options);
    } finally {
      fresh.close();
    }
    const newSessionMilliseconds = performance.now() - newSessionStarted;
    assertSameBytes(newSessionFrame, updated, 'the updated session against a new session');
    console.log(`SESSION_UPDATE_TIMING ${JSON.stringify({
      updateAndRenderMilliseconds: Number(updateMilliseconds.toFixed(2)),
      newSessionAndRenderMilliseconds: Number(newSessionMilliseconds.toFixed(2)),
      updateSeconds: report.updateSeconds,
      accelerationRebuildSeconds: report.accelerationRebuildSeconds,
      newSessionCompileSeconds: newSessionFrame.compileSeconds,
      newSessionAccelerationBuildSeconds: newSessionFrame.accelerationBuildSeconds,
    })}`);
    assert.equal(updated.accelerationBuildSeconds, 0);
  } finally {
    session.close();
  }
});
