// Player layer for live games: controllers and camera rigs as runtime systems. A controller reads named input actions and
// axes (src/input.js) and moves a body; a camera rig reads the body it follows and places the camera. Both are plain runtime
// systems, so runtime.replaceSystem swaps them while the game runs. Motion is deterministic: the same input sequence over the
// same fixed steps gives the same positions. The collide-and-slide here is kinematic; a physics engine plugs in through
// options.mover (see docs/player.md). Yaw 0 faces -Z, positive yaw turns toward +X, positive pitch looks up.

export const PLAYER_LIMITS = Object.freeze({
  maximumSpeed: 100,
  maximumAcceleration: 1000,
  maximumGravity: 200,
  maximumRadius: 10,
  maximumHeight: 20,
  maximumObstacles: 256,
  maximumDistance: 10000,
  maximumSubsteps: 64,
  maximumPitch: 1.5,
});

const WORLD_UP = [0, 1, 0];

function describe(value) {
  return value === null ? 'null' : typeof value;
}

function numberOption(owner, label, value, fallback, minimum, maximum) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${owner} ${label} must be a number from ${minimum} to ${maximum}, got ${String(resolved)}.`);
  }
  return resolved;
}

function vectorOption(owner, label, value, fallback) {
  const resolved = value ?? fallback;
  const limit = PLAYER_LIMITS.maximumDistance;
  if (!Array.isArray(resolved) || resolved.length !== 3 || !resolved.every(entry => Number.isFinite(entry) && Math.abs(entry) <= limit)) {
    throw new TypeError(`${owner} ${label} must be an array of 3 finite numbers within ${limit}, such as [0, 0, 0], got ${JSON.stringify(resolved)}.`);
  }
  return [...resolved];
}

function requireInput(owner, input) {
  const hasInterface = input !== null && typeof input === 'object'
    && ['getAxis', 'isHeld', 'wasPressed'].every(method => typeof input[method] === 'function');
  if (!hasInterface) {
    throw new TypeError(`${owner} needs options.input: the object from createInput() with getAxis, isHeld and wasPressed, got ${describe(input)}.`);
  }
  return input;
}

function forwardDirection(yaw) {
  return [Math.sin(yaw), 0, -Math.cos(yaw)];
}

function rightDirection(yaw) {
  return [Math.cos(yaw), 0, Math.sin(yaw)];
}

function wrapAngle(angle) {
  const wrapped = (angle + Math.PI) % (2 * Math.PI);
  return (wrapped < 0 ? wrapped + 2 * Math.PI : wrapped) - Math.PI;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function blend(from, to, amount) {
  return from.map((value, index) => value + (to[index] - value) * amount);
}

function validateObstacles(obstacles) {
  if (!Array.isArray(obstacles) || obstacles.length > PLAYER_LIMITS.maximumObstacles) {
    throw new RangeError(`createKinematicMover obstacles must be an array of at most ${PLAYER_LIMITS.maximumObstacles} boxes like { min: [x, y, z], max: [x, y, z] }.`);
  }
  return obstacles.map((box, index) => {
    const label = `obstacles[${index}]`;
    const min = vectorOption('createKinematicMover', `${label}.min`, box?.min);
    const max = vectorOption('createKinematicMover', `${label}.max`, box?.max);
    if (min.some((value, axis) => value > max[axis])) {
      throw new RangeError(`createKinematicMover ${label} min must not exceed max on any axis, got min ${JSON.stringify(min)} and max ${JSON.stringify(max)}.`);
    }
    return { min, max };
  });
}

// Kinematic world for a character: a ground (a height, or a heightfield function (x, z) => height) plus static boxes.
// move(body, displacement) slides along walls by resolving x and z one after the other, climbs anything up to body.stepHeight,
// snaps down short drops and reports grounded. Replace it with options.mover on a controller to use physics instead.
export function createKinematicMover(options = {}) {
  const ground = options.ground ?? 0;
  if (typeof ground !== 'function' && !Number.isFinite(ground)) {
    throw new TypeError(`createKinematicMover ground must be a height number or a function (x, z) => height, got ${describe(ground)}.`);
  }
  const obstacles = validateObstacles(options.obstacles ?? []);

  function groundHeight(x, z) {
    const height = typeof ground === 'function' ? ground(x, z) : ground;
    if (!Number.isFinite(height)) {
      throw new RangeError(`createKinematicMover ground(${x}, ${z}) must return a finite height, got ${String(height)}.`);
    }
    return height;
  }

  // Highest surface under a body of `radius` at (x, z) that starts within reach of its feet.
  function surfaceHeight(x, z, radius, feetY, reach) {
    let height = groundHeight(x, z);
    for (const { min, max } of obstacles) {
      const covers = x >= min[0] - radius && x <= max[0] + radius && z >= min[2] - radius && z <= max[2] + radius;
      if (covers && min[1] <= feetY + reach) height = Math.max(height, max[1]);
    }
    return height;
  }

  function move(body, displacement) {
    const [startX, startY, startZ] = body.position;
    const { radius, stepHeight } = body;
    const horizontalDistance = Math.hypot(displacement[0], displacement[2]);
    const substeps = clamp(Math.ceil(horizontalDistance / radius), 1, PLAYER_LIMITS.maximumSubsteps);
    let x = startX;
    let z = startZ;
    for (let index = 0; index < substeps; index += 1) {
      const nextX = x + displacement[0] / substeps;
      if (surfaceHeight(nextX, z, radius, startY, stepHeight) <= startY + stepHeight) x = nextX;
      const nextZ = z + displacement[2] / substeps;
      if (surfaceHeight(x, nextZ, radius, startY, stepHeight) <= startY + stepHeight) z = nextZ;
    }
    const surface = surfaceHeight(x, z, radius, startY, stepHeight);
    const wantedY = startY + displacement[1];
    if (wantedY <= surface) return { position: [x, surface, z], grounded: true };
    const canSnapDown = body.grounded && displacement[1] <= 0 && wantedY - surface <= stepHeight;
    if (canSnapDown) return { position: [x, surface, z], grounded: true };
    return { position: [x, wantedY, z], grounded: false };
  }

  return { move, groundHeight };
}

function validateMover(owner, mover) {
  if (mover === null || typeof mover !== 'object' || typeof mover.move !== 'function') {
    throw new TypeError(`${owner} mover must be an object with move(body, displacement, stepSeconds) => { position, grounded }, such as createKinematicMover(), got ${describe(mover)}.`);
  }
  return mover;
}

function readMoveResult(owner, result) {
  const validPosition = Array.isArray(result?.position) && result.position.length === 3 && result.position.every(Number.isFinite);
  if (!validPosition || typeof result.grounded !== 'boolean') {
    throw new TypeError(`${owner} mover.move must return { position: [x, y, z], grounded: boolean }, got ${JSON.stringify(result)}.`);
  }
  return result;
}

// Character controller: walk, run and jump with acceleration, air control and ground snap. Put it after the input system and
// before any camera rig. Name defaults to "player"; replaceSystem("player", other) swaps it.
export function createCharacterController(options = {}) {
  const owner = 'createCharacterController';
  const input = requireInput(owner, options.input);
  const mover = validateMover(owner, options.mover ?? createKinematicMover({ ground: options.ground, obstacles: options.obstacles }));
  const settings = {
    walkSpeed: numberOption(owner, 'walkSpeed', options.walkSpeed, 3, 0, PLAYER_LIMITS.maximumSpeed),
    runSpeed: numberOption(owner, 'runSpeed', options.runSpeed, 6, 0, PLAYER_LIMITS.maximumSpeed),
    jumpSpeed: numberOption(owner, 'jumpSpeed', options.jumpSpeed, 7, 0, PLAYER_LIMITS.maximumSpeed),
    gravity: numberOption(owner, 'gravity', options.gravity, 20, 0, PLAYER_LIMITS.maximumGravity),
    acceleration: numberOption(owner, 'acceleration', options.acceleration, 40, 0.01, PLAYER_LIMITS.maximumAcceleration),
    airControl: numberOption(owner, 'airControl', options.airControl, 0.3, 0, 1),
    turnSpeed: numberOption(owner, 'turnSpeed', options.turnSpeed, 12, 0, 100),
    radius: numberOption(owner, 'radius', options.radius, 0.4, 0.01, PLAYER_LIMITS.maximumRadius),
    height: numberOption(owner, 'height', options.height, 1.8, 0.01, PLAYER_LIMITS.maximumHeight),
    stepHeight: numberOption(owner, 'stepHeight', options.stepHeight, 0.4, 0, PLAYER_LIMITS.maximumHeight),
  };
  const names = {
    moveX: options.moveX ?? 'moveX',
    moveForward: options.moveForward ?? 'moveForward',
    jump: options.jump ?? 'jump',
    run: options.run ?? 'run',
  };
  const rootMotion = options.rootMotion;
  if (rootMotion !== undefined && typeof rootMotion !== 'function') {
    throw new TypeError(`${owner} rootMotion must be a function () => [x, z] giving the travel of the last animation step, such as () => graph.rootMotion.delta, got ${describe(rootMotion)}.`);
  }
  const faceCamera = options.faceCamera ?? false;
  const cameraYaw = options.cameraYaw ?? 0;
  if (typeof cameraYaw !== 'function' && !Number.isFinite(cameraYaw)) {
    throw new TypeError(`${owner} cameraYaw must be a yaw in radians or a function returning one, such as () => rig.yaw, got ${describe(cameraYaw)}.`);
  }
  const node = validateNode(owner, options.node);

  const startPosition = vectorOption(owner, 'position', options.position, [0, 0, 0]);
  const state = {
    position: startPosition,
    previousPosition: [...startPosition],
    velocity: [0, 0, 0],
    yaw: numberOption(owner, 'yaw', options.yaw, 0, -1000, 1000),
    grounded: false,
    airborne: true,
    speed: 0,
    intentSpeed: 0,
    running: false,
  };

  function writeNode() {
    writeNodePose(node, state.position, state.yaw);
  }

  function currentCameraYaw() {
    const yaw = typeof cameraYaw === 'function' ? cameraYaw() : cameraYaw;
    if (!Number.isFinite(yaw)) throw new TypeError(`${owner} cameraYaw must give a finite number of radians, got ${String(yaw)}.`);
    return yaw;
  }

  function turnToward(targetYaw, stepSeconds) {
    const difference = wrapAngle(targetYaw - state.yaw);
    const maximumTurn = settings.turnSpeed * stepSeconds;
    state.yaw = wrapAngle(state.yaw + clamp(difference, -maximumTurn, maximumTurn));
  }

  // On the ground the animation moves the body: its travel, turned from the body's frame to the world, replaces the speed-based step.
  function applyRootMotion(displacement) {
    const travel = rootMotion();
    const valid = Array.isArray(travel) && travel.length === 2 && travel.every(Number.isFinite);
    if (!valid) throw new TypeError(`${owner} rootMotion must return [x, z] as finite numbers, such as graph.rootMotion.delta, got ${JSON.stringify(travel)}.`);
    const forward = forwardDirection(state.yaw);
    const right = rightDirection(state.yaw);
    displacement[0] = right[0] * travel[0] - forward[0] * travel[1];
    displacement[2] = right[2] * travel[0] - forward[2] * travel[1];
  }

  function advance(stepSeconds) {
    if (!(stepSeconds > 0)) return;
    state.previousPosition = [...state.position];
    const sideInput = input.getAxis(names.moveX);
    const forwardInput = input.getAxis(names.moveForward);
    const intentLength = Math.min(1, Math.hypot(sideInput, forwardInput));
    const intentScale = intentLength > 0 ? intentLength / Math.hypot(sideInput, forwardInput) : 0;
    const viewYaw = currentCameraYaw();
    const forward = forwardDirection(viewYaw);
    const right = rightDirection(viewYaw);
    state.running = input.isHeld(names.run);
    const topSpeed = state.running ? settings.runSpeed : settings.walkSpeed;
    const wantedX = (forward[0] * forwardInput + right[0] * sideInput) * intentScale * topSpeed;
    const wantedZ = (forward[2] * forwardInput + right[2] * sideInput) * intentScale * topSpeed;

    state.intentSpeed = Math.hypot(wantedX, wantedZ);
    const control = state.grounded ? 1 : settings.airControl;
    const maximumChange = settings.acceleration * control * stepSeconds;
    const changeX = wantedX - state.velocity[0];
    const changeZ = wantedZ - state.velocity[2];
    const changeLength = Math.hypot(changeX, changeZ);
    const changeScale = changeLength > maximumChange ? maximumChange / changeLength : 1;
    state.velocity[0] += changeX * changeScale;
    state.velocity[2] += changeZ * changeScale;

    if (faceCamera) turnToward(viewYaw, stepSeconds);
    else if (intentLength > 0.1) turnToward(Math.atan2(wantedX, -wantedZ), stepSeconds);

    if (state.grounded && input.wasPressed(names.jump)) {
      state.velocity[1] = settings.jumpSpeed;
      state.grounded = false;
    }
    state.velocity[1] = Math.max(-PLAYER_LIMITS.maximumSpeed, state.velocity[1] - settings.gravity * stepSeconds);

    const body = {
      position: [...state.position],
      velocity: [...state.velocity],
      radius: settings.radius,
      height: settings.height,
      stepHeight: settings.stepHeight,
      grounded: state.grounded,
    };
    const displacement = state.velocity.map(component => component * stepSeconds);
    if (rootMotion && state.grounded) applyRootMotion(displacement);
    const result = readMoveResult(owner, mover.move(body, displacement, stepSeconds));
    state.velocity[0] = (result.position[0] - state.position[0]) / stepSeconds;
    state.velocity[2] = (result.position[2] - state.position[2]) / stepSeconds;
    if (result.grounded && state.velocity[1] <= 0) state.velocity[1] = 0;
    state.position = [...result.position];
    state.grounded = result.grounded;
    state.airborne = !result.grounded;
    state.speed = Math.hypot(state.velocity[0], state.velocity[2]);
    writeNode();
  }

  const controller = {
    name: options.name ?? 'player',
    kind: 'character',
    state,
    // Position drawn between the last two fixed steps; alpha is context.alpha.
    positionAt: alpha => blend(state.previousPosition, state.position, alpha),
    teleport(position, yaw = state.yaw) {
      state.position = vectorOption(owner, 'teleport position', position);
      state.previousPosition = [...state.position];
      state.velocity = [0, 0, 0];
      state.yaw = numberOption(owner, 'teleport yaw', yaw, 0, -1000, 1000);
      state.grounded = false;
      state.airborne = true;
      writeNode();
      return controller;
    },
    init: writeNode,
    fixedUpdate: advance,
    update(deltaSeconds, context) {
      if (context?.mode === 'variable') advance(deltaSeconds);
    },
  };
  return controller;
}

const RIG_KINDS = Object.freeze({
  follow: { pitch: 0.35, minimumPitch: -0.2, maximumPitch: 1.3, distance: 5, lookHeight: 1.5, followSeconds: 0.12, lookAxes: true },
  firstPerson: { pitch: 0, minimumPitch: -1.4, maximumPitch: 1.4, eyeHeight: 1.6, followSeconds: 0, lookAxes: true },
  topDown: { pitch: 1.2, minimumPitch: 0.5, maximumPitch: 1.5, distance: 12, lookHeight: 0, followSeconds: 0.2, lookAxes: false },
  orbit: { pitch: 0.4, minimumPitch: -1.4, maximumPitch: 1.4, distance: 6, lookHeight: 1, followSeconds: 0.05, lookAxes: true },
  chase: { pitch: 0.25, minimumPitch: -0.2, maximumPitch: 1.3, distance: 7, lookHeight: 1.2, followSeconds: 0.1, lookAxes: false, yawFollowSeconds: 0.3 },
  sideScroller: { pitch: 0, minimumPitch: 0, maximumPitch: 0, distance: 10, lookHeight: 1, followSeconds: 0.25, lookAxes: false, lookAhead: 2 },
});

function placeCamera(kind, rig, focus) {
  const yaw = rig.yaw;
  const pitch = rig.pitch;
  if (kind === 'firstPerson') {
    const eye = [focus[0], focus[1] + rig.eyeHeight, focus[2]];
    const horizontal = Math.cos(pitch);
    const look = [Math.sin(yaw) * horizontal, Math.sin(pitch), -Math.cos(yaw) * horizontal];
    return { eye, target: eye.map((value, axis) => value + look[axis]) };
  }
  if (kind === 'sideScroller') {
    const sideTarget = [focus[0], focus[1] + rig.lookHeight, focus[2]];
    return { eye: [sideTarget[0], sideTarget[1], sideTarget[2] + rig.distance], target: sideTarget };
  }
  // follow, topDown, orbit and chase orbit the focus point at `distance`; pitch is how far above the horizon the camera sits.
  const target = [focus[0], focus[1] + rig.lookHeight, focus[2]];
  const forward = forwardDirection(yaw);
  const behind = rig.distance * Math.cos(pitch);
  const eye = [target[0] - forward[0] * behind, target[1] + rig.distance * Math.sin(pitch), target[2] - forward[2] * behind];
  return { eye: rig.clipEye ? rig.clipEye(target, eye) : eye, target };
}

function createCameraRig(kind, options) {
  const owner = `create${kind[0].toUpperCase()}${kind.slice(1)}Camera`;
  const defaults = RIG_KINDS[kind];
  const subject = options.subject;
  if (subject === null || typeof subject !== 'object' || !Array.isArray(subject.position)) {
    throw new TypeError(`${owner} needs options.subject: a controller's state (controller.state) or any { position: [x, y, z], yaw }, got ${describe(subject)}.`);
  }
  if (options.clipEye !== undefined && typeof options.clipEye !== 'function') {
    throw new TypeError(`${owner} clipEye must be a function (target, eye) => eye, or left out, got ${describe(options.clipEye)}.`);
  }
  const lookNames = defaults.lookAxes ? { x: options.lookX ?? 'lookX', y: options.lookY ?? 'lookY' } : { x: options.lookX, y: options.lookY };
  const wantsLook = lookNames.x !== null && lookNames.x !== undefined;
  const input = wantsLook || lookNames.y || options.zoom ? requireInput(owner, options.input) : options.input;
  const minimumPitch = numberOption(owner, 'minimumPitch', options.minimumPitch, defaults.minimumPitch, -PLAYER_LIMITS.maximumPitch, PLAYER_LIMITS.maximumPitch);
  const maximumPitch = numberOption(owner, 'maximumPitch', options.maximumPitch, defaults.maximumPitch, minimumPitch, PLAYER_LIMITS.maximumPitch);
  const lookSpeed = numberOption(owner, 'lookSpeed', options.lookSpeed, 2.5, 0, 100);
  const followSeconds = numberOption(owner, 'followSeconds', options.followSeconds, defaults.followSeconds, 0, 10);
  const yawFollowSeconds = numberOption(owner, 'yawFollowSeconds', options.yawFollowSeconds, defaults.yawFollowSeconds ?? 0, 0, 10);
  const zoomName = options.zoom ?? null;
  const minimumDistance = numberOption(owner, 'minimumDistance', options.minimumDistance, 1, 0.1, PLAYER_LIMITS.maximumDistance);
  const maximumDistance = numberOption(owner, 'maximumDistance', options.maximumDistance, 50, minimumDistance, PLAYER_LIMITS.maximumDistance);
  const zoomSpeed = numberOption(owner, 'zoomSpeed', options.zoomSpeed, 8, 0, 1000);
  const rig = {
    name: options.name ?? 'camera',
    kind,
    subject,
    yaw: numberOption(owner, 'yaw', options.yaw, subject.yaw ?? 0, -1000, 1000),
    pitch: clamp(numberOption(owner, 'pitch', options.pitch, defaults.pitch, -PLAYER_LIMITS.maximumPitch, PLAYER_LIMITS.maximumPitch), minimumPitch, maximumPitch),
    distance: numberOption(owner, 'distance', options.distance, defaults.distance ?? 0, defaults.distance === undefined ? 0 : 0.1, PLAYER_LIMITS.maximumDistance),
    lookHeight: numberOption(owner, 'lookHeight', options.lookHeight, defaults.lookHeight ?? 0, -PLAYER_LIMITS.maximumHeight, PLAYER_LIMITS.maximumHeight),
    eyeHeight: numberOption(owner, 'eyeHeight', options.eyeHeight, defaults.eyeHeight ?? 0, 0, PLAYER_LIMITS.maximumHeight),
    clipEye: options.clipEye,
    lookAhead: numberOption(owner, 'lookAhead', options.lookAhead, defaults.lookAhead ?? 0, 0, PLAYER_LIMITS.maximumDistance),
    focus: [...subject.position],
    previousFocus: [...subject.position],
  };

  function advance(stepSeconds) {
    if (wantsLook) {
      rig.yaw = wrapAngle(rig.yaw + input.getAxis(lookNames.x) * lookSpeed * stepSeconds);
    }
    if (lookNames.y) {
      rig.pitch = clamp(rig.pitch + input.getAxis(lookNames.y) * lookSpeed * stepSeconds, minimumPitch, maximumPitch);
    }
    if (zoomName !== null) {
      rig.distance = clamp(rig.distance - input.getAxis(zoomName) * zoomSpeed * stepSeconds, minimumDistance, maximumDistance);
    }
    if (yawFollowSeconds > 0) {
      const yawAmount = 1 - Math.exp(-stepSeconds / yawFollowSeconds);
      rig.yaw = wrapAngle(rig.yaw + wrapAngle((rig.subject.yaw ?? rig.yaw) - rig.yaw) * yawAmount);
    }
    rig.previousFocus = rig.focus;
    const amount = followSeconds === 0 ? 1 : 1 - Math.exp(-stepSeconds / followSeconds);
    rig.focus = blend(rig.focus, focusGoal(), amount);
  }

  // A side scroller leads the subject along its horizontal velocity so the view shows where it is heading.
  function focusGoal() {
    const goal = rig.subject.position;
    if (kind !== 'sideScroller' || rig.lookAhead === 0) return goal;
    const sideSpeed = rig.subject.velocity?.[0] ?? 0;
    return [goal[0] + rig.lookAhead * clamp(sideSpeed / 5, -1, 1), goal[1], goal[2]];
  }

  rig.init = () => {
    rig.focus = [...focusGoal()];
    rig.previousFocus = [...rig.focus];
  };
  rig.fixedUpdate = advance;
  rig.update = (deltaSeconds, context) => {
    if (context?.mode === 'variable') advance(deltaSeconds);
  };
  // The camera for one frame: { eye, target, up }, ready to merge into the frame passed to render. Pass the runtime context.
  rig.pose = context => {
    const focus = blend(rig.previousFocus, rig.focus, context?.alpha ?? 1);
    return { ...placeCamera(kind, rig, focus), up: WORLD_UP };
  };
  return rig;
}

