import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createInput,
  deviceMotionSource,
  gamepadSource,
  keyboardSource,
  mouseSource,
  recordInput,
  replaySource,
  touchSource,
} from '../src/input.js';

function createFakeTarget(size = { width: 800, height: 400 }) {
  const listeners = new Map();
  return {
    innerWidth: size.width,
    innerHeight: size.height,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatch(type, event = {}) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
    },
    listenerCount() {
      let count = 0;
      for (const set of listeners.values()) count += set.size;
      return count;
    },
  };
}

const leftStick = { name: 'left', area: { x: 0, y: 0, width: 0.5, height: 1 }, radius: 100 };

function touchInput(extra = {}) {
  const target = createFakeTarget();
  const blurTarget = createFakeTarget();
  const input = createInput({
    sources: [touchSource({ target, blurTarget, sticks: [leftStick], ...extra })],
    actions: { tap: ['touch/tap'], swipeRight: ['touch/swipeRight'], swipeUp: ['touch/swipeUp'] },
    axes: {
      moveX: { bindings: ['touch/leftX'], deadZone: 0 },
      moveY: { bindings: ['touch/leftY'], deadZone: 0 },
      zoom: { bindings: ['touch/pinch'], deadZone: 0 },
    },
  });
  input.init();
  return { target, blurTarget, input };
}

function touch(pointerId, clientX, clientY, timeStamp = 0) {
  return { pointerType: 'touch', pointerId, clientX, clientY, timeStamp };
}

test('a touch stick reads from where the finger first landed and releases on lift', () => {
  const { target, input } = touchInput();
  target.dispatch('pointerdown', touch(1, 100, 200));
  target.dispatch('pointermove', touch(1, 150, 100));
  input.sample();
  assert.equal(input.getAxis('moveX'), 0.5);
  assert.equal(input.getAxis('moveY'), -1);

  target.dispatch('pointermove', touch(1, 900, 200));
  input.sample();
  assert.equal(input.getAxis('moveX'), 1, 'clamped to the radius');

  target.dispatch('pointerup', touch(1, 900, 200));
  input.sample();
  assert.equal(input.getAxis('moveX'), 0);
});

test('mouse and pen pointers do not drive touch', () => {
  const { target, input } = touchInput();
  target.dispatch('pointerdown', { pointerType: 'mouse', pointerId: 1, clientX: 100, clientY: 200 });
  target.dispatch('pointermove', { pointerType: 'mouse', pointerId: 1, clientX: 180, clientY: 200 });
  input.sample();
  assert.equal(input.getAxis('moveX'), 0);
});

test('a touch outside the stick area is a gesture: tap and swipes pulse for one sample', () => {
  const { target, input } = touchInput();
  target.dispatch('pointerdown', touch(2, 600, 200, 1000));
  target.dispatch('pointerup', touch(2, 602, 200, 1100));
  input.sample();
  assert.equal(input.wasPressed('tap'), true);
  input.sample();
  assert.equal(input.wasPressed('tap'), false);
  assert.equal(input.isHeld('tap'), false);

  target.dispatch('pointerdown', touch(3, 500, 300, 2000));
  target.dispatch('pointermove', touch(3, 600, 300, 2100));
  target.dispatch('pointerup', touch(3, 650, 300, 2150));
  input.sample();
  assert.equal(input.wasPressed('swipeRight'), true);
  assert.equal(input.wasPressed('tap'), false);

  target.dispatch('pointerdown', touch(4, 500, 350, 3000));
  target.dispatch('pointerup', touch(4, 500, 250, 3100));
  input.sample();
  assert.equal(input.wasPressed('swipeUp'), true);
});

test('a slow drag is neither a tap nor a swipe', () => {
  const { target, input } = touchInput();
  target.dispatch('pointerdown', touch(5, 500, 300, 0));
  target.dispatch('pointerup', touch(5, 700, 300, 2000));
  input.sample();
  assert.equal(input.wasPressed('tap'), false);
  assert.equal(input.wasPressed('swipeRight'), false);
});

test('two gesture touches spreading apart report a pinch that clears each sample', () => {
  const { target, input } = touchInput();
  target.dispatch('pointerdown', touch(6, 500, 200));
  target.dispatch('pointerdown', touch(7, 600, 200));
  target.dispatch('pointermove', touch(7, 700, 200));
  input.sample();
  assert.equal(input.getAxis('zoom'), 1, 'distance went 100 to 200');
  input.sample();
  assert.equal(input.getAxis('zoom'), 0);
});

