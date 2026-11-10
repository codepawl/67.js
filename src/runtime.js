// Live game loop: a fixed-step, variable-step or interpolated loop that runs ordered systems and then renders.
// Films never use it. A film renders every frame as a pure function of time, so this file only adds a way to drive a
// renderer live and changes nothing in the film path. The clock and the frame scheduler are injected, so tests run it
// without real time. Systems (physics, input, animation, audio, game code) plug in through the interface in
// docs/runtime.md and can be added, replaced or left out.

export const RUNTIME_MODES = Object.freeze(['fixed', 'variable', 'both']);

export const RUNTIME_LIMITS = Object.freeze({
  defaultFixedStepSeconds: 1 / 60,
  minimumFixedStepSeconds: 1 / 1000,
  maximumFixedStepSeconds: 1,
  defaultMaximumFrameSeconds: 0.25,
  defaultMaximumStepsPerFrame: 8,
  maximumStepsPerFrameLimit: 1000,
  maximumSystems: 64,
  frameWindow: 120,
});

const SYSTEM_HOOKS = ['init', 'fixedUpdate', 'update', 'dispose'];

function describe(value) {
  return value === null ? 'null' : typeof value;
}

function positiveNumber(value, label, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`createRuntime ${label} must be a number from ${minimum} to ${maximum}, got ${String(value)}.`);
  }
  return value;
}

function validateSystem(system, existingNames) {
  if (system === null || typeof system !== 'object') {
    throw new TypeError(`A runtime system must be an object like { name, init, fixedUpdate, update, dispose }, got ${describe(system)}.`);
  }
  if (typeof system.name !== 'string' || system.name === '') {
    throw new TypeError('A runtime system needs a unique name string, such as { name: "physics", fixedUpdate(step) {} }.');
  }
  for (const hook of SYSTEM_HOOKS) {
    if (system[hook] !== undefined && typeof system[hook] !== 'function') {
      throw new TypeError(`Runtime system "${system.name}" ${hook} must be a function or left out, got ${describe(system[hook])}.`);
    }
  }
  if (existingNames.has(system.name)) {
    throw new RangeError(`A runtime system named "${system.name}" already exists. Pass another name, or use replaceSystem to swap it.`);
  }
}

function defaultScheduler() {
  if (typeof requestAnimationFrame !== 'function' || typeof cancelAnimationFrame !== 'function') {
    throw new TypeError('createRuntime found no requestAnimationFrame. Pass options.scheduler as { request(callback), cancel(handle) }.');
  }
  return {
    request: callback => requestAnimationFrame(callback),
    cancel: handle => cancelAnimationFrame(handle),
  };
}

function defaultClock() {
  return () => performance.now();
}

function defaultVisibility() {
  if (typeof document === 'undefined') return { hidden: false, subscribe: () => () => {} };
  return {
    get hidden() { return document.hidden; },
    subscribe(callback) {
      document.addEventListener('visibilitychange', callback);
      return () => document.removeEventListener('visibilitychange', callback);
    },
  };
}

function validateOptions(target, options) {
  if (target === null || typeof target !== 'object' || typeof target.render !== 'function') {
    throw new TypeError('createRuntime needs a renderer as its first argument: an object with a render(frame) method, such as a Renderer67.');
  }
  if (options === null || typeof options !== 'object') throw new TypeError('createRuntime options must be an object or left out.');
  const mode = options.mode ?? 'both';
  if (!RUNTIME_MODES.includes(mode)) {
    throw new RangeError(`createRuntime mode must be one of ${RUNTIME_MODES.join(', ')}, got ${String(mode)}.`);
  }
  if (options.fixedStepSeconds !== undefined && options.fixedRate !== undefined) {
    throw new RangeError('createRuntime takes fixedStepSeconds or fixedRate, not both.');
  }
  const fixedStepSeconds = options.fixedRate === undefined
    ? options.fixedStepSeconds ?? RUNTIME_LIMITS.defaultFixedStepSeconds
    : 1 / positiveNumber(options.fixedRate, 'fixedRate', 1, 1 / RUNTIME_LIMITS.minimumFixedStepSeconds);
  positiveNumber(fixedStepSeconds, 'fixedStepSeconds', RUNTIME_LIMITS.minimumFixedStepSeconds, RUNTIME_LIMITS.maximumFixedStepSeconds);
  const maximumFrameSeconds = positiveNumber(options.maximumFrameSeconds ?? RUNTIME_LIMITS.defaultMaximumFrameSeconds, 'maximumFrameSeconds', 0.001, 10);
  const maximumStepsPerFrame = positiveNumber(options.maximumStepsPerFrame ?? RUNTIME_LIMITS.defaultMaximumStepsPerFrame, 'maximumStepsPerFrame', 1, RUNTIME_LIMITS.maximumStepsPerFrameLimit);
  if (options.frame !== undefined && typeof options.frame !== 'function') {
    throw new TypeError('createRuntime frame must be a function (context) => frame for target.render, or left out.');
  }
  if (typeof (options.pauseWhenHidden ?? true) !== 'boolean') throw new TypeError('createRuntime pauseWhenHidden must be a boolean.');
  const systems = options.systems ?? [];
  if (!Array.isArray(systems)) throw new TypeError('createRuntime systems must be an array of system objects, in the order they run.');
  return { mode, fixedStepSeconds, maximumFrameSeconds, maximumStepsPerFrame, systems };
}

