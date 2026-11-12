import { boundedNumber, rejectUnknownKeys, rotateByQuaternion } from './physics-values.js';

// A boat on the floating-body code: throttle pushes the stern along the hull and the rudder pushes it sideways, both as forces at
// the stern point, so the hull still pitches and rolls on the waves. Both scale with how much of the hull is in the water, and a
// keel drag removes the sideways slip so the hull follows its bow through a turn. The bake and the live runtime call the same
// functions, and the controls are either keyframes (a bake) or the last values a controller set (live).

export const BOAT_LIMITS = Object.freeze({ maxControls: 256 });

const BOAT_KEYS = ['thrust', 'rudder', 'keelDrag', 'stern', 'forward', 'controls', 'wake'];
const WAKE_KEYS = ['width', 'strength', 'height', 'lifetime'];
const FORWARD_AXES = Object.freeze({ '+x': [1, 0, 0], '-x': [-1, 0, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] });
const DEFAULT_THRUST = 4;
const DEFAULT_RUDDER = 1;
const DEFAULT_KEEL_DRAG = 4;
// The rudder bites in proportion to the water flowing past it, full at this speed in m/s.
const RUDDER_REFERENCE_SPEED = 3;
// Thrust and rudder reach full strength once this fraction of the hull is under water (the float code counts 0.5 at the waterline).
const FULL_CONTACT_FRACTION = 0.25;

function normalizeControls(controls, label) {
  if (!Array.isArray(controls) || controls.length > BOAT_LIMITS.maxControls) {
    throw new RangeError(`${label} must be an array of at most ${BOAT_LIMITS.maxControls} keyframes { time, throttle, rudder }, such as [{ "time": 0, "throttle": 1, "rudder": 0 }]`);
  }
  let previousTime = -Infinity;
  return controls.map((key, index) => {
    const path = `${label}[${index}]`;
    rejectUnknownKeys(key, ['time', 'throttle', 'rudder'], path);
    const time = boundedNumber(key.time, `${path}.time`, 0, 1e6, 0);
    if (time <= previousTime) throw new RangeError(`${path}.time must be above the previous keyframe time ${previousTime}, such as ${previousTime + 1}`);
    previousTime = time;
    return {
      time,
      throttle: boundedNumber(key.throttle ?? 0, `${path}.throttle`, -1, 1, 1),
      rudder: boundedNumber(key.rudder ?? 0, `${path}.rudder`, -1, 1, 0),
    };
  });
}

function normalizeBoatWake(input, label) {
  const spec = input === true ? {} : input;
  rejectUnknownKeys(spec, WAKE_KEYS, label);
  return {
    width: boundedNumber(spec.width ?? 1.2, `${label}.width`, 0.05, 100, 1.2),
    strength: boundedNumber(spec.strength ?? 1, `${label}.strength`, 0, 1, 1),
    height: boundedNumber(spec.height ?? 0.06, `${label}.height`, 0, 2, 0.06),
    lifetime: boundedNumber(spec.lifetime ?? 5, `${label}.lifetime`, 0.5, 60, 5),
  };
}

/**
 * Validate the `boat` field of a floating body: `thrust` (m/s2 at full throttle, 4), `rudder` (m/s2 of sideways push at the stern at
 * full helm and 3 m/s, 1), `keelDrag` (1/s of sideways slip removed, 4), `stern` ([x, y, z] in body space, default the end of the hull),
 * `forward` ('-z', or +z, +x, -x: the bow in body space), `controls` (up to 256 keyframes { time, throttle, rudder } for a bake) and `wake`.
 */
export function normalizeBoat(input, label) {
  rejectUnknownKeys(input, BOAT_KEYS, label);
  const boat = {
    thrust: boundedNumber(input.thrust ?? DEFAULT_THRUST, `${label}.thrust`, 0, 100, DEFAULT_THRUST),
    rudder: boundedNumber(input.rudder ?? DEFAULT_RUDDER, `${label}.rudder`, 0, 100, DEFAULT_RUDDER),
    keelDrag: boundedNumber(input.keelDrag ?? DEFAULT_KEEL_DRAG, `${label}.keelDrag`, 0, 100, DEFAULT_KEEL_DRAG),
    forward: input.forward ?? '-z',
  };
  if (!Object.hasOwn(FORWARD_AXES, boat.forward)) {
    throw new RangeError(`${label}.forward must be one of ${Object.keys(FORWARD_AXES).join(', ')}, got ${String(input.forward)}`);
  }
  if (input.stern !== undefined) {
    if (!Array.isArray(input.stern) || input.stern.length !== 3) throw new TypeError(`${label}.stern must be [x, y, z] in body space, such as [0, 0, 1.9]`);
    boat.stern = input.stern.map((component, axis) => boundedNumber(component, `${label}.stern[${axis}]`, -1e6, 1e6, 0));
  }
  if (input.controls !== undefined) boat.controls = normalizeControls(input.controls, `${label}.controls`);
  if (input.wake !== undefined) boat.wake = normalizeBoatWake(input.wake, `${label}.wake`);
  return boat;
}