// Third-person follow camera: orbits behind the subject, turns with the look axes and eases toward it (followSeconds).
// options.clipEye(target, eye) => eye is the seam for collision pull-in against a world.
export function createFollowCamera(options = {}) {
  return createCameraRig('follow', options);
}

// First-person camera at the subject's eye height, looking where yaw and pitch point.
export function createFirstPersonCamera(options = {}) {
  return createCameraRig('firstPerson', options);
}

// Top-down camera high above the subject at a steep fixed pitch. It does not turn unless lookX is named.
export function createTopDownCamera(options = {}) {
  return createCameraRig('topDown', options);
}

// Orbit camera: free look around the subject; name a `zoom` axis to change the distance between minimumDistance and maximumDistance.
export function createOrbitCamera(options = {}) {
  return createCameraRig('orbit', options);
}

// Chase camera: sits behind the subject and swings round to its yaw (yawFollowSeconds), for vehicles and flyers.
export function createChaseCamera(options = {}) {
  return createCameraRig('chase', options);
}

// Side-scroller camera: looks along -Z from `distance` away and leads the subject by `lookAhead` units along its horizontal velocity.
export function createSideScrollerCamera(options = {}) {
  return createCameraRig('sideScroller', options);
}

// A clipEye for any orbiting rig: pulls the camera in along the line from its target so the eye stays `padding` outside every
// obstacle box and above the ground, and so never shows the inside of a wall.
const FALLBACK_GROUND_HEIGHT = 0;