test('a second finger inside a held stick area becomes a gesture touch, and blur releases everything', () => {
  const { target, blurTarget, input } = touchInput();
  target.dispatch('pointerdown', touch(1, 100, 200));
  target.dispatch('pointermove', touch(1, 200, 200));
  target.dispatch('pointerdown', touch(2, 120, 220));
  input.sample();
  assert.equal(input.getAxis('moveX'), 1);
  blurTarget.dispatch('blur');
  input.sample();
  assert.equal(input.getAxis('moveX'), 0);
});

test('touch source options and removal are validated', () => {
  assert.throws(() => touchSource({ sticks: [{ name: 'left' }] }), /area needs numbers x, y, width and height/);
  assert.throws(() => touchSource({ sticks: [{ ...leftStick, radius: 0 }] }), /radius must be a number above 0/);
  assert.throws(() => touchSource({ sticks: Array.from({ length: 5 }, (_, index) => ({ ...leftStick, name: `s${index}` })) }), /up to 4 sticks/);
  const { target, input } = touchInput();
  assert.ok(target.listenerCount() > 0);
  input.dispose();
  assert.equal(target.listenerCount(), 0);
});

test('device motion reports tilt and raw sensors, ignoring missing values', () => {
  const target = createFakeTarget();
  const input = createInput({
    sources: [deviceMotionSource({ target })],
    axes: { steer: { bindings: ['motion/tiltX'], deadZone: 0 }, pitch: { bindings: ['motion/tiltY'], deadZone: 0 } },
    actions: { shake: ['motion/accelX'] },
  });
  input.init();
  target.dispatch('deviceorientation', { alpha: 10, beta: -90, gamma: 22.5 });
  target.dispatch('devicemotion', { accelerationIncludingGravity: { x: 3, y: null, z: 9.8 }, rotationRate: {} });
  input.sample();
  assert.equal(input.getAxis('steer'), 0.5);
  assert.equal(input.getAxis('pitch'), -1, 'clamped');
  assert.equal(input.isHeld('shake'), true);
  input.dispose();
  assert.equal(target.listenerCount(), 0);
});

test('axis smoothing eases toward the target each sample and is validated', () => {
  const target = createFakeTarget();
  const input = createInput({
    sources: [keyboardSource({ target, blurTarget: createFakeTarget() })],
    axes: { moveX: { bindings: ['keyboard/KeyD'], deadZone: 0, smoothing: 0.5 } },
  });
  input.init();
  target.dispatch('keydown', { code: 'KeyD' });
  const readings = [];
  for (let step = 0; step < 3; step += 1) {
    input.sample();
    readings.push(input.getAxis('moveX'));
  }
  assert.deepEqual(readings, [0.5, 0.75, 0.875]);
  target.dispatch('keyup', { code: 'KeyD' });
  input.sample();
  assert.equal(input.getAxis('moveX'), 0.4375);
  assert.throws(() => input.bindAxis('bad', { bindings: ['keyboard/KeyA'], smoothing: 1 }), /smoothing must be a number from 0/);
});

// One tiny game, driven only through named actions and axes.
function playDemo(input, steps) {
  const state = { x: 0, jumps: 0 };
  for (let step = 0; step < steps; step += 1) {
    input.fixedUpdate();
    state.x += input.getAxis('moveX');
    if (input.wasPressed('jump')) state.jumps += 1;
  }
  return state;
}

const demoBindings = {
  actions: { jump: ['keyboard/Space', 'gamepad/0.button0', 'touch/tap'] },
  axes: {
    moveX: { bindings: ['keyboard/KeyD', 'gamepad/0.axis0', 'touch/leftX'], deadZone: 0 },
  },
};

const demoSteps = 3;

function recordedDemo(createSources, perform) {
  const input = createInput({ sources: createSources(), ...demoBindings });
  input.init();
  const recorder = recordInput(input);
  perform();
  const played = playDemo(input, demoSteps);
  return { played, recording: JSON.parse(JSON.stringify(recorder.stop())) };
}