export function createRuntime(target, options = {}) {
  const settings = validateOptions(target, options);
  const { mode, fixedStepSeconds, maximumFrameSeconds, maximumStepsPerFrame } = settings;
  const scheduler = options.scheduler ?? defaultScheduler();
  const now = options.clock ?? defaultClock();
  const visibility = options.visibility ?? defaultVisibility();
  const pauseWhenHidden = options.pauseWhenHidden ?? true;
  const buildFrame = options.frame ?? (context => ({ time: context.elapsedSeconds }));
  const usesFixed = mode !== 'variable';
  const usesVariable = mode !== 'fixed';

  const systems = [];
  const initialised = new Set();
  const context = { runtime: null, target, mode, fixedStepSeconds, deltaSeconds: 0, elapsedSeconds: 0, alpha: 1 };
  const frameTimes = [];
  const stats = { frames: 0, fixedSteps: 0, droppedSeconds: 0, lastFixedSteps: 0, frameMilliseconds: 0, updateMilliseconds: 0, renderMilliseconds: 0 };

  let running = false;
  let manuallyPaused = false;
  let disposed = false;
  let handle = null;
  let lastTime = null;
  let accumulator = 0;
  let unsubscribeVisibility = null;

  const isPaused = () => manuallyPaused || (pauseWhenHidden && visibility.hidden === true);

  function callHook(system, hook, ...args) {
    if (!system[hook]) return;
    try {
      system[hook](...args, context);
    } catch (error) {
      error.message = `Runtime system "${system.name}" ${hook} failed: ${error.message}`;
      throw error;
    }
  }

  function initialise(system) {
    if (initialised.has(system)) return;
    initialised.add(system);
    callHook(system, 'init');
  }

  function disposeSystem(system) {
    if (!initialised.delete(system)) return;
    callHook(system, 'dispose');
  }

  function cancelFrame() {
    if (handle === null) return;
    scheduler.cancel(handle);
    handle = null;
  }

  function scheduleFrame() {
    if (running && handle === null && !isPaused()) handle = scheduler.request(tick);
  }

  function recordFrameTime(milliseconds) {
    frameTimes.push(milliseconds);
    if (frameTimes.length > RUNTIME_LIMITS.frameWindow) frameTimes.shift();
  }

  function runFixedSteps() {
    let steps = 0;
    while (accumulator >= fixedStepSeconds && steps < maximumStepsPerFrame) {
      context.deltaSeconds = fixedStepSeconds;
      for (const system of systems) callHook(system, 'fixedUpdate', fixedStepSeconds);
      accumulator -= fixedStepSeconds;
      steps += 1;
    }
    if (accumulator >= fixedStepSeconds) {
      stats.droppedSeconds += accumulator - (accumulator % fixedStepSeconds);
      accumulator %= fixedStepSeconds;
    }
    stats.lastFixedSteps = steps;
    stats.fixedSteps += steps;
  }

  function advance(frameSeconds) {
    context.elapsedSeconds += frameSeconds;
    if (usesFixed) {
      accumulator += frameSeconds;
      runFixedSteps();
    }
    if (usesVariable) {
      context.deltaSeconds = frameSeconds;
      for (const system of systems) callHook(system, 'update', frameSeconds);
    }
    context.alpha = mode === 'both' ? accumulator / fixedStepSeconds : 1;
  }

  function tick() {
    handle = null;
    if (!running || isPaused()) return;
    const frameStart = now();
    const elapsedMilliseconds = lastTime === null ? 0 : Math.max(0, frameStart - lastTime);
    lastTime = frameStart;
    const frameSeconds = Math.min(elapsedMilliseconds / 1000, maximumFrameSeconds);
    try {
      advance(frameSeconds);
      const updateEnd = now();
      target.render(buildFrame(context));
      const renderEnd = now();
      stats.updateMilliseconds = updateEnd - frameStart;
      stats.renderMilliseconds = renderEnd - updateEnd;
    } catch (error) {
      stopLoop();
      throw error;
    }
    stats.frames += 1;
    stats.frameMilliseconds = elapsedMilliseconds;
    if (stats.frames > 1) recordFrameTime(elapsedMilliseconds);
    scheduleFrame();
  }

  function stopLoop() {
    running = false;
    cancelFrame();
    lastTime = null;
    accumulator = 0;
  }

  function onVisibilityChange() {
    if (isPaused()) {
      cancelFrame();
      return;
    }
    lastTime = null;
    scheduleFrame();
  }

  function assertUsable(action) {
    if (disposed) throw new Error(`Cannot ${action}: this runtime was disposed. Call createRuntime again.`);
  }

  const runtime = {
    get mode() { return mode; },
    get running() { return running; },
    get paused() { return running && isPaused(); },
    get systems() { return systems.map(system => system.name); },

    // Initialises the systems once, then schedules frames. Starting a running runtime does nothing.
    start() {
      assertUsable('start');
      if (running) return runtime;
      running = true;
      lastTime = null;
      try {
        for (const system of systems) initialise(system);
      } catch (error) {
        running = false;
        throw error;
      }
      unsubscribeVisibility ??= visibility.subscribe(onVisibilityChange);
      scheduleFrame();
      return runtime;
    },

    // Stops scheduling frames and drops the partial step. Systems stay initialised, so start() resumes the same world.
    stop() {
      stopLoop();
      return runtime;
    },

    // Holds the loop without ending it. The time while paused is never simulated.
    pause() {
      manuallyPaused = true;
      cancelFrame();
      return runtime;
    },

    resume() {
      assertUsable('resume');
      manuallyPaused = false;
      lastTime = null;
      scheduleFrame();
      return runtime;
    },

    // Runs one frame of `milliseconds` without the scheduler: for tests, headless runs and stepping while paused.
    step(milliseconds = fixedStepSeconds * 1000) {
      assertUsable('step');
      positiveNumber(milliseconds, 'step milliseconds', 0, maximumFrameSeconds * 1000);
      for (const system of systems) initialise(system);
      advance(milliseconds / 1000);
      target.render(buildFrame(context));
      stats.frames += 1;
      return runtime;
    },

    // Adds a system after the ones already present, or at `index`. A running runtime initialises it at once.
    addSystem(system, index = systems.length) {
      assertUsable('addSystem');
      validateSystem(system, new Set(systems.map(existing => existing.name)));
      if (systems.length >= RUNTIME_LIMITS.maximumSystems) {
        throw new RangeError(`A runtime holds at most ${RUNTIME_LIMITS.maximumSystems} systems. Merge some, or remove one first.`);
      }
      if (!Number.isInteger(index) || index < 0 || index > systems.length) {
        throw new RangeError(`addSystem index must be an integer from 0 to ${systems.length}, got ${String(index)}.`);
      }
      systems.splice(index, 0, system);
      if (running) initialise(system);
      return runtime;
    },

    // Swaps a system for another in the same place. The old one is disposed, the new one initialised if the loop has started.
    replaceSystem(name, system) {
      assertUsable('replaceSystem');
      const index = systems.findIndex(existing => existing.name === name);
      if (index < 0) throw new RangeError(`No runtime system named "${String(name)}". Present: ${runtime.systems.join(', ') || 'none'}. Use addSystem to add one.`);
      validateSystem(system, new Set(systems.filter((_, position) => position !== index).map(existing => existing.name)));
      const [previous] = systems.splice(index, 1, system);
      disposeSystem(previous);
      if (running) initialise(system);
      return runtime;
    },

    removeSystem(name) {
      assertUsable('removeSystem');
      const index = systems.findIndex(existing => existing.name === name);
      if (index < 0) throw new RangeError(`No runtime system named "${String(name)}". Present: ${runtime.systems.join(', ') || 'none'}.`);
      const [removed] = systems.splice(index, 1);
      disposeSystem(removed);
      return runtime;
    },

    getSystem(name) {
      return systems.find(system => system.name === name);
    },

    // Frame-time readout. Times are in milliseconds; the averages cover the last 120 frames.
    get stats() {
      const count = frameTimes.length;
      const average = count ? frameTimes.reduce((sum, value) => sum + value, 0) / count : 0;
      return {
        ...stats,
        averageFrameMilliseconds: average,
        maximumFrameMilliseconds: count ? Math.max(...frameTimes) : 0,
        framesPerSecond: average > 0 ? 1000 / average : 0,
        alpha: context.alpha,
        elapsedSeconds: context.elapsedSeconds,
      };
    },

    // Stops the loop and disposes every system in reverse order. The runtime cannot start again.
    dispose() {
      if (disposed) return;
      stopLoop();
      unsubscribeVisibility?.();
      unsubscribeVisibility = null;
      disposed = true;
      for (const system of [...systems].reverse()) disposeSystem(system);
      systems.length = 0;
    },
  };

  context.runtime = runtime;
  for (const system of settings.systems) runtime.addSystem(system);
  return runtime;
}
