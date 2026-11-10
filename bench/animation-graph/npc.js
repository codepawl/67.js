// Sample for src/npc-follower.js: the CC0 RobotExpressive walks a navmesh route around a wall through the animation graph.
// The follower steers along the route, writes its speed to the graph, and moves by the graph's root motion.
// Open bench/animation-graph/npc.html with `npm run dev`. The walk is simulated once at load (it is deterministic), then replayed;
// the readout gives the time to reach the goal and the largest foot slide measured on the planted feet.
import { Renderer67, box } from '/src/index.js';
import { createAssetPose } from '/src/skeleton-pose.js';
import { createAnimationClip } from '/src/animation.js';
import { createPathFollower } from '/src/animation-graph.js';
import { createNavmesh } from '/src/navmesh.js';
import { createTerrain } from '/src/terrain.js';
import { createRuntime } from '/src/runtime.js';
import { createLocomotionGraph, loadRobot, ROOT_BONE, WALK_SPEED } from './robot-graph.js';

const STEP = 1 / 60;
const FIXED_RATE = 60;
const START = [-16, 0];
const GOAL = [16, 0];
const WALL = { min: [-1.5, -12], max: [1.5, 6] };
const MAXIMUM_SECONDS = 60;
const HOLD_SECONDS = 2;
const KEYFRAME_EVERY = 2; // Steps between keyframes of the trajectory clip.
const PLANTED_HEIGHT = 0.05; // Above the lowest the foot reaches, in the robot's units.
const FEET = ['FootL', 'FootR'];
const FACING_OFFSET = Math.PI; // The follower faces -Z at yaw 0, a glTF robot faces +Z.

const asset = await loadRobot();
const ground = createTerrain({ size: 48, chunks: 1, levels: 1, resolution: 64, height: () => 0 }).parts[0].geometry;
const navmesh = createNavmesh({ positions: ground.positions, indices: ground.indices, agentRadius: 1.2, cellSize: 0.5, obstacles: [WALL] });

// Pass 1: the follower and the graph walk the route; record what the pose needs for every step.
function simulate() {
  const graph = createLocomotionGraph(asset);
  const follower = createPathFollower({ graph, navmesh, position: [START[0], 0, START[1]], yaw: Math.PI / 2, cruiseSpeed: WALK_SPEED });
  follower.goTo(GOAL);
  const steps = [];
  let largestMoveError = 0;
  let previousRootDistance = 0;
  while (follower.state.status === 'moving' && steps.length < MAXIMUM_SECONDS * FIXED_RATE) {
    follower.step(STEP);
    largestMoveError = Math.max(largestMoveError, Math.abs(follower.state.lastMove - previousRootDistance));
    steps.push({ position: [...follower.state.position], yaw: follower.state.yaw, speed: follower.state.speed });
    graph.advance(STEP);
    previousRootDistance = graph.rootMotion.distance;
  }
  return { steps, reachedGoal: follower.state.status === 'arrived', largestMoveError };
}

// The trajectory as a clip on the armature node, so the pose puts the robot where the follower walked it.
function trajectoryClip(steps) {
  const translation = [];
  const rotation = [];
  for (let index = 0; index < steps.length; index += KEYFRAME_EVERY) {
    const { position, yaw } = steps[index];
    const half = (FACING_OFFSET - yaw) / 2;
    translation.push({ time: index * STEP, value: [...position] });
    rotation.push({ time: index * STEP, value: [0, Math.sin(half), 0, Math.cos(half)] });
  }
  const duration = (steps.length - 1) * STEP;
  const last = steps.length - 1;
  if ((last % KEYFRAME_EVERY) !== 0) {
    const half = (FACING_OFFSET - steps[last].yaw) / 2;
    translation.push({ time: duration, value: [...steps[last].position] });
    rotation.push({ time: duration, value: [0, Math.sin(half), 0, Math.cos(half)] });
  }
  return createAnimationClip({
    duration,
    loop: false,
    tracks: [
      { target: ROOT_BONE, property: 'translation', keyframes: translation },
      { target: ROOT_BONE, property: 'rotation', keyframes: rotation },
    ],
  });
}

