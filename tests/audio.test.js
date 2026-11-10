import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIO_LIMITS,
  createAudio,
  distanceGain,
  markersCrossed,
  OCCLUDED_GAIN_LOSS,
  readListener,
  readNodePosition,
  webAudioBackend,
} from '../src/audio.js';
import { createInput } from '../src/input.js';
import { createRuntime } from '../src/runtime.js';

function createParameter(initial = 0) {
  return {
    value: initial,
    setTargetAtTime(value) {
      this.value = value;
    },
  };
}

function createFakeNode(kind) {
  const node = { kind, connections: [] };
  node.connect = target => {
    node.connections.push(target);
    return target;
  };
  node.disconnect = () => {
    node.connections.length = 0;
  };
  return node;
}

// A recording stand-in for AudioContext: no sound, but every node, connection and parameter value can be inspected.
function createFakeAudioContext() {
  const context = {
    state: 'suspended',
    currentTime: 0,
    nodes: [],
    closed: false,
    listener: {
      positionX: createParameter(), positionY: createParameter(), positionZ: createParameter(),
      forwardX: createParameter(), forwardY: createParameter(), forwardZ: createParameter(),
      upX: createParameter(), upY: createParameter(), upZ: createParameter(),
    },
  };
  context.destination = createFakeNode('destination');
  const track = node => {
    context.nodes.push(node);
    return node;
  };
  context.resume = async () => {
    context.state = 'running';
  };
  context.close = () => {
    context.closed = true;
  };
  context.createGain = () => track(Object.assign(createFakeNode('gain'), { gain: createParameter(1) }));
  context.createDynamicsCompressor = () => track(Object.assign(createFakeNode('limiter'), {
    threshold: createParameter(), knee: createParameter(), ratio: createParameter(), attack: createParameter(), release: createParameter(),
  }));
  context.createBiquadFilter = () => track(Object.assign(createFakeNode('filter'), { frequency: createParameter(), type: '' }));
  context.createPanner = () => track(Object.assign(createFakeNode('panner'), {
    positionX: createParameter(), positionY: createParameter(), positionZ: createParameter(),
  }));
  context.createBufferSource = () => track(Object.assign(createFakeNode('source'), {
    playbackRate: createParameter(1),
    stopped: false,
    start() {},
    stop() {
      this.stopped = true;
    },
    finish() {
      this.onended?.();
    },
  }));
  context.decodeAudioData = async bytes => ({ duration: bytes.byteLength / 1000 });
  return context;
}

function createFakeGestureTarget() {
  const handlers = new Map();
  return {
    addEventListener(type, handler) {
      handlers.set(type, handler);
    },
    removeEventListener(type) {
      handlers.delete(type);
    },
    dispatch(type) {
      handlers.get(type)?.();
    },
    get listenerCount() {
      return handlers.size;
    },
  };
}

const buffer = { duration: 1 };

function createFixture(options = {}) {
  const context = createFakeAudioContext();
  const gestureTarget = createFakeGestureTarget();
  const audio = createAudio({ backend: webAudioBackend({ createContext: () => context, gestureTarget }), ...options });
  audio.init();
  return { audio, context, gestureTarget };
}

function sourcesOf(context) {
  return context.nodes.filter(node => node.kind === 'source');
}

test('the output graph ends in a limiter before the destination, with music, effects and voice buses', () => {
  const { context } = createFixture();
  const limiter = context.nodes.find(node => node.kind === 'limiter');
  assert.deepEqual(limiter.connections, [context.destination]);
  assert.equal(limiter.ratio.value, 20);
  const gains = context.nodes.filter(node => node.kind === 'gain');
  const master = gains.find(node => node.connections.includes(limiter));
  assert.equal(gains.filter(node => node.connections.includes(master)).length, 3);
});

test('the context resumes on the first user gesture and the listeners are then removed', () => {
  const { context, gestureTarget } = createFixture();
  assert.equal(context.state, 'suspended');
  assert.equal(gestureTarget.listenerCount, 3);
  gestureTarget.dispatch('keydown');
  assert.equal(context.state, 'running');
  assert.equal(gestureTarget.listenerCount, 0);
});

