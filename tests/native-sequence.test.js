import assert from 'node:assert/strict';
import test from 'node:test';
import { cookInstalled, cookModule, cookTest } from './support/cook.js';
import { createNativeSequence } from '../scripts/agent-native-sequence.mjs';
import { traceFrameNative } from '../scripts/agent-native-trace.mjs';
import { createCamera } from '../src/path-tracer.js';

const renderNative = (await cookModule()) ?? {};
const addonIsBuilt = cookInstalled && renderNative.findNativeAddon() !== null;
const skipWithoutAddon = addonIsBuilt ? false : 'the native addon is not built';
const TRACE_OPTIONS = { width: 4, height: 4, samples: 2, maxSeconds: 5, kernel: 'cycles' };

// ---- The frame loop's decisions, with a stand-in for the package ----

function inputWith({ materialByte = 1, instanceCount = 1, camera = 0, geometryByte = 0 } = {}) {
  return {
    schemaVersion: 2,
    kernelParams: new Uint8Array([camera]),
    instanceCount,
    instances: new Uint8Array(instanceCount * 160),
    materialCount: 1,
    materials: new Uint8Array([materialByte]),
    triangleCount: 1,
    triangles: new Uint8Array([geometryByte]),
  };
}

function fakeTracer({ failUpdate = false, failRender = null, failCreate = false, withSessions = true } = {}) {
  const events = [];
  const tracer = {
    events,
    prepareCyclesInput: input => input,
    planNativeSessionUpdate: renderNative.planNativeSessionUpdate,
    traceNative(input, options) {
      events.push(['one-shot', options.kernel]);
      return { rgba: new Float32Array(4), oneShot: true };
    },
  };
  if (withSessions) {
    let sessionNumber = 0;
    tracer.createNativeSession = input => {
      if (failCreate) throw new Error('no adapter');
      sessionNumber += 1;
      const id = sessionNumber;
      let frames = 0;
      events.push(['create', id]);
      return {
        update(next) {
          events.push(['update', id]);
          if (failUpdate) throw new Error('the card failed part way');
          return { accelerationRebuilt: false, kernelRespecialized: false, updateSeconds: 0.5, input: next };
        },
        render(frameOptions) {
          events.push(['render', id, Array.from(frameOptions.kernelParams)]);
          if (failRender) throw failRender;
          frames += 1;
          return { rgba: new Float32Array(4), pipelineReused: frames > 1, accelerationReused: frames > 1, frameIndex: frames - 1 };
        },
        close() {
          events.push(['close', id]);
        },
      };
    };
  }
  return tracer;
}

cookTest('the first frame creates a session and a camera-only frame reuses it with its own kernel parameters', () => {
  const tracer = fakeTracer();
  const sequence = createNativeSequence({ tracer });
  const first = sequence.trace(inputWith({ camera: 1 }), TRACE_OPTIONS);
  assert.equal(first.route.path, 'new-session');
  assert.equal(first.route.reason, 'first frame of the sequence');
  const second = sequence.trace(inputWith({ camera: 2 }), TRACE_OPTIONS);
  assert.deepEqual(second.route, { path: 'reused', pipelineReused: true, accelerationReused: true, frameIndex: 1 });
  assert.deepEqual(tracer.events, [['create', 1], ['render', 1, [1]], ['render', 1, [2]]]);
});

cookTest('a frame with other materials sends the changed tables through update and keeps the session', () => {
  const tracer = fakeTracer();
  const sequence = createNativeSequence({ tracer });
  sequence.trace(inputWith(), TRACE_OPTIONS);
  const { route } = sequence.trace(inputWith({ materialByte: 9 }), TRACE_OPTIONS);
  assert.equal(route.path, 'updated');
  assert.deepEqual(route.changedTables, ['materials']);
  assert.equal(route.accelerationRebuilt, false);
  assert.equal(route.updateSeconds, 0.5);
  assert.deepEqual(tracer.events.map(event => event[0]), ['create', 'render', 'update', 'render']);
});

cookTest('a frame the session cannot take closes it and starts a new one, saying what changed', () => {
  const tracer = fakeTracer();
  const sequence = createNativeSequence({ tracer });
  sequence.trace(inputWith(), TRACE_OPTIONS);
  const counted = sequence.trace(inputWith({ instanceCount: 2 }), TRACE_OPTIONS);
  assert.equal(counted.route.path, 'new-session');
  assert.match(counted.route.reason, /`instanceCount` changes from 1 to 2/);
  const geometry = sequence.trace(inputWith({ instanceCount: 2, geometryByte: 5 }), TRACE_OPTIONS);
  assert.equal(geometry.route.path, 'new-session');
  assert.match(geometry.route.reason, /`triangles` differs/);
  assert.deepEqual(tracer.events.filter(event => event[0] !== 'render'), [['create', 1], ['close', 1], ['create', 2], ['close', 2], ['create', 3]]);
});

