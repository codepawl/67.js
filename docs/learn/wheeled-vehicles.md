# Wheeled vehicles

`67js/addons/vehicle` drives a car or truck along a path with deterministic, physics-free animation. It is available from version `0.10.0`. Wheel spin, front-wheel steering, roll, pitch and ground following all come from the path, and `sample(seconds)` gives the same pose for the same time.

## Drive a real vehicle

The example builds a car from a box body and four wheel parts named `Wheel FL`, `Wheel FR`, `Wheel RL` and `Wheel RR`, each a cylinder whose axle runs along x. It passes them to `createVehicleRig`, which finds the wheels by name and geometry, then drives them around an oval with `driveAlongPath`. Drag to orbit and change the speed with the slider. The console prints the rig (wheel count, wheelbase, track width), the length and duration of each drive, and once a second the pose: distance, steer angle, roll and the spin of the front-left wheel.

```js live poster=vehicle-drive
import { Renderer67 } from '67js';
import { createVehicleRig, driveAlongPath, applyVehiclePoseToParts } from '67js/addons/vehicle';

// Geometry at rest in the model's own coordinates: forward is +z, left is +x, the ground is y = 0.
function boxGeometry(center, size) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (const [axis, sign] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
    const first = (axis + 1) % 3;
    const second = (axis + 2) % 3;
    const base = positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const point = [0, 0, 0];
      point[axis] = center[axis] + sign * size[axis] / 2;
      point[first] = center[first] + a * size[first] / 2;
      point[second] = center[second] + b * size[second] / 2;
      positions.push(...point);
      const normal = [0, 0, 0];
      normal[axis] = sign;
      normals.push(...normal);
    }
    indices.push(...(sign > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]).map(index => base + index));
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

function wheelGeometry(center, radius, width) {
  const positions = [];
  const normals = [];
  const indices = [];
  const steps = 24;
  for (let step = 0; step < steps; step++) {
    const angle = step / steps * Math.PI * 2;
    const up = Math.sin(angle);
    const ahead = Math.cos(angle);
    for (const side of [-1, 1]) {
      positions.push(center[0] + side * width / 2, center[1] + up * radius, center[2] + ahead * radius);
      normals.push(0, up, ahead);
    }
    const next = (step + 1) % steps;
    indices.push(step * 2, step * 2 + 1, next * 2, step * 2 + 1, next * 2 + 1, next * 2);
  }
  for (const side of [-1, 1]) {
    const hub = positions.length / 3;
    positions.push(center[0] + side * width / 2, center[1], center[2]);
    normals.push(side, 0, 0);
    const ring = positions.length / 3;
    for (let step = 0; step < steps; step++) {
      const angle = step / steps * Math.PI * 2;
      positions.push(center[0] + side * width / 2, center[1] + Math.sin(angle) * radius, center[2] + Math.cos(angle) * radius);
      normals.push(side, 0, 0);
    }
    for (let step = 0; step < steps; step++) {
      const next = (step + 1) % steps;
      indices.push(...(side > 0 ? [hub, ring + next, ring + step] : [hub, ring + step, ring + next]));
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const tireMaterial = { color: [0.06, 0.06, 0.07], metallic: 0, roughness: 0.8 };
const corners = [['FL', 0.8, 1.3], ['FR', -0.8, 1.3], ['RL', 0.8, -1.3], ['RR', -0.8, -1.3]];
const parts = [
  { name: 'Body', geometry: boxGeometry([0, 0.75, 0], [1.6, 0.5, 3.6]), matrix: identity(), material: { color: [0.8, 0.2, 0.18], metallic: 0.3, roughness: 0.35 } },
  { name: 'Cabin', geometry: boxGeometry([0, 1.2, -0.2], [1.4, 0.45, 1.8]), matrix: identity(), material: { color: [0.15, 0.2, 0.28], metallic: 0, roughness: 0.2 } },
  ...corners.map(([id, x, z]) => ({ name: `Wheel ${id}`, geometry: wheelGeometry([x, 0.35, z], 0.35, 0.25), matrix: identity(), material: tireMaterial })),
];

const rig = createVehicleRig({ parts, body: [parts[0], parts[1]] });
console.log(`rig: ${rig.wheels.length} wheels, wheelbase ${rig.wheelbase.toFixed(2)} m, track ${rig.trackWidth.toFixed(2)} m`);

const oval = Array.from({ length: 16 }, (unused, index) => {
  const angle = index / 16 * Math.PI * 2;
  return [10 * Math.sin(angle), 0, 6 * Math.cos(angle)];
});
function makeDrive(speed) {
  const drive = driveAlongPath(rig, oval, { speed });
  console.log(`speed ${speed} m/s: path ${drive.length.toFixed(1)} m, one pass takes ${drive.duration.toFixed(1)} s`);
  return drive;
}

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const renderer = new Renderer67(canvas, parts, { world: true });
const state = { speed: 6, yaw: 0.5, pitch: 0.6, distance: 24, playing: true };
let drive = makeDrive(state.speed);
let seconds = 0;
let last = performance.now();
let nextLog = 0;

function draw() {
  const pose = drive.sample(seconds % drive.duration);
  applyVehiclePoseToParts(rig, pose);
  renderer.updateParts(parts);
  const flat = Math.cos(state.pitch) * state.distance;
  renderer.render({ eye: [Math.sin(state.yaw) * flat, Math.sin(state.pitch) * state.distance, Math.cos(state.yaw) * flat], target: [0, 0.5, 0], fov: 42 });
  return pose;
}

function frame(now) {
  if (state.playing) seconds += (now - last) / 1000;
  last = now;
  const pose = draw();
  if (state.playing && seconds > nextLog) {
    nextLog = seconds + 1;
    console.log(`t=${seconds.toFixed(1)} s distance ${pose.distance.toFixed(1)} m, steer ${pose.steerAngle.toFixed(3)} rad, roll ${pose.roll.toFixed(3)} rad, front-left spin ${pose.wheels[0].spinAngle.toFixed(1)} rad`);
  }
  requestAnimationFrame(frame);
}

const bar = document.createElement('div');
bar.style.cssText = 'position:fixed;left:8px;bottom:8px;display:flex;gap:10px;align-items:center;color:#dde;font:12px system-ui;background:#000a;padding:6px 8px;border-radius:6px';
const toggle = document.createElement('button');
toggle.textContent = 'Pause';
toggle.addEventListener('click', () => { state.playing = !state.playing; toggle.textContent = state.playing ? 'Pause' : 'Play'; });
const speed = document.createElement('input');
speed.type = 'range';
speed.min = 2;
speed.max = 14;
speed.step = 0.5;
speed.value = state.speed;
speed.addEventListener('change', () => {
  state.speed = Number(speed.value);
  drive = makeDrive(state.speed);
  seconds = 0;
  nextLog = 0;
});
bar.append(toggle, 'speed', speed);
document.body.append(bar);
canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  state.yaw -= event.movementX * 0.01;
  state.pitch = Math.min(1.3, Math.max(0.15, state.pitch + event.movementY * 0.01));
});
new ResizeObserver(() => renderer.resize()).observe(canvas);
requestAnimationFrame(frame);
addEventListener('pagehide', () => renderer.dispose());
```