test('distanceGain follows the Web Audio models', () => {
  assert.equal(distanceGain(1, { referenceDistance: 1 }), 1);
  assert.equal(distanceGain(10, { referenceDistance: 1, rolloff: 1 }), 0.1);
  assert.equal(distanceGain(0.2, { referenceDistance: 1 }), 1);
  assert.ok(Math.abs(distanceGain(51, { model: 'linear', referenceDistance: 1, maximumDistance: 101, rolloff: 1 }) - 0.5) < 1e-9);
  assert.equal(distanceGain(4, { model: 'exponential', referenceDistance: 1, rolloff: 1 }), 0.25);
  assert.equal(
    distanceGain(500, { referenceDistance: 1, maximumDistance: 100, rolloff: 1 }),
    distanceGain(100, { referenceDistance: 1, maximumDistance: 100, rolloff: 1 }),
  );
});

test('a spatial sound gets quieter with distance from the listener on the camera', () => {
  const { audio } = createFixture();
  audio.defineSound('thud', { buffer, spatial: { referenceDistance: 1 } });
  audio.setListener({ eye: [0, 2, 0], target: [0, 2, -5] });
  const near = audio.play('thud', { position: [0, 2, -1] });
  const far = audio.play('thud', { position: [0, 2, -9] });
  assert.equal(near.level, 1);
  assert.ok(Math.abs(far.level - 1 / 9) < 1e-9, `far level ${far.level}`);
  audio.setListener({ eye: [0, 2, -9], target: [0, 2, -20] });
  audio.synchronize();
  assert.equal(far.level, 1);
});

test('the listener is written to the context from a camera frame', () => {
  const { audio, context } = createFixture();
  audio.setListener({ eye: [1, 2, 3], target: [1, 2, 0] });
  assert.equal(context.listener.positionX.value, 1);
  assert.equal(context.listener.positionZ.value, 3);
  assert.deepEqual([context.listener.forwardX.value, context.listener.forwardY.value, context.listener.forwardZ.value], [0, 0, -1]);
  assert.deepEqual(readListener({ position: [0, 0, 0], forward: [0, 0, 4] }).forward, [0, 0, 1]);
});

test('a listener function follows the camera each frame', () => {
  let eye = [0, 0, 0];
  const { audio, context } = createFixture({ listener: () => ({ eye, target: [eye[0], eye[1], eye[2] - 1] }) });
  audio.synchronize();
  eye = [5, 0, 0];
  audio.synchronize();
  assert.equal(context.listener.positionX.value, 5);
});

test('a sound attached to a node follows it as the node moves', () => {
  const { audio, context } = createFixture();
  audio.defineSound('hum', { buffer, spatial: true });
  const vehicle = { position: [10, 0, 0] };
  const handle = audio.attach(vehicle, 'hum');
  const panner = context.nodes.find(node => node.kind === 'panner');
  assert.equal(panner.positionX.value, 10);
  vehicle.position = [3, 0, 0];
  audio.synchronize();
  assert.equal(panner.positionX.value, 3);
  assert.equal(audio.activeVoices()[0].loop, true);
  handle.stop();
  assert.equal(handle.playing, false);
  assert.equal(sourcesOf(context)[0].stopped, true);
  assert.deepEqual(readNodePosition({ matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1]) }), [4, 5, 6]);
});

test('occlusion lowers the level and the low-pass cutoff', () => {
  let blocked = 0;
  const { audio, context } = createFixture({ occlusion: () => blocked });
  audio.defineSound('shot', { buffer, spatial: { referenceDistance: 1, occlusion: true } });
  audio.defineSound('plain', { buffer, spatial: true });
  const handle = audio.play('shot', { position: [0, 0, -1] });
  assert.equal(handle.level, 1);
  blocked = 1;
  audio.synchronize();
  assert.ok(Math.abs(handle.level - (1 - OCCLUDED_GAIN_LOSS)) < 1e-9);
  const filter = context.nodes.find(node => node.kind === 'filter');
  assert.ok(filter.frequency.value < 500);
  assert.equal(audio.play('plain', { position: [0, 0, -1] }).level, 1);
});