export function createCameraClip(options = {}) {
  const owner = 'createCameraClip';
  const padding = numberOption(owner, 'padding', options.padding, 0.25, 0, 10);
  const boxes = validateObstacles(options.obstacles ?? []).map(({ min, max }) => ({
    min: min.map(value => value - padding),
    max: max.map(value => value + padding),
  }));
  const ground = options.ground ?? 0;
  if (typeof ground !== 'function' && !Number.isFinite(ground)) {
    throw new TypeError(`${owner} ground must be a height number or a function (x, z) => height, got ${describe(ground)}.`);
  }
  // A ground function that returns NaN or Infinity would make every comparison false and silently turn clipping off.
  const groundHeight = (x, z) => {
    const height = typeof ground === 'function' ? ground(x, z) : ground;
    return Number.isFinite(height) ? height : FALLBACK_GROUND_HEIGHT;
  };

  // Fraction of the segment target -> eye that is free of the padded box (1 when it never enters it).
  function freeFraction(target, offset, box) {
    let entry = 0;
    let exit = 1;
    for (let axis = 0; axis < 3; axis += 1) {
      if (offset[axis] === 0) {
        if (target[axis] < box.min[axis] || target[axis] > box.max[axis]) return 1;
        continue;
      }
      const first = (box.min[axis] - target[axis]) / offset[axis];
      const second = (box.max[axis] - target[axis]) / offset[axis];
      entry = Math.max(entry, Math.min(first, second));
      exit = Math.min(exit, Math.max(first, second));
    }
    return entry > exit || exit < 0 ? 1 : entry;
  }

  function underGround(target, offset, fraction) {
    const x = target[0] + offset[0] * fraction;
    const z = target[2] + offset[2] * fraction;
    return target[1] + offset[1] * fraction < groundHeight(x, z) + padding;
  }

  return function clipEye(target, eye) {
    const offset = eye.map((value, axis) => value - target[axis]);
    let fraction = 1;
    for (const box of boxes) fraction = Math.min(fraction, freeFraction(target, offset, box));
    const samples = 24;
    for (let sample = 1; sample <= samples; sample += 1) {
      const sampleFraction = (fraction * sample) / samples;
      if (!underGround(target, offset, sampleFraction)) continue;
      let low = (fraction * (sample - 1)) / samples;
      let high = sampleFraction;
      for (let round = 0; round < 8; round += 1) {
        const middle = (low + high) / 2;
        if (underGround(target, offset, middle)) high = middle;
        else low = middle;
      }
      fraction = low;
      break;
    }
    return target.map((value, axis) => value + offset[axis] * fraction);
  };
}