The lean you see at speed is `rollGain` times the lateral acceleration. A wheel spins by the distance it covers divided by its radius, and the inside wheels of a corner spin slower because their path is shorter. The drive holds the end of the path, so the example samples at `seconds % drive.duration` to go round again.

1. Describe the vehicle with `createVehicleRig({ parts })`. Check `rig.wheels` or `findWheelCandidates(names)` when a wheel is missed.
2. Build a drive with `driveAlongPath(rig, points, { cruiseSpeed, groundHeight })`. Pass `groundHeight: terrain.heightAt` to follow a terrain, and `cruiseSpeed` for a natural start and stop.
3. Each frame, call `applyVehiclePoseToParts(rig, drive.sample(seconds))` and then `renderer.updateParts(parts)`.

Scene-graph nodes and imported GLBs use `applyVehiclePoseToSceneGraph` and `applyVehiclePoseToAsset`.

## Conventions and options

Units are metres, +Y is up and the system is right-handed. Angles are radians. The model's forward axis is `+z` unless `forwardAxis` is `'+x'`, `'-x'` or `'-z'`. Left is `up x forward`, so left is `+x` when forward is `+z`. The rig builds a local frame on the ground under the centroid of the wheel centres and moves the whole model with it. `pose.heading` is yaw about +Y, zero when facing +z. `pitch` is positive nose up, `roll` is positive when the left side rises, and steering is positive toward the left.

`driveAlongPath(rig, path, options)` returns `{ sample(seconds), duration, length, rig }`. The path is an array of `[x, y, z]` points, smoothed with a centripetal spline, or a camera path object whose eye track is followed. Give exactly one speed option.

| Option | Meaning |
| --- | --- |
| `speed` | Constant metres per second, no ramp. |
| `cruiseSpeed` | A profile with `acceleration` (3), `braking` (4), `startSpeed` (0), `endSpeed` (0) and `maxLateralAcceleration` (unlimited). |
| `startTime`, `groundHeight(x, z)`, `maxSteerAngle` | Start offset, ground fit and steering clamp. |
| `rollGain`, `pitchGain` | 0.012 rad per m/s² each. |
| `bounceFrequency`, `dampingRatio`, `suspensionTravel` | 1.6 Hz, 0.45 and 0.2 m. |
| `pathSamples` | 400, for camera paths. |

`sample(seconds)` returns `{ time, distance, speed, direction, position, heading, pitch, roll, steerAngle, wheels: [{ id, spinAngle, steerAngle, suspensionOffset }], lights }`. Roll and pitch follow lateral and longitudinal acceleration through a spring and damper, integrated at a fixed step when the drive is created, so sampling order does not matter. With `groundHeight`, the body height and its slope are fitted to the ground under the four wheels, and each wheel gets a `suspensionOffset`. The vehicle holds the end of the path with zero speed. Use `cruiseSpeed` for a natural stop, because a constant `speed` stops instantly and the body pitches.

## Limits

- Kinematic only: no collisions, tire slip or jumps. Heading follows the path tangent, plus a half turn while reversing.
- Ground is a plane fit under the wheels, so bumps narrower than the wheelbase show as suspension offsets, clamped to `suspensionTravel`.
- Rear-steered wheels get no Ackermann angle.
- Through MCP the tail lights drive only the materials of an asset recipe, and `groundHeight` is not available.
- Scene-graph nodes with a nonzero `pivot` are rejected. Wheel radius from geometry assumes a round wheel in the plane across its axle.

The [vehicle contract](https://github.com/codepawl/67.js/blob/main/docs/vehicle.md) lists conventions, options and limits.

## Common mistakes

- A model whose forward axis is not `+z` and no `forwardAxis`. The car drives sideways.
- Wheels that are merged into one geometry. The rig finds wheels by name and geometry, so keep them separate parts.
- Sampling past `drive.duration`. The vehicle holds the end of the path.
- Using a constant `speed` and expecting a smooth stop.
- Expecting collisions. The drive is kinematic.