test('contacts fire sounds with the impulse setting the volume, and ended contacts stay silent', () => {
  const { audio } = createFixture();
  audio.defineSound('thud', { buffer, spatial: true });
  audio.bindEvent('contact', 'thud', { volume: data => Math.min(1, data.impulse / 10) });
  audio.emitContacts([
    { started: true, kind: 'contact', colliderA: 'ball', colliderB: 'floor', impulse: 5, position: [0, 0, -1] },
    { started: false, kind: 'contact', colliderA: 'ball', colliderB: 'floor', impulse: 9, position: [0, 0, -1] },
    { started: true, kind: 'contact', colliderA: 'ball', colliderB: 'wall', impulse: 40, position: [0, 0, -1] },
  ]);
  assert.deepEqual(audio.activeVoices().map(voice => voice.level), [0.5, 1]);
});

test('a contact can bind to one collider and takes its position from the options', () => {
  const { audio } = createFixture();
  audio.defineSound('splash', { buffer, spatial: true });
  audio.bindEvent('sensor:pool', 'splash');
  audio.emitContacts([{ started: true, kind: 'sensor', colliderA: 'pool', colliderB: 'ball' }], { position: () => [0, 0, -2] });
  assert.equal(audio.activeVoices().length, 1);
  assert.deepEqual(audio.activeVoices()[0].position, [0, 0, -2]);
});

test('animation markers fire once when the clip time crosses them, including across a loop', () => {
  const markers = [{ time: 0.25, name: 'footstep' }, { time: 0.75, name: 'footstep' }];
  assert.deepEqual(markersCrossed(markers, 0, 0.25).map(marker => marker.time), [0.25]);
  assert.deepEqual(markersCrossed(markers, 0.25, 0.5), []);
  assert.deepEqual(markersCrossed(markers, 0.5, 0.1, { loop: true, duration: 1 }).map(marker => marker.time), [0.75]);
  assert.deepEqual(markersCrossed(markers, 0.8, 0.3, { loop: true, duration: 1 }).map(marker => marker.time), [0.25]);

  const { audio } = createFixture();
  audio.defineSound('step', { buffer, spatial: true });
  audio.bindEvent('marker:footstep', 'step', { position: data => data.foot });
  audio.emitMarkers(markers, 0, 0.5, { data: { foot: [0, 0, -1] } });
  assert.equal(audio.activeVoices().length, 1);
  audio.emitMarkers(markers, 0.5, 1, { data: { foot: [0, 0, -1] } });
  assert.equal(audio.activeVoices().length, 2);
});

test('input actions trigger sounds from the runtime, one per press', () => {
  const input = createInput({ actions: { jump: ['script/jump'] } });
  const { audio } = createFixture({ input });
  audio.defineSound('hop', { buffer });
  audio.bindAction('jump', 'hop', { pitch: 1.5 });
  const runtime = createRuntime({ render() {} }, {
    mode: 'fixed',
    fixedRate: 60,
    systems: [input, audio],
    scheduler: { request: () => 1, cancel() {} },
    clock: () => 0,
    visibility: { hidden: false, subscribe: () => () => {} },
  });
  runtime.start();
  input.press('script/jump');
  runtime.step(17);
  assert.equal(audio.activeVoices().length, 1);
  assert.equal(audio.activeVoices()[0].pitch, 1.5);
  runtime.step(17);
  assert.equal(audio.activeVoices().length, 1, 'a held key does not retrigger');
  runtime.dispose();
});

test('buses scale the measured level and the master bus scales every bus', () => {
  const { audio } = createFixture();
  audio.defineSound('tune', { buffer, bus: 'music', volume: 0.8 });
  audio.defineSound('line', { buffer, bus: 'voice' });
  const tune = audio.play('tune');
  const line = audio.play('line');
  audio.setBusVolume('music', 0.5);
  assert.ok(Math.abs(tune.level - 0.4) < 1e-9);
  assert.equal(line.level, 1);
  audio.setBusVolume('master', 0.5);
  assert.ok(Math.abs(tune.level - 0.2) < 1e-9);
  assert.equal(line.level, 0.5);
  assert.equal(audio.getBusVolume('music'), 0.5);
  assert.throws(() => audio.setBusVolume('nope', 1), /Unknown bus nope/);
});