cookTest('a failed update, which closes the session by design, falls to a new session for that frame', () => {
  const tracer = fakeTracer({ failUpdate: true });
  const sequence = createNativeSequence({ tracer });
  sequence.trace(inputWith(), TRACE_OPTIONS);
  const { route } = sequence.trace(inputWith({ materialByte: 9 }), TRACE_OPTIONS);
  assert.equal(route.path, 'new-session');
  assert.match(route.reason, /the session update failed \(the card failed part way\)/);
  assert.deepEqual(tracer.events.map(event => event[0]), ['create', 'render', 'update', 'close', 'create', 'render']);
  const next = sequence.trace(inputWith({ materialByte: 9, camera: 3 }), TRACE_OPTIONS);
  assert.equal(next.route.path, 'reused', 'the new session carries the sequence on');
});

cookTest('a package without sessions, or a card that cannot make one, traces each frame one-shot and says why', () => {
  const old = createNativeSequence({ tracer: fakeTracer({ withSessions: false }) });
  const oldFrame = old.trace(inputWith(), TRACE_OPTIONS);
  assert.equal(oldFrame.route.path, 'one-shot');
  assert.match(oldFrame.route.reason, /no createNativeSession/);
  assert.equal(oldFrame.traced.oneShot, true);

  const refusing = createNativeSequence({ tracer: fakeTracer({ failCreate: true }) });
  const refusedFrame = refusing.trace(inputWith(), TRACE_OPTIONS);
  assert.equal(refusedFrame.route.path, 'one-shot');
  assert.match(refusedFrame.route.reason, /first frame of the sequence; creating a session failed \(no adapter\)/);
});

cookTest('a render that fails falls back one-shot and the next frame starts a new session, but a time limit passes through', () => {
  const failing = fakeTracer({ failRender: new Error('device lost') });
  const sequence = createNativeSequence({ tracer: failing });
  const frame = sequence.trace(inputWith(), TRACE_OPTIONS);
  assert.equal(frame.route.path, 'one-shot');
  assert.match(frame.route.reason, /the session render failed \(device lost\)/);
  assert.deepEqual(failing.events.map(event => event[0]), ['create', 'render', 'close', 'one-shot']);

  const slow = fakeTracer({ failRender: new Error('the trace passed its time limit') });
  assert.throws(() => createNativeSequence({ tracer: slow }).trace(inputWith(), TRACE_OPTIONS), /time limit/);
  assert.deepEqual(slow.events.map(event => event[0]), ['create', 'render', 'close']);
});

cookTest('closing frees the session and a closed sequence refuses a frame', () => {
  const tracer = fakeTracer();
  const sequence = createNativeSequence({ tracer });
  sequence.trace(inputWith(), TRACE_OPTIONS);
  sequence.close();
  sequence.close();
  assert.deepEqual(tracer.events.filter(event => event[0] === 'close'), [['close', 1]]);
  assert.throws(() => sequence.trace(inputWith(), TRACE_OPTIONS), /sequence is closed/);
  assert.throws(() => createNativeSequence({}), { name: 'TypeError', message: /pass `tracer`/ });
});

const emptyExport = {
  triangleCount: 0, triangles: 0, ignored: [],
  tables: Object.fromEntries(['triangles', 'materials', 'lights', 'atlas', 'environmentColors', 'environmentTables', 'parameters'].map(name => [name, ''])),
};

test('traceFrameNative reports the route of a sequence frame, and a single frame carries none', async () => {
  const pixels = 16;
  const plane = (count) => new Float32Array(pixels * count);
  const traced = { rgba: plane(4), albedo: plane(3), normal: plane(3), depth: plane(1), variance: plane(1), adapter: 'test', backend: 'test' };
  const tracer = { traceNative: () => traced };
  const route = { path: 'reused', frameIndex: 3 };
  const sequenceCalls = [];
  const sequence = { trace: (input, options) => { sequenceCalls.push(options.kernel); return { traced, route }; } };
  const common = { tracer, exported: emptyExport, width: 4, height: 4, samples: 2, denoise: 'none' };

  const viaSequence = await traceFrameNative({ ...common, sequence, kernel: 'cycles' });
  assert.deepEqual(viaSequence.report.nativeSession, route);
  assert.deepEqual(sequenceCalls, ['cycles']);

  const single = await traceFrameNative({ ...common, kernel: 'cycles' });
  assert.equal('nativeSession' in single.report, false);
  const legacy = await traceFrameNative({ ...common, sequence, kernel: 'legacy' });
  assert.equal('nativeSession' in legacy.report, false, 'the legacy kernel has no sessions');
  assert.deepEqual(sequenceCalls, ['cycles']);
});