const recording = simulate();
const duration = (recording.steps.length - 1) * STEP;
const graph = createLocomotionGraph(asset);
const pose = createAssetPose(asset, { layers: [...graph.poseLayers(), { clip: trajectoryClip(recording.steps), weight: () => 1, clipTime: () => Math.min(graph.time, duration) }] });

function speedAt(time) {
  const index = Math.min(Math.round(time / STEP), recording.steps.length - 1);
  return time > duration ? 0 : recording.steps[index].speed;
}

// Pass 2: replay once and measure the planted feet in world space. A foot is planted when it is within PLANTED_HEIGHT of its lowest point.
function measureFootSlide() {
  const paths = FEET.map(() => []);
  for (let index = 0; index < recording.steps.length; index++) {
    graph.set('speed', recording.steps[index].speed);
    graph.advance(STEP);
    pose.apply(graph.time);
    FEET.forEach((name, foot) => paths[foot].push([...pose.jointWorld(name).position]));
  }
  let largest = 0;
  let total = 0;
  let count = 0;
  paths.forEach(path => {
    const lowest = Math.min(...path.map(point => point[1]));
    for (let index = 1; index < path.length; index++) {
      const planted = path[index][1] <= lowest + PLANTED_HEIGHT && path[index - 1][1] <= lowest + PLANTED_HEIGHT;
      if (!planted) continue;
      const slide = Math.hypot(path[index][0] - path[index - 1][0], path[index][2] - path[index - 1][2]) / STEP;
      largest = Math.max(largest, slide);
      total += slide;
      count += 1;
    }
  });
  graph.reset();
  return { largest, mean: count ? total / count : 0, samples: count };
}

const footSlide = measureFootSlide();
const stats = {
  reachedGoal: recording.reachedGoal,
  goalReachSeconds: duration,
  largestRootMotionVsMoveError: recording.largestMoveError,
  largestFootSlideUnitsPerSecond: footSlide.largest,
  meanFootSlideUnitsPerSecond: footSlide.mean,
  plantedSamples: footSlide.samples,
};

const material = { color: [0.55, 0.57, 0.62], metallic: 0, roughness: 0.7 };
function placed(center, size) {
  return new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, center[0], center[1], center[2], 1]);
}
const scenery = [
  { geometry: box(), matrix: placed([0, 3, (WALL.min[1] + WALL.max[1]) / 2], [WALL.max[0] - WALL.min[0], 6, WALL.max[1] - WALL.min[1]]), material },
  { geometry: box(0), matrix: placed([GOAL[0], 0.03, GOAL[1]], [2.4, 0.06, 2.4]), material: { color: [0.2, 0.75, 0.4], metallic: 0, roughness: 0.6 } },
];
const parts = [...asset.parts, ...scenery];

const canvas = document.querySelector('canvas');
const renderer = new Renderer67(canvas, parts, { ground: true, hdr: false, samples: 4, memoryBudgetMiB: 512 });
renderer.resize();

const replay = {
  name: 'replay',
  fixedUpdate() {
    if (graph.time > duration + HOLD_SECONDS) graph.reset();
    graph.set('speed', speedAt(graph.time));
  },
};

const runtime = createRuntime(renderer, {
  mode: 'fixed',
  fixedRate: FIXED_RATE,
  frame(context) {
    pose.apply(graph.time);
    renderer.updateParts(parts);
    return { eye: [0, 30, 32], target: [0, 0, 0], up: [0, 1, 0], fov: 40, near: 0.1, far: 200, time: context.elapsedSeconds };
  },
  systems: [replay, graph.system()],
});
runtime.start();
window.npcSample = { graph, runtime, stats };

const readout = document.querySelector('#readout');
setInterval(() => {
  readout.textContent = [
    `speed ${speedAt(graph.time).toFixed(2)}`,
    `goal reached in ${stats.goalReachSeconds.toFixed(1)} s`,
    `foot slide max ${stats.largestFootSlideUnitsPerSecond.toFixed(2)} mean ${stats.meanFootSlideUnitsPerSecond.toFixed(3)} units/s`,
    `root motion vs moved ${stats.largestRootMotionVsMoveError.toExponential(1)} m`,
  ].join('\n');
}, 100);
