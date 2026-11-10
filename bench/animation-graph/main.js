// Sample for src/animation-graph.js: the CC0 RobotExpressive blends Idle, Walking and Running by speed.
// The Walking and Running clips are in place, so a root travel track at the pace of the stride is added to the armature node:
// the graph takes it out again, the character controller moves the body by it and the feet do not slide.
// Open bench/animation-graph/index.html with `npm run dev`. W or the up arrow walks, Shift runs; ?speed=3.5 pins the speed
// and ?demo=1 ramps it up and down on its own.
import { Renderer67 } from '/src/index.js';
import { parseGltf } from '/src/gltf.js';
import { clipFromGltfAnimation, createAssetPose } from '/src/skeleton-pose.js';
import { createAnimationClip } from '/src/animation.js';
import { createAnimationGraph } from '/src/animation-graph.js';
import { createCharacterController } from '/src/player.js';
import { createInput, keyboardSource } from '/src/input.js';
import { createRuntime } from '/src/runtime.js';

const ROBOT_URL = '/tests/fixtures/RobotExpressive.glb';
const WALK_SPEED = 2.2;
const RUN_SPEED = 5.5;
const ACCELERATION = 6; // Speed units per second squared.
const DEMO_PERIOD_SECONDS = 8;
const FIXED_RATE = 60;

const query = new URLSearchParams(location.search);
const pinnedSpeed = query.has('speed') ? Number(query.get('speed')) : null;
const demo = query.get('demo') === '1';

const response = await fetch(ROBOT_URL);
const asset = await parseGltf(await response.arrayBuffer(), { maxVertices: 500000 });
const ROOT_BONE = 'RobotArmature';

// The CC0 clips play in place. Give a stride clip a root travel track of `metersPerSecond` so the graph has root motion to extract.
function withRootTravel(clip, metersPerSecond) {
  const travel = {
    target: ROOT_BONE,
    property: 'translation',
    keyframes: [{ time: 0, value: [0, 0, 0] }, { time: clip.duration, value: [0, 0, metersPerSecond * clip.duration] }],
  };
  return createAnimationClip({ duration: clip.duration, loop: clip.loop, tracks: [...clip.tracks, travel] });
}

const clips = {};
for (const [name, pace] of [['Idle', 0], ['Walking', WALK_SPEED], ['Running', RUN_SPEED]]) {
  const source = asset.animations.find(animation => animation.name === name);
  const clip = clipFromGltfAnimation(source, { loop: true });
  clips[name] = pace > 0 ? withRootTravel(clip, pace) : clip;
}

const graph = createAnimationGraph({
  rootMotion: { bone: ROOT_BONE },
  clips,
  parameters: { speed: { type: 'number' } },
  layers: [{
    name: 'locomotion',
    states: [{
      name: 'move',
      blend: {
        parameter: 'speed',
        motions: [
          { clip: 'Idle', threshold: 0 },
          { clip: 'Walking', threshold: WALK_SPEED },
          { clip: 'Running', threshold: RUN_SPEED },
        ],
      },
    }],
  }],
});
const pose = createAssetPose(asset, { layers: graph.poseLayers() });

const input = createInput({
  sources: [keyboardSource()],
  axes: {
    forward: ['keyboard/KeyW', 'keyboard/ArrowUp'],
    sprint: ['keyboard/ShiftLeft', 'keyboard/ShiftRight'],
  },
});

// Game logic: turn the keys into a target speed and approach it, then hand the result to the graph as a parameter.
const locomotionSystem = {
  name: 'locomotion',
  speed: 0,
  targetSpeed() {
    if (pinnedSpeed !== null) return pinnedSpeed;
    if (demo) return RUN_SPEED * (0.5 - 0.5 * Math.cos(2 * Math.PI * graph.time / DEMO_PERIOD_SECONDS));
    if (input.getAxis('forward') <= 0) return 0;
    return input.getAxis('sprint') > 0 ? RUN_SPEED : WALK_SPEED;
  },
  fixedUpdate(stepSeconds) {
    const difference = this.targetSpeed() - this.speed;
    const largestChange = ACCELERATION * stepSeconds;
    this.speed += Math.max(-largestChange, Math.min(largestChange, difference));
    graph.set('speed', this.speed);
  },
};

// The controller moves the body by the graph's root motion (the readout shows how far). The robot is drawn in place; a game
// would write controller.state.position to the character's node. Yaw PI because the robot, like any glTF model, faces +Z.
const controller = createCharacterController({
  input: { getAxis: () => 0, isHeld: () => false, wasPressed: () => false },
  yaw: Math.PI,
  rootMotion: () => graph.rootMotion.delta,
});

const canvas = document.querySelector('canvas');
const renderer = new Renderer67(canvas, asset.parts, { ground: true, hdr: false, samples: 4, memoryBudgetMiB: 512 });
renderer.resize();

function buildFrame(context) {
  pose.apply(graph.time);
  renderer.updateParts(asset.parts);
  return { eye: [6, 4, 14], target: [0, 2.6, 0], up: [0, 1, 0], fov: 35, near: 0.1, far: 100, time: context.elapsedSeconds };
}

const runtime = createRuntime(renderer, {
  mode: 'fixed',
  fixedRate: FIXED_RATE,
  frame: buildFrame,
  systems: [input, locomotionSystem, controller, graph.system()],
});
runtime.start();
window.animationGraphSample = { graph, runtime };

const readout = document.querySelector('#readout');
setInterval(() => {
  const clipLines = graph.layerState('locomotion').clips.map(entry => `${entry.clip.padEnd(8)} ${(entry.weight * 100).toFixed(0).padStart(3)}%`);
  const rootLine = `root motion ${graph.rootMotion.speed.toFixed(2)} m/s, travelled ${Math.abs(controller.state.position[2]).toFixed(1)} m`;
  readout.textContent = [`speed ${locomotionSystem.speed.toFixed(2)}`, rootLine, ...clipLines, 'W walks, Shift runs'].join('\n');
}, 100);