test('a created bus is routed into the master bus', () => {
  const { audio, context } = createFixture();
  const gainsBefore = context.nodes.filter(node => node.kind === 'gain').length;
  audio.createBus('ui', 0.25);
  assert.equal(context.nodes.filter(node => node.kind === 'gain').length, gainsBefore + 1);
  audio.defineSound('click', { buffer, bus: 'ui' });
  assert.ok(audio.play('click'));
});

test('a sound that finishes leaves the active voices, and the limit keeps the loudest', () => {
  const { audio, context } = createFixture({ maximumVoices: 2 });
  audio.defineSound('tick', { buffer, maximumInstances: 8 });
  audio.play('tick', { volume: 0.5 });
  audio.play('tick', { volume: 0.7 });
  assert.equal(audio.play('tick', { volume: 0.1 }), null, 'a quieter voice does not steal');
  assert.ok(audio.play('tick', { volume: 1 }));
  assert.deepEqual(audio.activeVoices().map(voice => voice.volume).sort(), [0.7, 1]);
  sourcesOf(context).at(-1).finish();
  assert.equal(audio.activeVoices().length, 1);
});

test('maximumInstances stops the oldest copy of a sound', () => {
  const { audio } = createFixture();
  audio.defineSound('clink', { buffer, maximumInstances: 2 });
  const first = audio.play('clink');
  audio.play('clink');
  audio.play('clink');
  assert.equal(first.playing, false);
  assert.equal(audio.activeVoices().length, 2);
});

test('pitch variance is deterministic for the same seed', () => {
  const pitches = seed => {
    const { audio } = createFixture({ seed });
    audio.defineSound('step', { buffer, pitchVariance: 0.2, maximumInstances: 8 });
    for (let index = 0; index < 4; index += 1) audio.play('step');
    return audio.activeVoices().map(voice => voice.pitch);
  };
  assert.deepEqual(pitches(7), pitches(7));
  assert.notDeepEqual(pitches(7), pitches(8));
  assert.ok(pitches(7).every(pitch => pitch >= 0.8 && pitch <= 1.2));
});

test('load decodes an ArrayBuffer into a sound', async () => {
  const { audio } = createFixture();
  const sound = await audio.load('boom', new ArrayBuffer(2000), { bus: 'effects' });
  assert.equal(sound.buffer.duration, 2);
  assert.ok(audio.play('boom'));
  await assert.rejects(() => audio.load('bad', 42), /URL string, an ArrayBuffer or a decoded AudioBuffer/);
});

