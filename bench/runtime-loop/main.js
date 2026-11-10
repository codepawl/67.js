// Sample for src/runtime.js: a ball bouncing in a fixed-step system and a cube spinning in a variable-step system,
// shown live in each update mode. Open bench/runtime-loop/index.html with `npm run dev`; ?mode=fixed|variable|both picks the start mode.
import { Renderer67, box, sphere } from '/src/index.js';
import { createRuntime } from '/src/runtime.js';
import { createInput, gamepadSource, keyboardSource } from '/src/input.js';
import { createCharacterController, createFirstPersonCamera, createFollowCamera, createTopDownCamera } from '/src/player.js';

const GRAVITY = -9.8;
const FIXED_RATE = 20; // Low on purpose, so the difference between fixed and interpolated is visible.
const BOUNCE_ENERGY = 0.9;
const BALL_RADIUS = 0.4;
const SPIN_RADIANS_PER_SECOND = 1.5;
const CUBE_SPEED = 3; // World units per second along the moveX axis.
const JUMP_SPEED = 6;

function translation(x, y, z, scale = 1) {
  return new Float32Array([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, z, 1]);
}

function rotationAroundY(angle, x, y, z) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return new Float32Array([cosine, 0, -sine, 0, 0, 1, 0, 0, sine, 0, cosine, 0, x, y, z, 1]);
}

function boxMatrix({ min, max }) {
  const size = max.map((value, axis) => value - min[axis]);
  const center = max.map((value, axis) => (value + min[axis]) / 2);
  return new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, center[0], center[1], center[2], 1]);
}

const ballPart = {
  name: 'Ball',
  geometry: sphere(),
  matrix: translation(-1.2, 2, 0, BALL_RADIUS),
  material: { color: [0.9, 0.35, 0.25], metallic: 0, roughness: 0.4, emission: 0 },
};
const cubePart = {
  name: 'Cube',
  geometry: box(),
  matrix: rotationAroundY(0, 1.2, 0.5, 0),
  material: { color: [0.25, 0.55, 0.9], metallic: 0, roughness: 0.4, emission: 0 },
};
const groundPart = {
  name: 'Ground',
  geometry: box(),
  matrix: new Float32Array([30, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 30, 0, 0, -0.05, 0, 1]),
  material: { color: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.9, emission: 0 },
};

// Static boxes the character walks into (a wall) and climbs (steps), as { min, max } for the kinematic mover.
const obstacles = [
  { min: [-6, 0, -4.4], max: [6, 1.5, -4] },
  { min: [3, 0, -1], max: [5, 0.3, 2] },
  { min: [3.5, 0, -1], max: [5, 0.6, 1] },
];
const obstacleParts = obstacles.map((obstacle, index) => ({
  name: `Obstacle${index}`,
  geometry: box(),
  matrix: boxMatrix(obstacle),
  material: { color: [0.62, 0.58, 0.5], metallic: 0, roughness: 0.8, emission: 0 },
}));
const playerPart = {
  name: 'Player',
  geometry: box(),
  matrix: boxMatrix({ min: [-0.4, 0, -0.4], max: [0.4, 1.8, 0.4] }),
  material: { color: [0.95, 0.8, 0.25], metallic: 0, roughness: 0.5, emission: 0 },
};
const parts = [groundPart, ballPart, cubePart, ...obstacleParts, playerPart];

const physicsSystem = {
  name: 'ball-physics',
  previousHeight: 2,
  height: 2,
  velocity: 0,
  init() {
    this.previousHeight = this.height = 2;
    this.velocity = 0;
  },
  integrate(stepSeconds) {
    this.previousHeight = this.height;
    this.velocity += GRAVITY * stepSeconds;
    this.height += this.velocity * stepSeconds;
    if (this.height < BALL_RADIUS) {
      this.height = BALL_RADIUS;
      this.velocity = -this.velocity * BOUNCE_ENERGY;
    }
  },
  fixedUpdate(stepSeconds) {
    if (input.wasPressed('jump')) this.velocity = JUMP_SPEED;
    this.integrate(stepSeconds);
  },
  // Variable mode never calls fixedUpdate, so the same physics runs on the frame time there.
  update(deltaSeconds, context) {
    if (context.mode !== 'variable') return;
    if (input.wasPressed('jump')) this.velocity = JUMP_SPEED;
    this.integrate(deltaSeconds);
  },
};

const spinSystem = {
  name: 'cube-spin',
  angle: 0,
  x: 1.2,
  slide(deltaSeconds) {
    this.x = Math.max(-3.5, Math.min(3.5, this.x + input.getAxis('cubeX') * CUBE_SPEED * deltaSeconds));
  },
  fixedUpdate(stepSeconds) {
    this.slide(stepSeconds);
  },
  update(deltaSeconds, context) {
    this.angle += SPIN_RADIANS_PER_SECOND * deltaSeconds;
    if (context.mode === 'variable') this.slide(deltaSeconds);
  },
};

// Keys or a gamepad drive the sample. WASD walks the player, Shift runs, the arrow keys look, J/L slide the cube, and Space
// jumps the player and kicks the ball up.
const input = createInput({
  sources: [keyboardSource(), gamepadSource()],
  actions: { jump: ['keyboard/Space', 'gamepad/0.button0'], run: ['keyboard/ShiftLeft'] },
  axes: {
    cubeX: ['keyboard/KeyL', { control: 'keyboard/KeyJ', scale: -1 }],
    moveX: ['keyboard/KeyD', { control: 'keyboard/KeyA', scale: -1 }, 'gamepad/0.axis0'],
    moveForward: ['keyboard/KeyW', { control: 'keyboard/KeyS', scale: -1 }, { control: 'gamepad/0.axis1', scale: -1 }],
    lookX: ['keyboard/ArrowRight', { control: 'keyboard/ArrowLeft', scale: -1 }],
    lookY: ['keyboard/ArrowUp', { control: 'keyboard/ArrowDown', scale: -1 }],
  },
});

