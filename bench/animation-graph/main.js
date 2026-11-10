// Sample for src/animation-graph.js: the CC0 RobotExpressive blends Idle, Walking and Running by speed.
// Open bench/animation-graph/index.html with `npm run dev`. W or the up arrow walks, Shift runs; ?speed=3.5 pins the speed
// and ?demo=1 ramps it up and down on its own.
import { Renderer67 } from '/src/index.js';
import { parseGltf } from '/src/gltf.js';
import { clipFromGltfAnimation, createAssetPose } from '/src/skeleton-pose.js';
import { createAnimationGraph } from '/src/animation-graph.js';
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
const clips = {};
for (const name of ['Idle', 'Walking', 'Running']) {
  const source = asset.animations.find(animation => animation.name === name);
  clips[name] = clipFromGltfAnimation(source, { loop: true });
}

const graph = createAnimationGraph({
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
  systems: [input, locomotionSystem, graph.system()],
});
runtime.start();
window.animationGraphSample = { graph, runtime };

const readout = document.querySelector('#readout');
setInterval(() => {
  const clipLines = graph.layerState('locomotion').clips.map(entry => `${entry.clip.padEnd(8)} ${(entry.weight * 100).toFixed(0).padStart(3)}%`);
  readout.textContent = [`speed ${locomotionSystem.speed.toFixed(2)}`, ...clipLines, 'W walks, Shift runs'].join('\n');
}, 100);
