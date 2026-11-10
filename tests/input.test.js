import assert from 'node:assert/strict';
import test from 'node:test';
import { createInput, gamepadSource, INPUT_LIMITS, keyboardSource, mouseSource } from '../src/input.js';
import { createRuntime } from '../src/runtime.js';

function createFakeTarget() {
  const listeners = new Map();
  return {
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

function startedInput(options) {
  const input = createInput(options);
  input.init();
  return input;
}

function edges(input, name) {
  return [input.isHeld(name), input.wasPressed(name), input.wasReleased(name)];
}

test('keyboard events map to a named action with pressed, held and released edges across fixed steps', () => {
  const target = createFakeTarget();
  const input = startedInput({ sources: [keyboardSource({ target, blurTarget: createFakeTarget() })], actions: { jump: ['keyboard/Space'] } });

  input.fixedUpdate();
  assert.deepEqual(edges(input, 'jump'), [false, false, false]);

  target.dispatch('keydown', { code: 'Space' });
  assert.equal(input.isHeld('jump'), false, 'live events do not change the snapshot before sampling');
  input.fixedUpdate();
  assert.deepEqual(edges(input, 'jump'), [true, true, false]);

  input.fixedUpdate();
  assert.deepEqual(edges(input, 'jump'), [true, false, false]);

  target.dispatch('keydown', { code: 'Space', repeat: true });
  target.dispatch('keyup', { code: 'Space' });
  input.fixedUpdate();
  assert.deepEqual(edges(input, 'jump'), [false, false, true]);
});

test('a tap between two samples still reports pressed and released', () => {
  const target = createFakeTarget();
  const input = startedInput({ sources: [keyboardSource({ target, blurTarget: createFakeTarget() })], actions: { fire: ['keyboard/KeyF'] } });
  target.dispatch('keydown', { code: 'KeyF' });
  target.dispatch('keyup', { code: 'KeyF' });
  input.fixedUpdate();
  assert.deepEqual(edges(input, 'fire'), [false, true, true]);
});

test('axes combine keys and a gamepad stick, with a dead zone and rebinding', () => {
  const target = createFakeTarget();
  const pad = { index: 0, buttons: [{ pressed: false, value: 0 }], axes: [0.05] };
  const input = startedInput({
    sources: [keyboardSource({ target, blurTarget: createFakeTarget() }), gamepadSource({ getGamepads: () => [pad] })],
    axes: { moveX: { bindings: ['keyboard/KeyD', { control: 'keyboard/KeyA', scale: -1 }, 'gamepad/0.axis0'], deadZone: 0.1 } },
  });
  input.fixedUpdate();
  assert.equal(input.getAxis('moveX'), 0, 'stick drift inside the dead zone reads as zero');

  pad.axes[0] = 1;
  input.fixedUpdate();
  assert.equal(input.getAxis('moveX'), 1);

  pad.axes[0] = 0;
  target.dispatch('keydown', { code: 'KeyA' });
  input.fixedUpdate();
  assert.equal(input.getAxis('moveX'), -1);

  input.bindAxis('moveX', ['keyboard/KeyA']);
  input.fixedUpdate();
  assert.equal(input.getAxis('moveX'), 1, 'rebinding replaces the old mapping');
});

test('a gamepad button drives an action and an unplugged pad releases it', () => {
  const pad = { index: 0, buttons: [{ pressed: true, value: 1 }], axes: [] };
  let pads = [pad];
  const input = startedInput({ sources: [gamepadSource({ getGamepads: () => pads })], actions: { jump: ['gamepad/0.button0'] } });
  input.fixedUpdate();
  assert.equal(input.wasPressed('jump'), true);
  pads = [null];
  input.fixedUpdate();
  assert.deepEqual([input.isHeld('jump'), input.wasReleased('jump')], [false, true]);
});

test('mouse buttons and movement deltas are sampled and then cleared', () => {
  const target = createFakeTarget();
  const input = startedInput({
    sources: [mouseSource({ target, blurTarget: createFakeTarget() })],
    actions: { shoot: ['mouse/button0'] },
    axes: { lookX: { bindings: [{ control: 'mouse/deltaX', scale: 0.1 }], deadZone: 0 } },
  });
  target.dispatch('pointerdown', { button: 0 });
  target.dispatch('pointermove', { clientX: 10, clientY: 20, movementX: 4, movementY: 0 });
  target.dispatch('pointermove', { clientX: 14, clientY: 20, movementX: 4, movementY: 0 });
  input.fixedUpdate();
  assert.equal(input.wasPressed('shoot'), true);
  assert.ok(Math.abs(input.getAxis('lookX') - 0.8) < 1e-9);
  input.fixedUpdate();
  assert.equal(input.getAxis('lookX'), 0);
});

test('a custom source registers from game code and emits named values', () => {
  let emitter = null;
  let disposed = false;
  const midi = {
    name: 'midi',
    attach(emit) { emitter = emit; },
    dispose() { disposed = true; },
  };
  const input = createInput();
  input.registerSource(midi).bindAction('note', ['midi/note60']);
  assert.equal(emitter, null, 'sources attach when the runtime initialises the input');
  input.init();
  emitter('note60', 1);
  input.sample();
  assert.equal(input.wasPressed('note'), true);
  assert.deepEqual(input.sources, ['midi']);
  input.unregisterSource('midi');
  assert.equal(disposed, true);
  assert.deepEqual(input.sources, []);
});

test('programmatic input drives actions the same way as a device', () => {
  const input = startedInput({ actions: { start: ['script/start'] } });
  input.press('script/start');
  input.sample();
  assert.equal(input.wasPressed('start'), true);
  input.release('script/start');
  input.sample();
  assert.equal(input.wasReleased('start'), true);
});

test('focus loss releases held keys', () => {
  const target = createFakeTarget();
  const blurTarget = createFakeTarget();
  const input = startedInput({ sources: [keyboardSource({ target, blurTarget })], actions: { run: ['keyboard/ShiftLeft'] } });
  target.dispatch('keydown', { code: 'ShiftLeft' });
  input.sample();
  assert.equal(input.isHeld('run'), true);
  blurTarget.dispatch('blur');
  input.sample();
  assert.deepEqual([input.isHeld('run'), input.wasReleased('run')], [false, true]);
});

test('dispose removes every listener and the input rejects further use', () => {
  const target = createFakeTarget();
  const blurTarget = createFakeTarget();
  const input = startedInput({ sources: [keyboardSource({ target, blurTarget }), mouseSource({ target, blurTarget })] });
  assert.ok(target.listenerCount() > 0);
  input.dispose();
  assert.equal(target.listenerCount(), 0);
  assert.equal(blurTarget.listenerCount(), 0);
  assert.throws(() => input.sample(), /disposed/);
});

test('the input is a runtime system that samples once per fixed step', () => {
  const target = createFakeTarget();
  const input = createInput({ sources: [keyboardSource({ target, blurTarget: createFakeTarget() })], actions: { jump: ['keyboard/Space'] } });
  const seen = [];
  const game = { name: 'game', fixedUpdate: () => seen.push(input.wasPressed('jump')) };
  const runtime = createRuntime({ render() {} }, {
    mode: 'fixed',
    fixedRate: 100,
    systems: [input, game],
    
    scheduler: { request: () => 1, cancel() {} },
    visibility: { hidden: false, subscribe: () => () => {} },
  });
  runtime.start();
  target.dispatch('keydown', { code: 'Space' });
  runtime.step(35);
  assert.deepEqual(seen, [true, false, false], 'three steps in one frame share one edge');
  runtime.dispose();
  assert.equal(target.listenerCount(), 0);
});

test('errors name the field and the fix', () => {
  const input = createInput();
  assert.throws(() => input.registerSource({}), /source name must be a non-empty string/);
  assert.throws(() => input.registerSource({ name: 'a/b' }), /must not contain "\/"/);
  assert.throws(() => input.bindAction('x', []), /Action "x" bindings must be an array of 1 to 16/);
  assert.throws(() => input.bindAxis('x', { bindings: ['a/b'], deadZone: 1 }), /deadZone/);
  assert.throws(() => input.isHeld('missing'), /No action named "missing".*bindAction/);
  assert.throws(() => input.setControl('a/b', Number.NaN), /finite number/);
  assert.throws(() => createInput({ buttonThreshold: 0 }), /buttonThreshold/);
  assert.throws(() => keyboardSource({ target: {} }).attach(() => {}), /keyboardSource target/);
});

test('counts are bounded', () => {
  const input = createInput();
  for (let index = 0; index < INPUT_LIMITS.maximumSources; index += 1) input.registerSource({ name: `s${index}` });
  assert.throws(() => input.registerSource({ name: 'extra' }), /already has 16 sources/);
  for (let index = 0; index < INPUT_LIMITS.maximumControls; index += 1) input.setControl(`s0/c${index}`, 1);
  assert.throws(() => input.setControl('s0/overflow', 1), /already has 512 controls/);
  const actions = createInput();
  for (let index = 0; index < INPUT_LIMITS.maximumActions; index += 1) actions.bindAction(`a${index}`, ['s/x']);
  assert.throws(() => actions.bindAction('extra', ['s/x']), /already has 128 actions/);
});
