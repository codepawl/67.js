import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime, RUNTIME_LIMITS } from '../src/runtime.js';

// A manual clock and frame scheduler: one frame runs only when the test calls frame(milliseconds).
function createHarness(options = {}) {
  let time = 1000;
  let pending = null;
  let nextHandle = 1;
  const visibilityCallbacks = new Set();
  const visibility = {
    hidden: false,
    subscribe(callback) {
      visibilityCallbacks.add(callback);
      return () => visibilityCallbacks.delete(callback);
    },
  };
  const scheduler = {
    request(callback) {
      pending = { callback, handle: nextHandle };
      nextHandle += 1;
      return pending.handle;
    },
    cancel(handle) {
      if (pending?.handle === handle) pending = null;
    },
  };
  const rendered = [];
  const target = { render: frame => rendered.push(frame) };
  const runtime = createRuntime(target, { scheduler, clock: () => time, visibility, ...options });
  return {
    runtime,
    rendered,
    visibility,
    hasPendingFrame: () => pending !== null,
    frame(milliseconds) {
      time += milliseconds;
      const { callback } = pending;
      pending = null;
      callback();
    },
    setHidden(hidden) {
      visibility.hidden = hidden;
      for (const callback of visibilityCallbacks) callback();
    },
  };
}

function recorder(name, log) {
  return {
    name,
    init: () => log.push(`${name}:init`),
    fixedUpdate: step => log.push(`${name}:fixed:${step.toFixed(4)}`),
    update: delta => log.push(`${name}:update:${delta.toFixed(4)}`),
    dispose: () => log.push(`${name}:dispose`),
  };
}

const countOf = (log, kind) => log.filter(line => line.includes(`:${kind}:`)).length;

test('fixed mode accumulates leftover time between frames', () => {
  const log = [];
  const harness = createHarness({ mode: 'fixed', fixedRate: 100, systems: [recorder('a', log)] });
  harness.runtime.start();
  harness.frame(0);
  harness.frame(25);
  assert.equal(countOf(log, 'fixed'), 2);
  harness.frame(5);
  assert.equal(countOf(log, 'fixed'), 3);
  assert.equal(countOf(log, 'update'), 0);
  assert.equal(harness.runtime.stats.fixedSteps, 3);
  assert.equal(harness.rendered.length, 3);
});

test('variable mode calls update with the frame time and no fixed update', () => {
  const log = [];
  const harness = createHarness({ mode: 'variable', systems: [recorder('a', log)] });
  harness.runtime.start();
  harness.frame(0);
  harness.frame(20);
  harness.frame(10);
  assert.deepEqual(log.filter(line => line.includes(':update:')), ['a:update:0.0000', 'a:update:0.0200', 'a:update:0.0100']);
  assert.equal(countOf(log, 'fixed'), 0);
  assert.equal(harness.runtime.stats.alpha, 1);
});

test('both mode renders with the interpolation alpha of the leftover step', () => {
  const alphas = [];
  const harness = createHarness({
    mode: 'both',
    fixedStepSeconds: 0.01,
    frame: context => {
      alphas.push(context.alpha);
      return {};
    },
  });
  harness.runtime.start();
  harness.frame(0);
  harness.frame(25);
  harness.frame(10);
  assert.equal(alphas[0], 0);
  assert.ok(Math.abs(alphas[1] - 0.5) < 1e-9);
  assert.ok(Math.abs(alphas[2] - 0.5) < 1e-9);
});

test('a long frame is clamped and the step count is capped', () => {
  const log = [];
  const harness = createHarness({ mode: 'fixed', fixedStepSeconds: 0.01, maximumFrameSeconds: 1, maximumStepsPerFrame: 5, systems: [recorder('a', log)] });
  harness.runtime.start();
  harness.frame(0);
  harness.frame(60000);
  assert.equal(harness.runtime.stats.lastFixedSteps, 5);
  assert.ok(harness.runtime.stats.droppedSeconds > 0.9);
  harness.frame(10);
  assert.equal(harness.runtime.stats.lastFixedSteps, 1);
});

test('systems run in order and dispose in reverse', () => {
  const log = [];
  const harness = createHarness({ mode: 'both', fixedStepSeconds: 0.01, systems: [recorder('first', log), recorder('second', log)] });
  harness.runtime.start();
  harness.frame(0);
  harness.frame(10);
  assert.deepEqual(log.slice(0, 2), ['first:init', 'second:init']);
  const fixedRun = log.filter(line => line.includes(':fixed:'));
  assert.deepEqual(fixedRun.map(line => line.split(':')[0]), ['first', 'second']);
  assert.ok(log.indexOf('first:update:0.0100') < log.indexOf('second:update:0.0100'));
  harness.runtime.dispose();
  assert.deepEqual(log.slice(-2), ['second:dispose', 'first:dispose']);
});

