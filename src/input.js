// Live input layer: an open registry of input sources, named actions and axes, and a runtime system that samples them once
// per fixed step. A source is any object that emits named values (keyboard, mouse, gamepad, MIDI, a script, an agent).
// Nothing here is a fixed list: game code registers its own sources and maps controls to its own actions.
// Events write the live control state at any time; the snapshot game logic reads changes only when the runtime samples,
// so a fixed-step game sees the same state for the whole step. See docs/input.md.

export { deviceMotionSource, INPUT_SOURCE_LIMITS, recordInput, replaySource, touchSource } from './input-sources.js';

export const INPUT_LIMITS = Object.freeze({
  maximumSources: 16,
  maximumControls: 512,
  maximumActions: 128,
  maximumAxes: 64,
  maximumBindings: 16,
  defaultButtonThreshold: 0.5,
  defaultDeadZone: 0.15,
});

function describe(value) {
  return value === null ? 'null' : typeof value;
}

function requireName(value, label) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${label} must be a non-empty string, got ${describe(value)}.`);
  }
  return value;
}

function normalizeBindings(bindings, label) {
  if (!Array.isArray(bindings) || bindings.length === 0 || bindings.length > INPUT_LIMITS.maximumBindings) {
    throw new RangeError(`${label} must be an array of 1 to ${INPUT_LIMITS.maximumBindings} control names such as "keyboard/Space".`);
  }
  return bindings.map(binding => {
    const entry = typeof binding === 'string' ? { control: binding, scale: 1 } : binding;
    if (entry === null || typeof entry !== 'object') {
      throw new TypeError(`${label} entries must be a control name or { control, scale }, got ${describe(binding)}.`);
    }
    const scale = entry.scale === undefined ? 1 : entry.scale;
    if (!Number.isFinite(scale)) {
      throw new TypeError(`${label} scale must be a finite number, got ${String(entry.scale)}.`);
    }
    return { control: requireName(entry.control, `${label} control`), scale };
  });
}

function applyDeadZone(value, deadZone) {
  const magnitude = Math.abs(value);
  if (magnitude <= deadZone) return 0;
  return Math.sign(value) * Math.min(1, (magnitude - deadZone) / (1 - deadZone));
}

export function createInput(options = {}) {
  const buttonThreshold = options.buttonThreshold ?? INPUT_LIMITS.defaultButtonThreshold;
  if (!Number.isFinite(buttonThreshold) || buttonThreshold <= 0 || buttonThreshold > 1) {
    throw new RangeError(`createInput buttonThreshold must be a number above 0 and up to 1, got ${String(buttonThreshold)}.`);
  }

  const controls = new Map(); // "source/name" -> { value, pressedLatch, releasedLatch }
  const actionBindings = new Map();
  const axisBindings = new Map();
  const sources = new Map(); // name -> { source, emit, attached }
  let started = false;
  let disposed = false;
  let snapshot = { actions: new Map(), axes: new Map() };
  const controlListeners = new Set();
  const sampleListeners = new Set();

  function assertAlive() {
    if (disposed) throw new Error('This input was disposed. Call createInput again.');
  }

  function setControl(controlName, value) {
    assertAlive();
    requireName(controlName, 'setControl control');
    if (!Number.isFinite(value)) {
      throw new TypeError(`setControl value for "${controlName}" must be a finite number (1 or 0 for a button), got ${String(value)}.`);
    }
    let control = controls.get(controlName);
    if (control === undefined) {
      if (controls.size >= INPUT_LIMITS.maximumControls) {
        throw new RangeError(`Input already has ${INPUT_LIMITS.maximumControls} controls. Reuse control names, or call releaseControls for sources that went away.`);
      }
      control = { value: 0, pressedLatch: false, releasedLatch: false };
      controls.set(controlName, control);
    }
    const wasDown = control.value >= buttonThreshold;
    const isDown = value >= buttonThreshold;
    if (isDown && !wasDown) control.pressedLatch = true;
    if (!isDown && wasDown) control.releasedLatch = true;
    control.value = value;
    for (const listener of [...controlListeners]) listener(controlName, value);
  }

  function addListener(listeners, listener, label) {
    if (typeof listener !== 'function') throw new TypeError(`${label} needs a function, got ${describe(listener)}.`);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function releaseControls(sourceName) {
    for (const [controlName, control] of controls) {
      if (sourceName !== undefined && !controlName.startsWith(`${sourceName}/`)) continue;
      if (control.value !== 0) setControl(controlName, 0);
    }
  }

  function attach(entry) {
    if (entry.attached || typeof entry.source.attach !== 'function') {
      entry.attached = true;
      return;
    }
    entry.attached = true;
    entry.source.attach(entry.emit);
  }

  function registerSource(source) {
    assertAlive();
    if (source === null || typeof source !== 'object') {
      throw new TypeError(`An input source must be an object like { name, attach(emit), poll(emit), dispose() }, got ${describe(source)}.`);
    }
    const name = requireName(source.name, 'An input source name');
    if (name.includes('/')) throw new RangeError(`Input source name "${name}" must not contain "/". Use "midi", not "midi/1".`);
    for (const hook of ['attach', 'poll', 'endSample', 'dispose']) {
      if (source[hook] !== undefined && typeof source[hook] !== 'function') {
        throw new TypeError(`Input source "${name}" ${hook} must be a function or left out, got ${describe(source[hook])}.`);
      }
    }
    if (sources.has(name)) throw new RangeError(`An input source named "${name}" is already registered. Pass another name, or unregisterSource first.`);
    if (sources.size >= INPUT_LIMITS.maximumSources) {
      throw new RangeError(`Input already has ${INPUT_LIMITS.maximumSources} sources. Unregister one before adding "${name}".`);
    }
    const foreignControls = new Set();
    const emit = (controlName, value) => setControl(`${name}/${controlName}`, value);
    emit.releaseAll = () => {
      releaseControls(name);
      for (const controlName of foreignControls) {
        if (controls.has(controlName)) setControl(controlName, 0);
      }
    };
    if (source.writesAnyControl === true) {
      // Only a source that declares writesAnyControl (a replay) may write full control names. They are tracked so
      // releaseAll and unregisterSource clean them up.
      emit.control = (controlName, value) => {
        foreignControls.add(controlName);
        setControl(controlName, value);
      };
    }
    const entry = { source, emit, attached: false, foreignControls };
    sources.set(name, entry);
    if (started) attach(entry);
    return api;
  }

  function unregisterSource(name) {
    const entry = sources.get(name);
    if (entry === undefined) throw new RangeError(`No input source named "${String(name)}". Registered: ${[...sources.keys()].join(', ') || 'none'}.`);
    entry.source.dispose?.();
    sources.delete(name);
    entry.emit.releaseAll();
    for (const controlName of [...controls.keys()]) {
      if (controlName.startsWith(`${name}/`) || entry.foreignControls.has(controlName)) controls.delete(controlName);
    }
    return api;
  }

  function bindAction(name, bindings) {
    assertAlive();
    requireName(name, 'bindAction name');
    if (!actionBindings.has(name) && actionBindings.size >= INPUT_LIMITS.maximumActions) {
      throw new RangeError(`Input already has ${INPUT_LIMITS.maximumActions} actions. Reuse a name or unbindAction first.`);
    }
    actionBindings.set(name, normalizeBindings(bindings, `Action "${name}" bindings`));
    return api;
  }

  function bindAxis(name, definition) {
    assertAlive();
    requireName(name, 'bindAxis name');
    const bindings = Array.isArray(definition) ? definition : definition?.bindings;
    const deadZone = (Array.isArray(definition) ? undefined : definition?.deadZone) ?? INPUT_LIMITS.defaultDeadZone;
    const smoothing = (Array.isArray(definition) ? undefined : definition?.smoothing) ?? 0;
    if (!Number.isFinite(smoothing) || smoothing < 0 || smoothing >= 1) {
      throw new RangeError(`Axis "${name}" smoothing must be a number from 0 (none) up to but not including 1, got ${String(smoothing)}. Each sample moves the axis (1 - smoothing) of the way to its target.`);
    }
    if (!Number.isFinite(deadZone) || deadZone < 0 || deadZone >= 1) {
      throw new RangeError(`Axis "${name}" deadZone must be a number from 0 up to but not including 1, got ${String(deadZone)}.`);
    }
    if (!axisBindings.has(name) && axisBindings.size >= INPUT_LIMITS.maximumAxes) {
      throw new RangeError(`Input already has ${INPUT_LIMITS.maximumAxes} axes. Reuse a name or unbindAxis first.`);
    }
    axisBindings.set(name, { bindings: normalizeBindings(bindings, `Axis "${name}" bindings`), deadZone, smoothing, smoothed: 0 });
    return api;
  }

  function sample() {
    assertAlive();
    for (const entry of sources.values()) entry.source.poll?.(entry.emit);
    const actions = new Map();
    for (const [name, bindings] of actionBindings) {
      const state = { held: false, pressed: false, released: false };
      for (const { control: controlName } of bindings) {
        const control = controls.get(controlName);
        if (control === undefined) continue;
        if (control.value >= buttonThreshold) state.held = true;
        if (control.pressedLatch) state.pressed = true;
        if (control.releasedLatch) state.released = true;
      }
      actions.set(name, state);
    }
    const axes = new Map();
    for (const [name, axis] of axisBindings) {
      let total = 0;
      for (const { control: controlName, scale } of axis.bindings) {
        total += (controls.get(controlName)?.value ?? 0) * scale;
      }
      const target = applyDeadZone(Math.max(-1, Math.min(1, total)), axis.deadZone);
      axis.smoothed = axis.smoothing === 0 ? target : axis.smoothed + (target - axis.smoothed) * (1 - axis.smoothing);
      axes.set(name, axis.smoothed);
    }
    for (const control of controls.values()) {
      control.pressedLatch = false;
      control.releasedLatch = false;
    }
    snapshot = { actions, axes };
    // Listeners hear the sample end before sources reset their pulses, so a reset (a tap going back to 0) is
    // recorded under the next sample number, the way a live game sees it.
    for (const listener of [...sampleListeners]) listener();
    for (const entry of sources.values()) entry.source.endSample?.(entry.emit);
  }

  function actionState(name) {
    const state = snapshot.actions.get(name);
    if (state !== undefined) return state;
    if (!actionBindings.has(name)) {
      throw new RangeError(`No action named "${String(name)}". Bind it first: input.bindAction("${String(name)}", ["keyboard/Space"]).`);
    }
    return { held: false, pressed: false, released: false }; // bound but not sampled yet
  }

  function getAxis(name) {
    const value = snapshot.axes.get(name);
    if (value !== undefined) return value;
    if (!axisBindings.has(name)) {
      throw new RangeError(`No axis named "${String(name)}". Bind it first: input.bindAxis("${String(name)}", { bindings: ["gamepad/0.axis0"] }).`);
    }
    return 0;
  }

  function dispose() {
    if (disposed) return;
    for (const entry of [...sources.values()].reverse()) entry.source.dispose?.();
    sources.clear();
    controls.clear();
    actionBindings.clear();
    axisBindings.clear();
    snapshot = { actions: new Map(), axes: new Map() };
    controlListeners.clear();
    sampleListeners.clear();
    disposed = true;
  }

  const api = {
    name: options.name ?? 'input',
    registerSource,
    unregisterSource,
    bindAction,
    bindAxis,
    unbindAction: name => actionBindings.delete(name),
    unbindAxis: name => axisBindings.delete(name),
    setControl,
    press: controlName => setControl(controlName, 1),
    release: controlName => setControl(controlName, 0),
    releaseControls,
    sample,
    // Observers for recording: the first hears every control change, the second the end of every sample.
    // Each returns a function that removes the listener.
    onControlChange: listener => addListener(controlListeners, listener, 'onControlChange'),
    onSample: listener => addListener(sampleListeners, listener, 'onSample'),
    isHeld: name => actionState(name).held,
    wasPressed: name => actionState(name).pressed,
    wasReleased: name => actionState(name).released,
    getAxis,
    get sources() {
      return [...sources.keys()];
    },
    // Runtime system hooks. Fixed-step games sample once per fixed step; a variable-only loop samples once per frame.
    init() {
      assertAlive();
      started = true;
      for (const entry of sources.values()) attach(entry);
    },
    fixedUpdate() {
      sample();
    },
    update(delta, context) {
      if (context?.mode === 'variable') sample();
    },
    dispose,
  };

  for (const source of options.sources ?? []) registerSource(source);
  for (const [name, bindings] of Object.entries(options.actions ?? {})) bindAction(name, bindings);
  for (const [name, definition] of Object.entries(options.axes ?? {})) bindAxis(name, definition);
  return api;
}

// Keyboard: controls are "keyboard/<KeyboardEvent.code>", for example keyboard/Space or keyboard/KeyW.
export function keyboardSource(options = {}) {
  const target = options.target ?? globalThis;
  const blurTarget = options.blurTarget ?? globalThis;
  let handlers = null;
  return {
    name: 'keyboard',
    attach(emit) {
      assertTarget(target, 'keyboardSource target');
      handlers = {
        keydown: event => { if (!event.repeat) emit(event.code, 1); },
        keyup: event => emit(event.code, 0),
        blur: () => emit.releaseAll(),
      };
      target.addEventListener('keydown', handlers.keydown);
      target.addEventListener('keyup', handlers.keyup);
      blurTarget.addEventListener?.('blur', handlers.blur);
    },
    dispose() {
      if (handlers === null) return;
      target.removeEventListener('keydown', handlers.keydown);
      target.removeEventListener('keyup', handlers.keyup);
      blurTarget.removeEventListener?.('blur', handlers.blur);
      handlers = null;
    },
  };
}

// Mouse and pointer: "mouse/button0".. for buttons (touch and pen report as button0), "mouse/x" and "mouse/y" in client
// pixels, and "mouse/deltaX", "mouse/deltaY" as movement summed since the last sample (works under pointer lock).
export function mouseSource(options = {}) {
  const target = options.target ?? globalThis;
  const blurTarget = options.blurTarget ?? globalThis;
  let handlers = null;
  let movementX = 0;
  let movementY = 0;
  return {
    name: 'mouse',
    attach(emit) {
      assertTarget(target, 'mouseSource target');
      handlers = {
        pointerdown: event => {
          emit(`button${event.button ?? 0}`, 1);
          if (options.pointerLockElement?.requestPointerLock) options.pointerLockElement.requestPointerLock();
        },
        pointerup: event => emit(`button${event.button ?? 0}`, 0),
        pointermove: event => {
          emit('x', event.clientX ?? 0);
          emit('y', event.clientY ?? 0);
          movementX += event.movementX ?? 0;
          movementY += event.movementY ?? 0;
          emit('deltaX', movementX);
          emit('deltaY', movementY);
        },
        blur: () => emit.releaseAll(),
      };
      for (const type of ['pointerdown', 'pointerup', 'pointermove']) target.addEventListener(type, handlers[type]);
      blurTarget.addEventListener?.('blur', handlers.blur);
    },
    endSample(emit) {
      movementX = 0;
      movementY = 0;
      emit('deltaX', 0);
      emit('deltaY', 0);
    },
    dispose() {
      if (handlers === null) return;
      for (const type of ['pointerdown', 'pointerup', 'pointermove']) target.removeEventListener(type, handlers[type]);
      blurTarget.removeEventListener?.('blur', handlers.blur);
      handlers = null;
    },
  };
}

// Gamepad: polled at each sample. Controls are "gamepad/<index>.button<n>" (0 to 1) and "gamepad/<index>.axis<n>" (-1 to 1),
// for example gamepad/0.button0 and gamepad/0.axis1.
export function gamepadSource(options = {}) {
  const readGamepads = options.getGamepads ?? (() => (typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []));
  let previousNames = new Set();
  return {
    name: 'gamepad',
    poll(emit) {
      const seen = new Set();
      for (const pad of readGamepads() ?? []) {
        if (!pad) continue;
        pad.buttons.forEach((button, index) => {
          const name = `${pad.index}.button${index}`;
          seen.add(name);
          emit(name, button.pressed ? 1 : button.value ?? 0);
        });
        pad.axes.forEach((value, index) => {
          const name = `${pad.index}.axis${index}`;
          seen.add(name);
          emit(name, value);
        });
      }
      for (const name of previousNames) {
        if (!seen.has(name)) emit(name, 0); // pad unplugged
      }
      previousNames = seen;
    },
  };
}

function assertTarget(target, label) {
  if (!target || typeof target.addEventListener !== 'function' || typeof target.removeEventListener !== 'function') {
    throw new TypeError(`${label} must have addEventListener and removeEventListener, such as window or a canvas.`);
  }
}