// ---- Identity against the one-shot render: needs the built addon and a Vulkan ray query adapter ----

const UNIT_QUAD = {
  positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  colors: new Float32Array(12).fill(1),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};
const IMAGE_OPTIONS = { width: 24, height: 16, samples: 16, bounces: 3, seed: 11 };
const RESULT_PLANES = ['rgba', 'albedo', 'normal', 'depth', 'variance'];

function horizontalQuadMatrix(scale, height, facesUp) {
  const upOrDown = facesUp ? 1 : -1;
  return [scale, 0, 0, 0, 0, 0, -upOrDown * scale, 0, 0, upOrDown * scale, 0, 0, 0, height, 0, 1];
}

function frameOf({ eye = [0, 2.2, 6], floorColor = [0.6, 0.6, 0.6], lampEmission = 5, lampHeight = 2, extraQuad = false }) {
  const scene = {
    materials: [{ color: floorColor, roughness: 0.8 }, { color: [1, 0.95, 0.9], emission: lampEmission, roughness: 1 }],
    instances: [
      { geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(8, 0, true), materialIndex: 0 },
      { geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(2, 3, false), materialOverride: 1 },
      { geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(1, lampHeight, false), materialOverride: 1 },
    ],
  };
  if (extraQuad) scene.instances.push({ geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(1, 1, true), materialIndex: 0 });
  const camera = createCamera({ eye, target: [0, 0.5, 0], fov: 45 }, IMAGE_OPTIONS.width, IMAGE_OPTIONS.height);
  return renderNative.buildNativeInputV2(scene, camera, IMAGE_OPTIONS);
}

function sameBytes(first, second) {
  return RESULT_PLANES.every(plane => Buffer.from(first[plane].buffer, first[plane].byteOffset, first[plane].byteLength)
    .equals(Buffer.from(second[plane].buffer, second[plane].byteOffset, second[plane].byteLength)));
}

// Renders every frame through one sequence and one-shot, requires the same bytes, and returns the routes.
function paths(frameSpecs) {
  const options = { ...IMAGE_OPTIONS, kernel: 'cycles' };
  const sequence = createNativeSequence({ tracer: renderNative });
  try {
    return frameSpecs.map((spec, index) => {
      const input = frameOf(spec);
      const { traced, route } = sequence.trace(input, options);
      assert.ok(sameBytes(traced, renderNative.traceNative(input, options)), `frame ${index} differs from the one-shot render`);
      return { route, traced };
    });
  } finally {
    sequence.close();
  }
}

cookTest('a camera orbit through a session equals one-shot frames and builds nothing after frame 1', { skip: skipWithoutAddon }, () => {
  const frames = paths([{ eye: [0, 2.2, 6] }, { eye: [1.5, 2.2, 5.5] }, { eye: [3, 2.2, 4.5] }]);
  assert.deepEqual(frames.map(frame => frame.route.path), ['new-session', 'reused', 'reused']);
  for (const { traced, route } of frames.slice(1)) {
    assert.equal(route.pipelineReused, true, 'the kernel is held, not compiled again');
    assert.equal(route.accelerationReused, true);
    assert.equal(traced.setupSeconds, 0);
    assert.equal(traced.accelerationBuildSeconds, 0);
  }
});

cookTest('a material, a light and a transform sequence equal one-shot frames and update in place', { skip: skipWithoutAddon }, () => {
  const frames = paths([
    { },
    { floorColor: [0.2, 0.5, 0.8], eye: [1, 2.2, 6] },
    { floorColor: [0.2, 0.5, 0.8], lampEmission: 9 },
    { floorColor: [0.2, 0.5, 0.8], lampEmission: 9, lampHeight: 2.4 },
  ]);
  assert.deepEqual(frames.map(frame => frame.route.path), ['new-session', 'updated', 'updated', 'updated']);
  assert.deepEqual(frames[1].route.changedTables, ['materials']);
  assert.equal(frames[3].route.accelerationRebuilt, true);
});

cookTest('a sequence that changes its instance count mid-way falls back to a new session and carries on identically', { skip: skipWithoutAddon }, () => {
  const frames = paths([{ }, { eye: [1, 2.2, 6] }, { extraQuad: true }, { extraQuad: true, eye: [2, 2.2, 5] }]);
  assert.deepEqual(frames.map(frame => frame.route.path), ['new-session', 'reused', 'new-session', 'reused']);
  assert.match(frames[2].route.reason, /instanceCount/);
});