test('errors name the field and say what to pass', () => {
  const { audio } = createFixture();
  assert.throws(() => audio.defineSound('x', { buffer: {} }), /buffer must be a decoded AudioBuffer/);
  assert.throws(() => audio.defineSound('x', { buffer, bus: 'sfx' }), /Unknown bus sfx/);
  assert.throws(() => audio.defineSound('x', { buffer, spatial: { model: 'cubic' } }), /spatial model must be one of/);
  assert.throws(() => audio.defineSound('x', { buffer, volume: 9 }), /sound x volume/);
  assert.throws(() => audio.play('missing'), /Unknown sound missing/);
  audio.defineSound('s', { buffer, spatial: true });
  assert.throws(() => audio.play('s'), /play it with \{ position/);
  assert.throws(() => audio.play('s', { position: [0, NaN, 0] }), /three finite numbers/);
  assert.throws(() => audio.bindEvent('e', 's', { volume: 'loud' }), /volume must be a number or a function/);
  assert.throws(() => audio.bindAction('jump', 's'), /needs an input/);
  assert.throws(() => audio.createBus('master'), /reserved/);
  assert.throws(() => createAudio({ occlusion: 3 }), /occlusion must be a function/);
  assert.throws(() => readListener(null), /listener must be a camera frame/);
  assert.throws(() => markersCrossed([{ time: 1 }], 0, 2), /marker name/);
});

test('bindings are bounded', () => {
  const { audio } = createFixture();
  audio.defineSound('s', { buffer });
  for (let index = 0; index < AUDIO_LIMITS.maximumBindings; index += 1) audio.bindEvent(`e${index}`, 's');
  assert.throws(() => audio.bindEvent('one-more', 's'), /at most 256 event bindings/);
});

test('dispose stops every voice and closes the context', () => {
  const { audio, context } = createFixture();
  audio.defineSound('loop', { buffer, loop: true });
  audio.play('loop');
  audio.dispose();
  assert.equal(sourcesOf(context)[0].stopped, true);
  assert.equal(context.closed, true);
});

test('a different backend plugs in behind the same calls', () => {
  const calls = [];
  const backend = {
    init: () => calls.push('init'),
    dispose: () => calls.push('dispose'),
    createBus: name => calls.push(`bus:${name}`),
    setBusVolume: name => calls.push(`volume:${name}`),
    setListener: () => calls.push('listener'),
    startVoice: voice => {
      calls.push(`voice:${voice.bus}`);
      return { update() {}, stop() {} };
    },
  };
  const audio = createAudio({ backend });
  audio.defineSound('beep', { buffer, bus: 'voice' });
  audio.play('beep');
  assert.ok(calls.includes('voice:voice'));
  assert.ok(calls.includes('bus:music'));
});

function createActionRuntime(mode, input, audio) {
  return createRuntime({ render() {} }, {
    mode,
    fixedRate: 60,
    systems: [input, audio],
    scheduler: { request: () => 1, cancel() {} },
    clock: () => 0,
    visibility: { hidden: false, subscribe: () => () => {} },
  });
}

for (const mode of ['variable', 'both']) {
  test(`input actions trigger sounds once per press in runtime mode ${mode}`, () => {
    const input = createInput({ actions: { jump: ['script/jump'] } });
    const { audio } = createFixture({ input });
    audio.defineSound('hop', { buffer });
    audio.bindAction('jump', 'hop');
    const runtime = createActionRuntime(mode, input, audio);
    runtime.start();
    input.press('script/jump');
    runtime.step(17);
    assert.equal(audio.activeVoices().length, 1);
    runtime.step(17);
    assert.equal(audio.activeVoices().length, 1, 'a held key does not retrigger');
    runtime.dispose();
  });
}

test('a node that starts returning null stops its voice without throwing, and the others keep playing', () => {
  const { audio } = createFixture();
  audio.defineSound('hum', { buffer, spatial: true });
  let position = [1, 0, 0];
  const dying = audio.attach(() => position, 'hum');
  const steady = audio.attach({ position: [2, 0, 0] }, 'hum');
  position = null;
  assert.doesNotThrow(() => audio.synchronize());
  assert.equal(dying.playing, false);
  assert.equal(steady.playing, true);
});

test('a bad occlusion result in a frame update is clamped, while play keeps the strict check', () => {
  let blocked = 0;
  const { audio } = createFixture({ occlusion: () => blocked });
  audio.defineSound('shot', { buffer, spatial: { occlusion: true } });
  const handle = audio.play('shot', { position: [0, 0, -1] });
  blocked = 5;
  assert.doesNotThrow(() => audio.synchronize());
  assert.ok(Math.abs(handle.level - (1 - OCCLUDED_GAIN_LOSS)) < 1e-9, 'a value above 1 clamps to 1');
  blocked = Number.NaN;
  assert.doesNotThrow(() => audio.synchronize());
  assert.equal(handle.level, 1, 'NaN reads as open');
  assert.throws(() => audio.play('shot', { position: [0, 0, -1] }), /occlusion function result/);
});

test('a linear rolloff above 1 is rejected, other models keep up to 20, and gain never goes negative', () => {
  const { audio } = createFixture();
  assert.throws(() => audio.defineSound('far', { buffer, spatial: { model: 'linear', rolloff: 2 } }), /rolloff/);
  assert.doesNotThrow(() => audio.defineSound('wide', { buffer, spatial: { model: 'inverse', rolloff: 5 } }));
  assert.equal(distanceGain(1000, { model: 'linear', rolloff: 1, referenceDistance: 1, maximumDistance: 50 }), 0);
  assert.equal(distanceGain(1000, { model: 'linear', rolloff: 5, referenceDistance: 1, maximumDistance: 50 }), 0);
});