test('the same demo plays from keyboard, gamepad, touch and a scripted replay of keyboard or touch', () => {
  const keyboardTarget = createFakeTarget();
  const keyboard = recordedDemo(
    () => [keyboardSource({ target: keyboardTarget, blurTarget: createFakeTarget() })],
    () => {
      keyboardTarget.dispatch('keydown', { code: 'KeyD' });
      keyboardTarget.dispatch('keydown', { code: 'Space' });
      keyboardTarget.dispatch('keyup', { code: 'Space' }); // pressed and released inside one sample
    },
  );

  const pad = { index: 0, buttons: [{ pressed: true, value: 1 }], axes: [1] };
  const gamepadInput = createInput({ sources: [gamepadSource({ getGamepads: () => [pad] })], ...demoBindings });
  gamepadInput.init();
  const fromGamepad = playDemo(gamepadInput, demoSteps);

  const touchTarget = createFakeTarget();
  const fromTouch = recordedDemo(
    () => [touchSource({ target: touchTarget, blurTarget: createFakeTarget(), sticks: [leftStick] })],
    () => {
      touchTarget.dispatch('pointerdown', touch(1, 100, 200));
      touchTarget.dispatch('pointermove', touch(1, 200, 200));
      touchTarget.dispatch('pointerdown', touch(2, 600, 200, 1000));
      touchTarget.dispatch('pointerup', touch(2, 602, 200, 1100));
    },
  );

  const expected = { x: 3, jumps: 1 };
  assert.deepEqual(keyboard.played, expected);
  assert.deepEqual(fromGamepad, expected);
  assert.deepEqual(fromTouch.played, expected);

  for (const live of [keyboard, fromTouch]) {
    const replayInput = createInput({ sources: [replaySource(live.recording)], ...demoBindings });
    replayInput.init();
    assert.deepEqual(playDemo(replayInput, demoSteps), live.played);
  }
});

const parityBindings = {
  actions: { tap: ['touch/tap'], swipeRight: ['touch/swipeRight'], shoot: ['mouse/button0'] },
  axes: {
    zoom: { bindings: ['touch/pinch'], deadZone: 0 },
    moveX: { bindings: ['touch/leftX'], deadZone: 0 },
    lookX: { bindings: ['mouse/deltaX'], deadZone: 0 },
  },
};

function snapshotOf(input) {
  return {
    actions: Object.keys(parityBindings.actions).map(name => [input.isHeld(name), input.wasPressed(name), input.wasReleased(name)]),
    axes: Object.keys(parityBindings.axes).map(name => input.getAxis(name)),
  };
}

test('replay reproduces what the game saw at every sample, including pulses that sources reset after a sample', () => {
  const touchTarget = createFakeTarget();
  const mouseTarget = createFakeTarget();
  const live = createInput({
    sources: [
      touchSource({ target: touchTarget, blurTarget: createFakeTarget(), sticks: [leftStick] }),
      mouseSource({ target: mouseTarget, blurTarget: createFakeTarget() }),
    ],
    ...parityBindings,
  });
  live.init();
  const recorder = recordInput(live);
  const script = [
    () => {
      touchTarget.dispatch('pointerdown', touch(2, 600, 200, 1000));
      touchTarget.dispatch('pointerup', touch(2, 602, 200, 1100));
    },
    () => {},
    () => {
      touchTarget.dispatch('pointerdown', touch(3, 500, 300, 2000));
      touchTarget.dispatch('pointermove', touch(3, 600, 300, 2100));
      touchTarget.dispatch('pointerup', touch(3, 650, 300, 2150));
      mouseTarget.dispatch('pointerdown', { button: 0 });
      mouseTarget.dispatch('pointermove', { clientX: 10, clientY: 20, movementX: 4, movementY: 0 });
    },
    () => {
      touchTarget.dispatch('pointerdown', touch(6, 500, 200));
      touchTarget.dispatch('pointerdown', touch(7, 600, 200));
      touchTarget.dispatch('pointermove', touch(7, 700, 200));
      mouseTarget.dispatch('pointerup', { button: 0 });
    },
    () => {
      touchTarget.dispatch('pointerdown', touch(1, 100, 200));
      touchTarget.dispatch('pointermove', touch(1, 200, 200));
    },
    () => {},
    () => {},
  ];
  const liveSnapshots = [];
  for (const act of script) {
    act();
    live.sample();
    liveSnapshots.push(snapshotOf(live));
  }
  const recording = JSON.parse(JSON.stringify(recorder.stop()));
  assert.equal(liveSnapshots[0].actions[0][1], true, 'the tap pressed in sample 0');
  assert.equal(liveSnapshots[3].axes[0], 1, 'the pinch read 1 in sample 3');

  const replayInput = createInput({ sources: [replaySource(recording)], ...parityBindings });
  replayInput.init();
  const replaySnapshots = script.map(() => {
    replayInput.sample();
    return snapshotOf(replayInput);
  });
  assert.deepEqual(replaySnapshots, liveSnapshots);
});

