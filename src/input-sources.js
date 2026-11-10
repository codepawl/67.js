// Input sources beyond the basics: touch sticks and gestures, device motion, and input recording with replay.
// Each source follows the contract in input.js: { name, attach(emit), poll(emit), endSample(emit), dispose() }.
// This file does not import input.js, so input.js can re-export it. See docs/input.md.

export const INPUT_SOURCE_LIMITS = Object.freeze({
  maximumTouchSticks: 4,
  maximumRecordedEvents: 100000,
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

function requirePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a number above 0, got ${String(value)}.`);
  }
  return value;
}

function assertTarget(target, label) {
  if (!target || typeof target.addEventListener !== 'function' || typeof target.removeEventListener !== 'function') {
    throw new TypeError(`${label} must have addEventListener and removeEventListener, such as window or a canvas.`);
  }
}

function clampUnit(value) {
  return Math.max(-1, Math.min(1, value));
}

function normalizeStick(stick, index) {
  if (stick === null || typeof stick !== 'object') {
    throw new TypeError(`touchSource sticks[${index}] must be { name, area: { x, y, width, height }, radius }, got ${describe(stick)}.`);
  }
  const name = requireName(stick.name, `touchSource sticks[${index}] name`);
  const area = stick.area;
  for (const key of ['x', 'y', 'width', 'height']) {
    if (area === null || typeof area !== 'object' || !Number.isFinite(area[key])) {
      throw new TypeError(`touchSource stick "${name}" area needs numbers x, y, width and height as fractions of the target, such as { x: 0, y: 0, width: 0.5, height: 1 } for the left half.`);
    }
  }
  return { name, area, radius: requirePositive(stick.radius ?? 60, `touchSource stick "${name}" radius`) };
}

// Touch: virtual sticks and gestures from pointer events with pointerType "touch" (mouse and pen are ignored).
// A stick is a part of the target (area, as fractions of its size). The first touch that starts inside it sets the centre;
// dragging up to `radius` pixels gives "touch/<stick>X" and "touch/<stick>Y" from -1 to 1 (down is +1 on Y), and
// "touch/<stick>Active" is 1 while held. A touch outside every free stick is a gesture touch:
// "touch/tap" pulses 1 on a short, small touch; "touch/swipeLeft|Right|Up|Down" pulse on a fast, long drag;
// "touch/pinch" sums the ratio change between two gesture touches since the last sample (0.1 = spread 10 percent).
export function touchSource(options = {}) {
  const target = options.target ?? globalThis;
  const blurTarget = options.blurTarget ?? globalThis;
  const sticks = (options.sticks ?? []).map(normalizeStick);
  if (sticks.length > INPUT_SOURCE_LIMITS.maximumTouchSticks) {
    throw new RangeError(`touchSource takes up to ${INPUT_SOURCE_LIMITS.maximumTouchSticks} sticks, got ${sticks.length}.`);
  }
  const tapMaximumMilliseconds = requirePositive(options.tapMaximumMilliseconds ?? 250, 'touchSource tapMaximumMilliseconds');
  const tapMaximumDistance = requirePositive(options.tapMaximumDistance ?? 10, 'touchSource tapMaximumDistance');
  const swipeMinimumDistance = requirePositive(options.swipeMinimumDistance ?? 50, 'touchSource swipeMinimumDistance');
  const swipeMaximumMilliseconds = requirePositive(options.swipeMaximumMilliseconds ?? 400, 'touchSource swipeMaximumMilliseconds');
  const stickTouches = new Map(); // pointerId -> { stick, originX, originY }
  const gestureTouches = new Map(); // pointerId -> { startX, startY, startTime, x, y }
  let pulses = new Set();
  let pinchTotal = 0;
  let handlers = null;
  const eventTypes = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'];

  function bounds() {
    const rectangle = target.getBoundingClientRect?.();
    if (rectangle) return rectangle;
    return { left: 0, top: 0, width: target.innerWidth ?? 1, height: target.innerHeight ?? 1 };
  }

  function findFreeStick(x, y) {
    const { left, top, width, height } = bounds();
    return sticks.find(({ area, name }) => {
      const minimumX = left + area.x * width;
      const minimumY = top + area.y * height;
      const inside = x >= minimumX && x <= minimumX + area.width * width && y >= minimumY && y <= minimumY + area.height * height;
      const held = [...stickTouches.values()].some(touch => touch.stick.name === name);
      return inside && !held;
    });
  }

  function gestureDistance() {
    const [first, second] = [...gestureTouches.values()];
    return Math.hypot(first.x - second.x, first.y - second.y);
  }

  function pulse(emit, name) {
    pulses.add(name);
    emit(name, 1);
  }

  function finishGesture(emit, touch, event) {
    const deltaX = event.clientX - touch.startX;
    const deltaY = event.clientY - touch.startY;
    const distance = Math.hypot(deltaX, deltaY);
    const elapsed = (event.timeStamp ?? 0) - touch.startTime;
    if (distance <= tapMaximumDistance && elapsed <= tapMaximumMilliseconds) {
      pulse(emit, 'tap');
      return;
    }
    if (distance < swipeMinimumDistance || elapsed > swipeMaximumMilliseconds) return;
    if (Math.abs(deltaX) >= Math.abs(deltaY)) {
      pulse(emit, deltaX < 0 ? 'swipeLeft' : 'swipeRight');
    } else {
      pulse(emit, deltaY < 0 ? 'swipeUp' : 'swipeDown');
    }
  }

  function handlePointerDown(emit, event) {
    if (event.pointerType !== 'touch') return;
    const stick = findFreeStick(event.clientX, event.clientY);
    if (stick) {
      stickTouches.set(event.pointerId, { stick, originX: event.clientX, originY: event.clientY });
      emit(`${stick.name}Active`, 1);
      return;
    }
    gestureTouches.set(event.pointerId, {
      startX: event.clientX,
      startY: event.clientY,
      startTime: event.timeStamp ?? 0,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function handlePointerMove(emit, event) {
    const stickTouch = stickTouches.get(event.pointerId);
    if (stickTouch) {
      emit(`${stickTouch.stick.name}X`, clampUnit((event.clientX - stickTouch.originX) / stickTouch.stick.radius));
      emit(`${stickTouch.stick.name}Y`, clampUnit((event.clientY - stickTouch.originY) / stickTouch.stick.radius));
      return;
    }
    const gestureTouch = gestureTouches.get(event.pointerId);
    if (!gestureTouch) return;
    const distanceBefore = gestureTouches.size === 2 ? gestureDistance() : 0;
    gestureTouch.x = event.clientX;
    gestureTouch.y = event.clientY;
    if (distanceBefore > 0) {
      pinchTotal += gestureDistance() / distanceBefore - 1;
      emit('pinch', pinchTotal);
    }
  }

  function handlePointerUp(emit, event) {
    const stickTouch = stickTouches.get(event.pointerId);
    if (stickTouch) {
      stickTouches.delete(event.pointerId);
      emit(`${stickTouch.stick.name}Active`, 0);
      emit(`${stickTouch.stick.name}X`, 0);
      emit(`${stickTouch.stick.name}Y`, 0);
      return;
    }
    const gestureTouch = gestureTouches.get(event.pointerId);
    if (!gestureTouch) return;
    gestureTouches.delete(event.pointerId);
    if (gestureTouches.size === 0) finishGesture(emit, gestureTouch, event);
  }

  return {
    name: 'touch',
    attach(emit) {
      assertTarget(target, 'touchSource target');
      handlers = {
        pointerdown: event => handlePointerDown(emit, event),
        pointermove: event => handlePointerMove(emit, event),
        pointerup: event => handlePointerUp(emit, event),
        pointercancel: event => handlePointerUp(emit, event),
        blur: () => {
          stickTouches.clear();
          gestureTouches.clear();
          emit.releaseAll();
        },
      };
      for (const type of eventTypes) target.addEventListener(type, handlers[type]);
      blurTarget.addEventListener?.('blur', handlers.blur);
    },
    endSample(emit) {
      for (const name of pulses) emit(name, 0);
      pulses = new Set();
      if (pinchTotal !== 0) emit('pinch', 0);
      pinchTotal = 0;
    },
    dispose() {
      if (handlers === null) return;
      for (const type of eventTypes) target.removeEventListener(type, handlers[type]);
      blurTarget.removeEventListener?.('blur', handlers.blur);
      handlers = null;
    },
  };
}

// Device motion: "motion/accelX|Y|Z" (acceleration with gravity, m/s^2), "motion/rotationAlpha|Beta|Gamma" (deg/s),
// "motion/alpha|beta|gamma" (orientation, degrees) and "motion/tiltX", "motion/tiltY" (gamma and beta over 45 degrees,
// clamped to -1 to 1: a phone held flat reads 0, tipped right or toward you reads +1).
// iOS needs a user gesture to allow sensors: call source.requestPermission() from a tap handler.
export function deviceMotionSource(options = {}) {
  const target = options.target ?? globalThis;
  let handlers = null;
  return {
    name: 'motion',
    attach(emit) {
      assertTarget(target, 'deviceMotionSource target');
      const emitFinite = (name, value) => {
        if (Number.isFinite(value)) emit(name, value);
      };
      handlers = {
        devicemotion: event => {
          const acceleration = event.accelerationIncludingGravity ?? {};
          emitFinite('accelX', acceleration.x);
          emitFinite('accelY', acceleration.y);
          emitFinite('accelZ', acceleration.z);
          const rotation = event.rotationRate ?? {};
          emitFinite('rotationAlpha', rotation.alpha);
          emitFinite('rotationBeta', rotation.beta);
          emitFinite('rotationGamma', rotation.gamma);
        },
        deviceorientation: event => {
          emitFinite('alpha', event.alpha);
          emitFinite('beta', event.beta);
          emitFinite('gamma', event.gamma);
          if (Number.isFinite(event.gamma)) emit('tiltX', clampUnit(event.gamma / 45));
          if (Number.isFinite(event.beta)) emit('tiltY', clampUnit(event.beta / 45));
        },
      };
      for (const type of Object.keys(handlers)) target.addEventListener(type, handlers[type]);
    },
    async requestPermission() {
      const eventClasses = [globalThis.DeviceMotionEvent, globalThis.DeviceOrientationEvent]
        .filter(eventClass => typeof eventClass?.requestPermission === 'function');
      for (const eventClass of eventClasses) {
        if (await eventClass.requestPermission() !== 'granted') return false;
      }
      return true;
    },
    dispose() {
      if (handlers === null) return;
      for (const type of Object.keys(handlers)) target.removeEventListener(type, handlers[type]);
      handlers = null;
    },
  };
}

// Recording: logs every control change with the number of the sample it belongs to, as plain JSON:
// { version: 1, samples, truncated, events: [[sampleIndex, "source/control", value], ...] }.
// Call stop() to get the recording. Past maximumRecordedEvents it stops logging and sets truncated.
export function recordInput(input) {
  if (input === null || typeof input !== 'object' || typeof input.onControlChange !== 'function' || typeof input.onSample !== 'function') {
    throw new TypeError('recordInput needs an input made by createInput.');
  }
  const events = [];
  let sampleIndex = 0;
  let truncated = false;
  const stopListening = input.onControlChange((controlName, value) => {
    if (events.length >= INPUT_SOURCE_LIMITS.maximumRecordedEvents) {
      truncated = true;
      return;
    }
    events.push([sampleIndex, controlName, value]);
  });
  const stopSampling = input.onSample(() => {
    sampleIndex += 1;
  });
  return {
    get sampleCount() {
      return sampleIndex;
    },
    stop() {
      stopListening();
      stopSampling();
      return { version: 1, samples: sampleIndex, truncated, events: events.map(event => [...event]) };
    },
  };
}

function validateRecording(recording) {
  const valid = recording !== null && typeof recording === 'object' && recording.version === 1
    && Array.isArray(recording.events) && Number.isInteger(recording.samples) && recording.samples >= 0;
  if (!valid) throw new TypeError('replaySource needs a recording from recordInput(input).stop(): { version: 1, samples, events }.');
  if (recording.events.length > INPUT_SOURCE_LIMITS.maximumRecordedEvents) {
    throw new RangeError(`A recording holds up to ${INPUT_SOURCE_LIMITS.maximumRecordedEvents} events, got ${recording.events.length}.`);
  }
  let previousSample = 0;
  recording.events.forEach((event, index) => {
    const wellFormed = Array.isArray(event) && event.length === 3 && Number.isInteger(event[0]) && event[0] >= previousSample
      && typeof event[1] === 'string' && event[1] !== '' && Number.isFinite(event[2]);
    if (!wellFormed) {
      throw new TypeError(`Recording event ${index} must be [sampleIndex, "source/control", value] with sample indexes that do not go down, got ${JSON.stringify(event)}.`);
    }
    previousSample = event[0];
  });
}

// Replay: writes the recorded changes back during the same sample numbers, under their original control names, so the
// game's bindings and code run unchanged. Use it with an input that has no live sources, or live input mixes in.
// When the recording ends the replay releases what it set; `finished` turns true, and `loop: true` starts over.
export function replaySource(recording, options = {}) {
  validateRecording(recording);
  const loop = options.loop === true;
  const touched = new Set();
  let nextEvent = 0;
  let sampleIndex = 0;
  return {
    name: options.name ?? 'replay',
    get finished() {
      return !loop && sampleIndex > recording.samples;
    },
    poll(emit) {
      if (sampleIndex >= recording.samples) {
        for (const controlName of touched) emit.control(controlName, 0);
        touched.clear();
        sampleIndex = loop ? 0 : recording.samples + 1;
        nextEvent = 0;
        return;
      }
      while (nextEvent < recording.events.length && recording.events[nextEvent][0] <= sampleIndex) {
        const [, controlName, value] = recording.events[nextEvent];
        emit.control(controlName, value);
        touched.add(controlName);
        nextEvent += 1;
      }
      sampleIndex += 1;
    },
  };
}
