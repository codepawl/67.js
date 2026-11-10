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
  const faceCamera = options.faceCamera ?? false;
  const cameraYaw = options.cameraYaw ?? 0;
  if (typeof cameraYaw !== 'function' && !Number.isFinite(cameraYaw)) {
    throw new TypeError(`${owner} cameraYaw must be a yaw in radians or a function returning one, such as () => rig.yaw, got ${describe(cameraYaw)}.`);
  }
  const node = options.node;
  if (node !== undefined && (node === null || typeof node !== 'object' || !Array.isArray(node.position))) {
    throw new TypeError(`${owner} node must be an object with a position array, such as { position: [0, 0, 0] }, got ${describe(node)}.`);
  }

  const startPosition = vectorOption(owner, 'position', options.position, [0, 0, 0]);
  const state = {
    position: startPosition,
    previousPosition: [...startPosition],
    velocity: [0, 0, 0],
    yaw: numberOption(owner, 'yaw', options.yaw, 0, -1000, 1000),
    grounded: false,
    airborne: true,
    speed: 0,
    running: false,
  };

  function writeNode() {
    if (!node) return;
    node.position[0] = state.position[0];
    node.position[1] = state.position[1];
    node.position[2] = state.position[2];
    if ('rotationY' in node) node.rotationY = -state.yaw;
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

  function advance(stepSeconds) {
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
  // follow and topDown orbit the focus point at `distance`; pitch is how far above the horizon the camera sits.
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
  const input = wantsLook || lookNames.y ? requireInput(owner, options.input) : options.input;
  const minimumPitch = numberOption(owner, 'minimumPitch', options.minimumPitch, defaults.minimumPitch, -PLAYER_LIMITS.maximumPitch, PLAYER_LIMITS.maximumPitch);
  const maximumPitch = numberOption(owner, 'maximumPitch', options.maximumPitch, defaults.maximumPitch, minimumPitch, PLAYER_LIMITS.maximumPitch);
  const lookSpeed = numberOption(owner, 'lookSpeed', options.lookSpeed, 2.5, 0, 100);
  const followSeconds = numberOption(owner, 'followSeconds', options.followSeconds, defaults.followSeconds, 0, 10);
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
    rig.previousFocus = rig.focus;
    const amount = followSeconds === 0 ? 1 : 1 - Math.exp(-stepSeconds / followSeconds);
    rig.focus = blend(rig.focus, rig.subject.position, amount);
  }

  rig.init = () => {
    rig.focus = [...rig.subject.position];
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