/** The boat of a floating body with its hull bounds known: the vectors, the default stern and the live controls. */
export function resolveBoat(boat, low, high) {
  const forward = FORWARD_AXES[boat.forward];
  const middle = low.map((value, axis) => (value + high[axis]) / 2);
  const stern = boat.stern ?? middle.map((value, axis) => (forward[axis] === 0 ? value : forward[axis] > 0 ? low[axis] : high[axis]));
  // right = forward x up, with up = [0, 1, 0]
  const right = [-forward[2], 0, forward[0]];
  return { ...boat, forward: [...forward], right, stern, live: { throttle: 0, rudder: 0, set: false } };
}

/** Set the controls a live controller holds: throttle and rudder from -1 to 1. Once set they replace the keyframes. */
export function setBoatControls(boat, controls, label = 'setBoatControls') {
  boat.live.throttle = boundedNumber(controls.throttle ?? 0, `${label} throttle`, -1, 1, 1);
  boat.live.rudder = boundedNumber(controls.rudder ?? 0, `${label} rudder`, -1, 1, 0);
  boat.live.set = true;
}

/** Throttle and rudder at a physics time: the live values when set, else the keyframes linearly, held after the last one. */
export function boatControlsAt(boat, time) {
  if (boat.live.set) return boat.live;
  const keys = boat.controls;
  if (!keys?.length) return boat.live;
  if (time <= keys[0].time) return keys[0];
  const last = keys[keys.length - 1];
  if (time >= last.time) return last;
  const after = keys.findIndex(key => key.time > time);
  const before = keys[after - 1];
  const fraction = (time - before.time) / (keys[after].time - before.time);
  return {
    throttle: before.throttle + (keys[after].throttle - before.throttle) * fraction,
    rudder: before.rudder + (keys[after].rudder - before.rudder) * fraction,
  };
}

function dot(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

/** Push a boat body for one step: thrust and rudder impulses at the stern, then keel drag on the sideways slip. */
export function applyBoatForces(body, boat, time, step, meanSubmerged) {
  const contact = Math.min(1, meanSubmerged / FULL_CONTACT_FRACTION);
  const controls = boatControlsAt(boat, time);
  const rotation = body.rotation();
  const translation = body.translation();
  const forward = rotateByQuaternion(boat.forward, rotation);
  const right = rotateByQuaternion(boat.right, rotation);
  const sternOffset = rotateByQuaternion(boat.stern, rotation);
  const before = body.linvel();
  const forwardSpeed = dot([before.x, before.y, before.z], forward);
  const mass = body.mass();
  const thrust = controls.throttle * boat.thrust * mass * contact * step;
  // A force at the stern toward the left of the bow turns the bow to the right.
  const steerAuthority = Math.max(-1, Math.min(1, forwardSpeed / RUDDER_REFERENCE_SPEED));
  const push = -controls.rudder * boat.rudder * steerAuthority * mass * contact * step;
  if (thrust !== 0 || push !== 0) {
    body.applyImpulseAtPoint(
      { x: forward[0] * thrust + right[0] * push, y: forward[1] * thrust + right[1] * push, z: forward[2] * thrust + right[2] * push },
      { x: translation.x + sternOffset[0], y: translation.y + sternOffset[1], z: translation.z + sternOffset[2] },
      true,
    );
  }
  const velocity = body.linvel();
  const slip = dot([velocity.x, velocity.y, velocity.z], right);
  const removed = slip * (1 - Math.exp(-boat.keelDrag * contact * step));
  body.setLinvel({ x: velocity.x - right[0] * removed, y: velocity.y - right[1] * removed, z: velocity.z - right[2] * removed }, true);
}