function validateNode(owner, node) {
  if (node !== undefined && (node === null || typeof node !== 'object' || !Array.isArray(node.position))) {
    throw new TypeError(`${owner} node must be an object with a position array, such as { position: [0, 0, 0] }, got ${describe(node)}.`);
  }
  return node;
}

function writeNodePose(node, position, yaw) {
  if (!node) return;
  node.position[0] = position[0];
  node.position[1] = position[1];
  node.position[2] = position[2];
  if ('rotationY' in node) node.rotationY = -yaw;
}

// Runtime-system shell shared by the vehicle and flight controllers.
function finishController(parts) {
  const { state, writeNode, advance, teleport } = parts;
  const controller = {
    name: parts.name,
    kind: parts.kind,
    state,
    positionAt: alpha => blend(state.previousPosition, state.position, alpha),
    teleport(position, yaw) {
      teleport(position, yaw);
      writeNode();
      return controller;
    },
    init: writeNode,
    fixedUpdate: advance,
    update(deltaSeconds, context) {
      if (context?.mode !== 'variable' || !(deltaSeconds > 0)) return;
      advance(deltaSeconds);
    },
  };
  return controller;
}

function vehicleSettings(owner, options) {
  const speedLimit = PLAYER_LIMITS.maximumSpeed;
  const accelerationLimit = PLAYER_LIMITS.maximumAcceleration;
  return {
    maximumSpeed: numberOption(owner, 'maximumSpeed', options.maximumSpeed, 20, 0, speedLimit),
    reverseSpeed: numberOption(owner, 'reverseSpeed', options.reverseSpeed, 6, 0, speedLimit),
    acceleration: numberOption(owner, 'acceleration', options.acceleration, 12, 0.01, accelerationLimit),
    brakeDeceleration: numberOption(owner, 'brakeDeceleration', options.brakeDeceleration, 25, 0.01, accelerationLimit),
    coastDeceleration: numberOption(owner, 'coastDeceleration', options.coastDeceleration, 4, 0, accelerationLimit),
    wheelbase: numberOption(owner, 'wheelbase', options.wheelbase, 2.5, 0.1, PLAYER_LIMITS.maximumRadius),
    maximumSteer: numberOption(owner, 'maximumSteer', options.maximumSteer, 0.6, 0.01, 1.4),
    steerSeconds: numberOption(owner, 'steerSeconds', options.steerSeconds, 0.15, 0.001, 10),
    gravity: numberOption(owner, 'gravity', options.gravity, 20, 0, PLAYER_LIMITS.maximumGravity),
    radius: numberOption(owner, 'radius', options.radius, 1, 0.01, PLAYER_LIMITS.maximumRadius),
    height: numberOption(owner, 'height', options.height, 1.5, 0.01, PLAYER_LIMITS.maximumHeight),
    stepHeight: numberOption(owner, 'stepHeight', options.stepHeight, 0.4, 0, PLAYER_LIMITS.maximumHeight),
  };
}