// The player faces and walks relative to whichever camera rig is active, so swapping the rig keeps the controls natural.
const player = createCharacterController({
  input,
  position: [0, 0, 3],
  obstacles,
  cameraYaw: () => runtime?.getSystem('camera')?.yaw ?? 0,
});
const RIG_FACTORIES = {
  follow: () => createFollowCamera({ subject: player.state, input }),
  firstPerson: () => createFirstPersonCamera({ subject: player.state, input }),
  topDown: () => createTopDownCamera({ subject: player.state }),
};
const requestedRig = new URLSearchParams(location.search).get('rig');
let rigKind = Object.hasOwn(RIG_FACTORIES, requestedRig ?? '') || requestedRig === 'static' ? requestedRig : 'follow';

// Only own keys: a name like "toString" from the URL or a button must not reach the prototype.
function createRig(kind) {
  if (!Object.hasOwn(RIG_FACTORIES, kind)) throw new Error(`Unknown camera rig "${kind}"; use follow, firstPerson, topDown or static.`);
  return createRig(kind);
}

const canvas = document.querySelector('canvas');
const renderer = new Renderer67(canvas, parts, { samples: 4, memoryBudgetMiB: 256 });
renderer.resize();

// The player box is drawn between its last two fixed steps, turned to its heading, and hidden when the camera is inside it.
function placePlayer(blend) {
  const [x, y, z] = player.positionAt(blend);
  const size = [0.8, 1.8, 0.8];
  const hiddenDrop = rigKind === 'firstPerson' ? 100 : 0; // the first-person camera sits inside the body
  const cosine = Math.cos(player.state.yaw);
  const sine = Math.sin(player.state.yaw);
  playerPart.matrix = new Float32Array([
    cosine * size[0], 0, sine * size[0], 0,
    0, size[1], 0, 0,
    -sine * size[2], 0, cosine * size[2], 0,
    x, y + size[1] / 2 - hiddenDrop, z, 1,
  ]);
}

// The ball is drawn between its last two fixed states in "both" mode and at its newest state otherwise.
function buildFrame(context) {
  const blend = context.alpha;
  const height = physicsSystem.previousHeight + (physicsSystem.height - physicsSystem.previousHeight) * blend;
  ballPart.matrix = translation(-1.2, height, 0, BALL_RADIUS);
  cubePart.matrix = rotationAroundY(spinSystem.angle, spinSystem.x, 0.5, 0);
  placePlayer(context.alpha);
  renderer.updateParts(parts);
  const pose = runtime.getSystem('camera')?.pose(context) ?? { eye: [0, 3, 8], target: [0, 1.2, 0], up: [0, 1, 0] };
  return { ...pose, time: context.elapsedSeconds };
}

let runtime = null;

function markRigButtons() {
  for (const button of document.querySelectorAll('button[data-rig]')) {
    button.setAttribute('aria-pressed', String(button.dataset.rig === rigKind));
  }
}

function startMode(mode) {
  runtime?.stop(); // not dispose: dispose would also dispose the shared input and player
  runtime = createRuntime(renderer, {
    mode,
    fixedRate: FIXED_RATE,
    frame: buildFrame,
    systems: [input, physicsSystem, spinSystem, player],
  });
  if (rigKind !== 'static') runtime.addSystem(createRig(rigKind));
  runtime.start();
  for (const button of document.querySelectorAll('button[data-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
  markRigButtons();
  window.runtimeSample = runtime;
}

for (const button of document.querySelectorAll('button[data-mode]')) {
  button.addEventListener('click', () => startMode(button.dataset.mode));
}

// Swapping a rig while the game runs: the runtime replaces the "camera" system and the player keeps moving.
function selectRig(kind) {
  rigKind = kind;
  if (kind === 'static') {
    if (runtime.getSystem('camera')) runtime.removeSystem('camera');
  } else if (runtime.getSystem('camera')) runtime.replaceSystem('camera', createRig(kind));
  else runtime.addSystem(createRig(kind));
  markRigButtons();
}

for (const button of document.querySelectorAll('button[data-rig]')) {
  button.addEventListener('click', () => selectRig(button.dataset.rig));
}

const readout = document.querySelector('#readout');
setInterval(() => {
  const stats = runtime.stats;
  readout.textContent = [
    `${stats.framesPerSecond.toFixed(0)} fps, ${stats.averageFrameMilliseconds.toFixed(1)} ms average, ${stats.maximumFrameMilliseconds.toFixed(1)} ms worst`,
    `update ${stats.updateMilliseconds.toFixed(2)} ms, render ${stats.renderMilliseconds.toFixed(2)} ms`,
    `fixed steps ${stats.fixedSteps}, alpha ${stats.alpha.toFixed(2)}`,
    `player ${player.state.grounded ? 'on the ground' : 'airborne'}, speed ${player.state.speed.toFixed(1)}`,
    'WASD walks, Shift runs, Space jumps, arrows look, J/L slide the cube',
  ].join('\n');
}, 250);

const requestedMode = new URLSearchParams(location.search).get('mode');
startMode(['fixed', 'variable', 'both'].includes(requestedMode) ? requestedMode : 'both');