test('systems can be left out, inserted, swapped and removed', () => {
  const log = [];
  const harness = createHarness({ mode: 'variable', systems: [{ name: 'game', update: () => log.push('game') }] });
  harness.runtime.start();
  harness.runtime.addSystem({ name: 'input', update: () => log.push('input') }, 0);
  assert.deepEqual(harness.runtime.systems, ['input', 'game']);
  harness.frame(0);
  assert.deepEqual(log, ['input', 'game']);
  const events = [];
  harness.runtime.replaceSystem('game', { name: 'game', update: () => log.push('game2'), init: () => events.push('init2') });
  assert.deepEqual(events, ['init2']);
  harness.frame(10);
  assert.deepEqual(log.slice(2), ['input', 'game2']);
  harness.runtime.removeSystem('input');
  assert.deepEqual(harness.runtime.systems, ['game']);
  assert.throws(() => harness.runtime.removeSystem('input'), /No runtime system named "input"/);
  assert.throws(() => harness.runtime.addSystem({ name: 'game' }), /already exists/);
});

test('pause holds the loop and resume does not simulate the paused time', () => {
  const log = [];
  const harness = createHarness({ mode: 'variable', systems: [recorder('a', log)] });
  harness.runtime.start();
  harness.frame(0);
  harness.runtime.pause();
  assert.equal(harness.hasPendingFrame(), false);
  assert.equal(harness.runtime.paused, true);
  harness.runtime.resume();
  assert.equal(harness.hasPendingFrame(), true);
  harness.frame(5000);
  assert.equal(log.at(-1), 'a:update:0.0000');
  assert.equal(harness.runtime.running, true);
});

test('a hidden tab pauses the loop and a visible tab resumes it', () => {
  const harness = createHarness({ mode: 'variable' });
  harness.runtime.start();
  harness.frame(0);
  harness.setHidden(true);
  assert.equal(harness.hasPendingFrame(), false);
  harness.setHidden(false);
  assert.equal(harness.hasPendingFrame(), true);
  harness.frame(9000);
  assert.equal(harness.runtime.stats.elapsedSeconds, 0);
});

test('pauseWhenHidden false keeps running in a hidden tab', () => {
  const harness = createHarness({ mode: 'variable', pauseWhenHidden: false });
  harness.runtime.start();
  harness.setHidden(true);
  harness.frame(0);
  assert.equal(harness.hasPendingFrame(), true);
});

test('stop cancels the frame, keeps systems initialised and start resumes', () => {
  const log = [];
  const harness = createHarness({ mode: 'variable', systems: [recorder('a', log)] });
  harness.runtime.start();
  harness.frame(0);
  harness.runtime.stop();
  assert.equal(harness.hasPendingFrame(), false);
  assert.equal(harness.runtime.running, false);
  harness.runtime.start();
  assert.equal(log.filter(line => line === 'a:init').length, 1);
  assert.equal(log.includes('a:dispose'), false);
  assert.equal(harness.hasPendingFrame(), true);
});

test('stats report frame time, average and the update and render split', () => {
  const harness = createHarness({ mode: 'variable' });
  harness.runtime.start();
  harness.frame(0);
  harness.frame(16);
  harness.frame(20);
  const stats = harness.runtime.stats;
  assert.equal(stats.frames, 3);
  assert.equal(stats.frameMilliseconds, 20);
  assert.equal(stats.averageFrameMilliseconds, 18);
  assert.equal(stats.maximumFrameMilliseconds, 20);
  assert.ok(Math.abs(stats.framesPerSecond - 1000 / 18) < 1e-9);
});

test('a throwing system stops the loop and names the system', () => {
  const harness = createHarness({ mode: 'variable', systems: [{ name: 'bad', update() { throw new Error('boom'); } }] });
  harness.runtime.start();
  assert.throws(() => harness.frame(0), /Runtime system "bad" update failed: boom/);
  assert.equal(harness.runtime.running, false);
  assert.equal(harness.hasPendingFrame(), false);
});

test('step runs one frame without a scheduler', () => {
  const log = [];
  const harness = createHarness({ mode: 'fixed', fixedStepSeconds: 0.01, systems: [recorder('a', log)] });
  harness.runtime.step(20);
  assert.equal(countOf(log, 'fixed'), 2);
  assert.equal(harness.rendered.length, 1);
});

test('a disposed runtime refuses to start', () => {
  const harness = createHarness();
  harness.runtime.dispose();
  assert.throws(() => harness.runtime.start(), /was disposed/);
});

test('input is validated with messages that say what to pass', () => {
  const target = { render() {} };
  const scheduler = { request: () => 1, cancel() {} };
  assert.throws(() => createRuntime({}, { scheduler }), /render\(frame\)/);
  assert.throws(() => createRuntime(target, { scheduler, mode: 'turbo' }), /one of fixed, variable, both/);
  assert.throws(() => createRuntime(target, { scheduler, fixedRate: 0 }), /fixedRate must be a number/);
  assert.throws(() => createRuntime(target, { scheduler, fixedRate: 60, fixedStepSeconds: 0.01 }), /not both/);
  assert.throws(() => createRuntime(target, { scheduler, maximumStepsPerFrame: RUNTIME_LIMITS.maximumStepsPerFrameLimit + 1 }), /maximumStepsPerFrame/);
  assert.throws(() => createRuntime(target, { scheduler, systems: {} }), /array of system objects/);
  assert.throws(() => createRuntime(target, { scheduler, systems: [{ update() {} }] }), /unique name/);
  assert.throws(() => createRuntime(target, { scheduler, systems: [{ name: 'x', update: 3 }] }), /update must be a function/);
  assert.throws(() => createRuntime(target, { scheduler, frame: 3 }), /frame must be a function/);
  assert.throws(() => createRuntime(target), /requestAnimationFrame/);
});