// Arcade car: throttle axis (moveForward), steer axis (moveX) and a brake action (jump). Steering follows a bicycle model, so the yaw
// rate is speed / wheelbase * tan(steer). The same mover seam as the character controller keeps it on the ground and off the walls.
// state.steer runs -1..1 and state.forwardSpeed is signed, for wheel and engine animation (createVehicleRig) and audio.
export function createVehicleController(options = {}) {
  const owner = 'createVehicleController';
  const input = requireInput(owner, options.input);
  const mover = validateMover(owner, options.mover ?? createKinematicMover({ ground: options.ground, obstacles: options.obstacles }));
  const settings = vehicleSettings(owner, options);
  const names = { steer: options.steer ?? 'moveX', throttle: options.throttle ?? 'moveForward', brake: options.brake ?? 'jump' };
  const node = validateNode(owner, options.node);
  const startPosition = vectorOption(owner, 'position', options.position, [0, 0, 0]);
  const state = {
    position: startPosition,
    previousPosition: [...startPosition],
    velocity: [0, 0, 0],
    yaw: numberOption(owner, 'yaw', options.yaw, 0, -1000, 1000),
    forwardSpeed: 0,
    speed: 0,
    steer: 0,
    grounded: false,
    airborne: true,
    braking: false,
  };

  function writeNode() {
    writeNodePose(node, state.position, state.yaw);
  }

  function approachSpeed(target, rate, stepSeconds) {
    const maximumChange = rate * stepSeconds;
    state.forwardSpeed += clamp(target - state.forwardSpeed, -maximumChange, maximumChange);
  }

  function updateSpeed(throttle, stepSeconds) {
    state.braking = input.isHeld(names.brake);
    if (state.braking) {
      approachSpeed(0, settings.brakeDeceleration, stepSeconds);
    } else if (throttle > 0) {
      const rate = state.forwardSpeed < 0 ? settings.brakeDeceleration : settings.acceleration;
      approachSpeed(throttle * settings.maximumSpeed, rate, stepSeconds);
    } else if (throttle < 0) {
      const rate = state.forwardSpeed > 0.1 ? settings.brakeDeceleration : settings.acceleration;
      approachSpeed(throttle * settings.reverseSpeed, rate, stepSeconds);
    } else {
      approachSpeed(0, settings.coastDeceleration, stepSeconds);
    }
  }

  function advance(stepSeconds) {
    if (!(stepSeconds > 0)) return;
    state.previousPosition = [...state.position];
    updateSpeed(clamp(input.getAxis(names.throttle), -1, 1), stepSeconds);
    const steerWanted = clamp(input.getAxis(names.steer), -1, 1);
    state.steer += (steerWanted - state.steer) * (1 - Math.exp(-stepSeconds / settings.steerSeconds));
    const yawRate = (state.forwardSpeed / settings.wheelbase) * Math.tan(state.steer * settings.maximumSteer);
    state.yaw = wrapAngle(state.yaw + yawRate * stepSeconds);

    const heading = forwardDirection(state.yaw);
    const verticalSpeed = state.grounded ? 0 : Math.max(-PLAYER_LIMITS.maximumSpeed, state.velocity[1] - settings.gravity * stepSeconds);
    const displacement = [heading[0] * state.forwardSpeed * stepSeconds, verticalSpeed * stepSeconds, heading[2] * state.forwardSpeed * stepSeconds];
    const body = {
      position: [...state.position],
      velocity: [...state.velocity],
      grounded: state.grounded,
      radius: settings.radius,
      height: settings.height,
      stepHeight: settings.stepHeight,
    };
    const result = readMoveResult(owner, mover.move(body, displacement, stepSeconds));
    const movedX = (result.position[0] - state.position[0]) / stepSeconds;
    const movedZ = (result.position[2] - state.position[2]) / stepSeconds;
    // A wall removes the speed it blocks: the car keeps only the part of the move that really happened.
    state.forwardSpeed = movedX * heading[0] + movedZ * heading[2];
    state.velocity = [movedX, result.grounded ? 0 : verticalSpeed, movedZ];
    state.position = [...result.position];
    state.grounded = result.grounded;
    state.airborne = !result.grounded;
    state.speed = Math.abs(state.forwardSpeed);
    writeNode();
  }

  return finishController({
    name: options.name ?? 'vehicle',
    kind: 'vehicle',
    state,
    writeNode,
    advance,
    teleport(position, yaw) {
      state.position = vectorOption(owner, 'teleport position', position);
      state.previousPosition = [...state.position];
      state.velocity = [0, 0, 0];
      state.forwardSpeed = 0;
      state.yaw = numberOption(owner, 'teleport yaw', yaw, state.yaw, -1000, 1000);
      state.grounded = false;
      state.airborne = true;
    },
  });
}

