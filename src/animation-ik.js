// IK hooks for the animation graph: ready-made solver definitions for the `ik` list of createSkeletonPose / createAssetPose.
// Both read the live game through a function and ease toward what they read, using the pose time and no clock, so the same
// sequence of times gives the same pose. `createFootPlacement` keeps a planted foot on uneven ground; `createLookAt` turns a
// head or a chain of bones toward a point.

const SMOOTH_SNAP_SECONDS = 1;

function numberIn(owner, label, value, fallback, minimum, maximum) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${owner} ${label} must be a number from ${minimum} to ${maximum}, got ${String(resolved)}.`);
  }
  return resolved;
}

// Exponential approach with a time constant, driven by the pose time. The first call, a jump back in time and a long gap snap to the goal.
function createSmoother(smoothSeconds) {
  let lastTime = null;
  return function amount(time) {
    const elapsed = lastTime === null ? Infinity : time - lastTime;
    if (elapsed === 0) return 0;
    lastTime = time;
    if (smoothSeconds === 0 || elapsed < 0 || elapsed > SMOOTH_SNAP_SECONDS) return 1;
    return 1 - Math.exp(-elapsed / smoothSeconds);
  };
}

/**
 * A two-bone solver that keeps a planted foot on uneven ground. `groundOffset(footPosition)` says how far the ground under
 * that foot sits above (positive) or below the ground the clip was made for, in the pose's units; it receives the animated
 * foot position and returns a number. Only a foot near the ground follows it: the correction fades out over `liftHeight`
 * above `ankleHeight`, so a swinging foot is not pulled down. The correction is limited to `maxAdjust` and eased over
 * `smoothSeconds`. Pass the result in the `ik` list of the pose; give `weight` a function to fade it with a graph parameter.
 */
export function createFootPlacement(options = {}) {
  const owner = 'createFootPlacement';
  for (const [field, role] of [['root', 'hip'], ['middle', 'knee'], ['end', 'ankle']]) {
    if (options[field] === undefined) throw new TypeError(`${owner} needs ${field}: the joint name of the leg's ${role}.`);
  }
  const { groundOffset } = options;
  if (typeof groundOffset !== 'function') {
    throw new TypeError(`${owner} groundOffset must be a function (footPosition) => ground height change in metres, such as foot => terrain(foot[0], foot[2]) - baseHeight, got ${groundOffset === null ? 'null' : typeof groundOffset}.`);
  }
  const ankleHeight = numberIn(owner, 'ankleHeight', options.ankleHeight, 0, -1000, 1000);
  const liftHeight = numberIn(owner, 'liftHeight', options.liftHeight, 0.15, 1e-6, 1000);
  const maxAdjust = numberIn(owner, 'maxAdjust', options.maxAdjust, 0.4, 0, 1000);
  const smoothSeconds = numberIn(owner, 'smoothSeconds', options.smoothSeconds, 0.06, 0, 10);
  const smoothingAmount = createSmoother(smoothSeconds);
  let correction = 0;

  function target(time, foot) {
    const offset = groundOffset([foot[0], foot[1], foot[2]]);
    if (!Number.isFinite(offset)) throw new RangeError(`${owner} groundOffset must return a finite number, got ${String(offset)}.`);
    const clamped = Math.max(-maxAdjust, Math.min(maxAdjust, offset));
    const lift = Math.min(1, Math.max(0, (foot[1] - ankleHeight) / liftHeight));
    const planted = 1 - lift * lift * (3 - 2 * lift);
    correction += (clamped * planted - correction) * smoothingAmount(time);
    return [foot[0], foot[1] + correction, foot[2]];
  }

  const solver = { type: 'two-bone', root: options.root, middle: options.middle, end: options.end, target, weight: options.weight ?? 1 };
  for (const field of ['pole', 'bendToward', 'groundNormal', 'limits', 'keepEndRotation']) {
    if (options[field] !== undefined) solver[field] = options[field];
  }
  return solver;
}

/**
 * An aim solver that turns `joints` (listed from the base of the chain to the aiming joint, such as ['neck', 'head']) toward
 * `target`, a point [x, y, z] or a function (time, current) => point. The turn stops at `maxAngle` degrees from the rest
 * direction and the target is eased over `smoothSeconds`. `forward` is the aiming joint's own forward axis, or give
 * `worldForward` for the way the character faces at rest.
 */
export function createLookAt(options = {}) {
  const owner = 'createLookAt';
  if (!Array.isArray(options.joints) || options.joints.length === 0) {
    throw new TypeError(`${owner} needs joints: bone names from the base of the chain to the aiming joint, such as ["neck", "head"].`);
  }
  const isPoint = Array.isArray(options.target) && options.target.length === 3 && options.target.every(Number.isFinite);
  if (!isPoint && typeof options.target !== 'function') {
    throw new TypeError(`${owner} target must be a point [x, y, z] or a function (time, current) => [x, y, z].`);
  }
  const maxAngle = numberIn(owner, 'maxAngle', options.maxAngle, 70, 1e-6, 180);
  const smoothSeconds = numberIn(owner, 'smoothSeconds', options.smoothSeconds, 0.1, 0, 10);
  const smoothingAmount = createSmoother(smoothSeconds);
  const smoothed = [0, 0, 0];

  function target(time, current) {
    const goal = isPoint ? options.target : options.target(time, current);
    if (!Array.isArray(goal) || goal.length !== 3 || !goal.every(Number.isFinite)) {
      throw new RangeError(`${owner} target must return three finite numbers, got ${JSON.stringify(goal)}.`);
    }
    const amount = smoothingAmount(time);
    for (let axis = 0; axis < 3; axis++) smoothed[axis] += (goal[axis] - smoothed[axis]) * amount;
    return [smoothed[0], smoothed[1], smoothed[2]];
  }

  const solver = { type: 'aim', joints: options.joints, maxAngle, target, weight: options.weight ?? 1 };
  if (options.forward !== undefined) solver.forward = options.forward;
  if (options.worldForward !== undefined) solver.worldForward = options.worldForward;
  return solver;
}