test('a source reset after a sample is logged under the next sample number', () => {
  const target = createFakeTarget();
  const tapping = createInput({ sources: [touchSource({ target, blurTarget: createFakeTarget() })] });
  tapping.init();
  const tapRecorder = recordInput(tapping);
  target.dispatch('pointerdown', touch(2, 600, 200, 1000));
  target.dispatch('pointerup', touch(2, 602, 200, 1100));
  tapping.sample();
  tapping.sample();
  assert.deepEqual(tapRecorder.stop().events, [[0, 'touch/tap', 1], [1, 'touch/tap', 0]]);
});

test('unregistering a replay releases and frees the controls it wrote, and only replays may write foreign controls', () => {
  const recording = { version: 1, samples: 5, truncated: false, events: [[0, 'keyboard/KeyW', 1]] };
  const input = createInput({ sources: [replaySource(recording)], actions: { forward: ['keyboard/KeyW'] } });
  input.init();
  input.sample();
  assert.equal(input.isHeld('forward'), true);
  input.unregisterSource('replay');
  input.sample();
  assert.equal(input.isHeld('forward'), false, 'released');

  let seenEmit = null;
  const plain = createInput({ sources: [{ name: 'plain', attach(emit) { seenEmit = emit; } }] });
  plain.init();
  assert.equal(seenEmit.control, undefined, 'a plain source cannot write another source\'s controls');
});

test('a recording must name controls as source/name and touch a bounded number of them', () => {
  assert.throws(() => replaySource({ version: 1, samples: 1, events: [[0, 'nosource', 1]] }), /Recording event 0 must be/);
  assert.throws(() => replaySource({ version: 1, samples: 1, events: [[0, '/name', 1]] }), /Recording event 0 must be/);
  const many = Array.from({ length: 129 }, (_, index) => [0, `script/c${index}`, 1]);
  assert.throws(() => replaySource({ version: 1, samples: 1, events: many }), /up to 128 distinct controls/);
});

test('replay releases what it held when the recording ends, can loop, and rejects bad recordings', () => {
  const recording = { version: 1, samples: 2, truncated: false, events: [[0, 'script/go', 1], [1, 'script/go', 0]] };
  const source = replaySource(recording);
  const input = createInput({ sources: [source], actions: { go: ['script/go'] } });
  input.init();
  input.sample();
  assert.equal(input.isHeld('go'), true);
  input.sample();
  assert.equal(input.isHeld('go'), false);
  assert.equal(source.finished, false);
  input.sample();
  assert.equal(source.finished, true);

  const heldForever = replaySource({ version: 1, samples: 1, events: [[0, 'script/go', 1]] });
  const heldInput = createInput({ sources: [heldForever], actions: { go: ['script/go'] } });
  heldInput.init();
  heldInput.sample();
  assert.equal(heldInput.isHeld('go'), true);
  heldInput.sample();
  assert.equal(heldInput.isHeld('go'), false, 'released at the end');

  const looping = replaySource(recording, { loop: true });
  const loopInput = createInput({ sources: [looping], actions: { go: ['script/go'] } });
  loopInput.init();
  const held = [];
  for (let step = 0; step < 6; step += 1) {
    loopInput.sample();
    held.push(loopInput.isHeld('go'));
  }
  assert.deepEqual(held, [true, false, false, true, false, false]);

  assert.throws(() => replaySource({}), /needs a recording from recordInput/);
  assert.throws(() => replaySource({ version: 1, samples: 1, events: [[0, 'a/b', 'x']] }), /Recording event 0 must be/);
  assert.throws(() => replaySource({ version: 1, samples: 2, events: [[1, 'a/b', 1], [0, 'a/b', 0]] }), /do not go down/);
  assert.throws(() => recordInput({}), /needs an input made by createInput/);
});

test('recording stops logging after stop and truncates past the event limit', () => {
  const input = createInput({});
  const recorder = recordInput(input);
  input.press('script/a');
  input.sample();
  const first = recorder.stop();
  input.release('script/a');
  assert.deepEqual(first.events, [[0, 'script/a', 1]]);
  assert.equal(first.samples, 1);
  assert.equal(first.truncated, false);
  assert.throws(() => input.onControlChange('nope'), /onControlChange needs a function/);

  const busy = recordInput(input);
  for (let index = 0; index < 100001; index += 1) input.setControl('script/n', index % 2);
  assert.equal(busy.stop().truncated, true);
});