function flightSettings(owner, options) {
  const speedLimit = PLAYER_LIMITS.maximumSpeed;
  const maximumPitch = numberOption(owner, 'maximumPitch', options.maximumPitch, 1.2, 0, PLAYER_LIMITS.maximumPitch);
  return {
    cruiseSpeed: numberOption(owner, 'cruiseSpeed', options.cruiseSpeed, 14, 0, speedLimit),
    boostSpeed: numberOption(owner, 'boostSpeed', options.boostSpeed, 24, 0, speedLimit),
    brakeSpeed: numberOption(owner, 'brakeSpeed', options.brakeSpeed, 6, 0, speedLimit),
    acceleration: numberOption(owner, 'acceleration', options.acceleration, 10, 0.01, PLAYER_LIMITS.maximumAcceleration),
    turnRate: numberOption(owner, 'turnRate', options.turnRate, 1.4, 0, 20),
    pitchRate: numberOption(owner, 'pitchRate', options.pitchRate, 1.1, 0, 20),
    maximumPitch,
    levelSeconds: numberOption(owner, 'levelSeconds', options.levelSeconds, 0.6, 0.001, 100),
    radius: numberOption(owner, 'radius', options.radius, 0.8, 0.01, PLAYER_LIMITS.maximumRadius),
    height: numberOption(owner, 'height', options.height, 0.6, 0.01, PLAYER_LIMITS.maximumHeight),
  };
}

// Free flight: yaw axis (moveX), pitch axis (moveForward, positive climbs), boost action (run) and brake action (jump). The flyer
// always moves along its nose at a speed that eases between brakeSpeed, cruiseSpeed and boostSpeed, levels out when the pitch axis
// is idle and reports a bank angle in state.roll for animation. Walls stop it through the mover seam; it skims the ground.
export function createFlightController(options = {}) {
  const owner = 'createFlightController';
  const input = requireInput(owner, options.input);
  const mover = validateMover(owner, options.mover ?? createKinematicMover({ ground: options.ground, obstacles: options.obstacles }));
  const settings = flightSettings(owner, options);
  const names = {
    yaw: options.yawAxis ?? 'moveX',
    pitch: options.pitchAxis ?? 'moveForward',
    boost: options.boost ?? 'run',
    brake: options.brake ?? 'jump',
  };
  const node = validateNode(owner, options.node);
  const startPosition = vectorOption(owner, 'position', options.position, [0, 10, 0]);
  const state = {
    position: startPosition,
    previousPosition: [...startPosition],
    velocity: [0, 0, 0],
    yaw: numberOption(owner, 'yaw', options.yaw, 0, -1000, 1000),
    pitch: numberOption(owner, 'pitch', options.pitch, 0, -settings.maximumPitch, settings.maximumPitch),
    roll: 0,
    speed: settings.cruiseSpeed,
    grounded: false,
    airborne: true,
    boosting: false,
  };

  function writeNode() {
    writeNodePose(node, state.position, state.yaw);
    if (node && 'rotationX' in node) node.rotationX = state.pitch;
    if (node && 'rotationZ' in node) node.rotationZ = state.roll;
  }

  function steer(stepSeconds) {
    const yawInput = clamp(input.getAxis(names.yaw), -1, 1);
    const pitchInput = clamp(input.getAxis(names.pitch), -1, 1);
    state.yaw = wrapAngle(state.yaw + yawInput * settings.turnRate * stepSeconds);
    if (pitchInput !== 0) state.pitch += pitchInput * settings.pitchRate * stepSeconds;
    else state.pitch -= state.pitch * (1 - Math.exp(-stepSeconds / settings.levelSeconds));
    state.pitch = clamp(state.pitch, -settings.maximumPitch, settings.maximumPitch);
    state.roll += (-yawInput * 0.6 - state.roll) * (1 - Math.exp(-stepSeconds / 0.2));
  }

  function updateSpeed(stepSeconds) {
    state.boosting = input.isHeld(names.boost);
    let wantedSpeed = settings.cruiseSpeed;
    if (input.isHeld(names.brake)) wantedSpeed = settings.brakeSpeed;
    else if (state.boosting) wantedSpeed = settings.boostSpeed;
    const maximumChange = settings.acceleration * stepSeconds;
    state.speed += clamp(wantedSpeed - state.speed, -maximumChange, maximumChange);
  }

  function advance(stepSeconds) {
    if (!(stepSeconds > 0)) return;
    state.previousPosition = [...state.position];
    steer(stepSeconds);
    updateSpeed(stepSeconds);
    const horizontal = Math.cos(state.pitch);
    const direction = [Math.sin(state.yaw) * horizontal, Math.sin(state.pitch), -Math.cos(state.yaw) * horizontal];
    const displacement = direction.map(component => component * state.speed * stepSeconds);
    const body = {
      position: [...state.position],
      velocity: [...state.velocity],
      grounded: false,
      radius: settings.radius,
      height: settings.height,
      stepHeight: 0,
    };
    const result = readMoveResult(owner, mover.move(body, displacement, stepSeconds));
    state.velocity = result.position.map((value, axis) => (value - state.position[axis]) / stepSeconds);
    state.position = [...result.position];
    state.grounded = result.grounded;
    state.airborne = !result.grounded;
    if (state.grounded && state.pitch < 0) state.pitch = 0;
    writeNode();
  }

  return finishController({
    name: options.name ?? 'flyer',
    kind: 'flight',
    state,
    writeNode,
    advance,
    teleport(position, yaw) {
      state.position = vectorOption(owner, 'teleport position', position);
      state.previousPosition = [...state.position];
      state.velocity = [0, 0, 0];
      state.yaw = numberOption(owner, 'teleport yaw', yaw, state.yaw, -1000, 1000);
      state.pitch = 0;
      state.grounded = false;
      state.airborne = true;
    },
  });
}

// Boat: throttle axis (moveForward) and rudder axis (moveX, positive turns right). The hull is a floating body of a live physics system
// (createPhysicsSystem, with float.boat on the body), so the controller pushes nothing itself: each step it hands the two axes to
// physics.setBoatControls, which applies them as forces at the stern, and it reads the hull pose back. The runtime lists the physics
// system after the controller. state.yaw is 0 facing -Z like the other controllers, state.roll and state.pitch are the hull's tilt in radians.
export function createBoatController(options = {}) {
  const owner = 'createBoatController';
  const input = requireInput(owner, options.input);
  const physics = options.physics;
  if (!physics || typeof physics.setBoatControls !== 'function' || typeof physics.getPose !== 'function') {
    throw new TypeError(`${owner} physics must be a physics system from createPhysicsSystem, got ${describe(physics)}. Pass the system that holds the boat body.`);
  }
  if (typeof options.body !== 'string' || options.body.length === 0) {
    throw new TypeError(`${owner} body must be the name of the boat body in the physics system, such as "boat", got ${describe(options.body)}.`);
  }
  const bodyName = options.body;
  const node = validateNode(owner, options.node);
  const names = { throttle: options.throttle ?? 'moveForward', rudder: options.rudder ?? 'moveX' };
  const readPose = () => physics.getPose(bodyName);
  const start = readPose().translation;
  const state = {
    position: [...start],
    previousPosition: [...start],
    velocity: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    roll: 0,
    forwardSpeed: 0,
    speed: 0,
    throttle: 0,
    steer: 0,
    grounded: false,
    airborne: false,
    braking: false,
  };

  function writeNode() {
    writeNodePose(node, state.position, state.yaw);
    if (node && 'rotationX' in node) node.rotationX = state.pitch;
    if (node && 'rotationZ' in node) node.rotationZ = state.roll;
  }

  function readHull(stepSeconds) {
    const { translation, rotation: [x, y, z, w] } = readPose();
    const bowX = -2 * (x * z + w * y);
    const bowZ = -(1 - 2 * (x * x + y * y));
    state.previousPosition = [...state.position];
    state.position = [...translation];
    state.velocity = state.position.map((value, axis) => (value - state.previousPosition[axis]) / stepSeconds);
    state.yaw = Math.atan2(bowX, -bowZ);
    state.forwardSpeed = state.velocity[0] * bowX + state.velocity[2] * bowZ;
    state.speed = Math.hypot(state.velocity[0], state.velocity[2]);
    state.pitch = Math.asin(clamp(-2 * (y * z - w * x), -1, 1));
    state.roll = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z));
  }

  function advance(stepSeconds) {
    if (!(stepSeconds > 0)) return;
    state.throttle = clamp(input.getAxis(names.throttle), -1, 1);
    state.steer = clamp(input.getAxis(names.rudder), -1, 1);
    physics.setBoatControls(bodyName, { throttle: state.throttle, rudder: state.steer });
    readHull(stepSeconds);
    writeNode();
  }

  return finishController({
    name: options.name ?? 'boat',
    kind: 'boat',
    state,
    writeNode,
    advance,
    teleport() {
      throw new RangeError(`${owner} cannot teleport: the hull belongs to the physics system. Set its pose there.`);
    },
  });
}

const MAXIMUM_REGISTERED_KINDS = 64;
const controllerFactories = new Map([
  ['character', createCharacterController],
  ['vehicle', createVehicleController],
  ['flight', createFlightController],
  ['boat', createBoatController],
]);
const rigFactories = new Map([
  ['follow', createFollowCamera],
  ['firstPerson', createFirstPersonCamera],
  ['topDown', createTopDownCamera],
  ['orbit', createOrbitCamera],
  ['chase', createChaseCamera],
  ['sideScroller', createSideScrollerCamera],
]);

const BUILT_IN_CONTROLLERS = new Set(controllerFactories.keys());
const BUILT_IN_RIGS = new Set(rigFactories.keys());

function register(owner, registry, kind, factory) {
  if (typeof kind !== 'string' || kind.length === 0 || kind.length > 64) {
    throw new TypeError(`${owner} kind must be a non-empty string of at most 64 characters, such as "boat", got ${describe(kind)}.`);
  }
  if (typeof factory !== 'function') {
    throw new TypeError(`${owner} factory for "${kind}" must be a function (options) => runtime system, got ${describe(factory)}.`);
  }
  if (registry.has(kind)) throw new RangeError(`${owner} kind "${kind}" is already registered. Pick another name; kinds cannot be replaced.`);
  if (registry.size >= MAXIMUM_REGISTERED_KINDS) throw new RangeError(`${owner} holds at most ${MAXIMUM_REGISTERED_KINDS} kinds.`);
  registry.set(kind, factory);
}

function build(owner, registry, kind, options) {
  const factory = registry.get(kind);
  if (!factory) throw new RangeError(`${owner} has no kind "${kind}". Registered kinds: ${[...registry.keys()].join(', ')}.`);
  return factory(options);
}

// Game code adds its own controller kind (a boat, a ball): factory(options) returns a runtime system with state.position.
export function registerController(kind, factory) {
  register('registerController', controllerFactories, kind, factory);
}

// A custom camera rig kind: factory(options) returns a runtime system with subject and pose(context) => { eye, target, up }.
export function registerCameraRig(kind, factory) {
  register('registerCameraRig', rigFactories, kind, factory);
}

export function listControllerKinds() {
  return [...controllerFactories.keys()];
}

export function listCameraRigKinds() {
  return [...rigFactories.keys()];
}

function unregister(owner, registry, builtIn, kind) {
  if (builtIn.has(kind)) throw new RangeError(`${owner} cannot remove the built-in kind "${kind}".`);
  return registry.delete(kind);
}

// Take back a kind a host refused (the MCP server does this for an addon that registered a point it did not declare).
// Built-in kinds stay. Returns whether a kind was removed.
export function unregisterControllerKind(kind) {
  return unregister('unregisterControllerKind', controllerFactories, BUILT_IN_CONTROLLERS, kind);
}

export function unregisterCameraRigKind(kind) {
  return unregister('unregisterCameraRigKind', rigFactories, BUILT_IN_RIGS, kind);
}

// The kinds registered after load (by a game or an allowlisted addon), without the built-in ones.
export function listAddedControllerKinds() {
  return listControllerKinds().filter(kind => !BUILT_IN_CONTROLLERS.has(kind));
}

export function listAddedCameraRigKinds() {
  return listCameraRigKinds().filter(kind => !BUILT_IN_RIGS.has(kind));
}

export function createController(kind, options = {}) {
  const controller = build('createController', controllerFactories, kind, options);
  const hasState = controller?.state && Array.isArray(controller.state.position);
  if (!hasState || (typeof controller.fixedUpdate !== 'function' && typeof controller.update !== 'function')) {
    throw new TypeError(`createController kind "${kind}" must return a runtime system with state.position and a fixedUpdate or update function.`);
  }
  return controller;
}

export function createCameraRigOfKind(kind, options = {}) {
  const rig = build('createCameraRigOfKind', rigFactories, kind, options);
  if (typeof rig?.pose !== 'function') {
    throw new TypeError(`createCameraRigOfKind kind "${kind}" must return a rig with pose(context) giving { eye, target, up }.`);
  }
  return rig;
}

// Swap the controller system `name` for another kind while the game runs. It starts where the old one stood, facing the same way,
// unless options say otherwise. Rigs that follow `state` must be pointed at the returned controller (see replaceCameraRig).
export function replaceController(runtime, name, kind, options = {}) {
  const previous = runtime.getSystem(name);
  if (!previous?.state) throw new RangeError(`replaceController found no controller system named "${name}" in the runtime.`);
  const carried = { position: [...previous.state.position], yaw: previous.state.yaw, name };
  const controller = createController(kind, { ...carried, ...options });
  runtime.replaceSystem(name, controller);
  return controller;
}

// Swap the camera rig system `name` for another kind. It keeps the old subject and yaw unless options name others.
export function replaceCameraRig(runtime, name, kind, options = {}) {
  const previous = runtime.getSystem(name);
  if (!previous?.subject) throw new RangeError(`replaceCameraRig found no camera rig system named "${name}" in the runtime.`);
  const rig = createCameraRigOfKind(kind, { subject: previous.subject, yaw: previous.yaw, name, ...options });
  runtime.replaceSystem(name, rig);
  return rig;
}
