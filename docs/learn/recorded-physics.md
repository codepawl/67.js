# Recorded physics

`crucible/addons/physics` bakes rigid-body motion into a timeline with the Rapier 3D solver. Playback samples that recording at an absolute time and never runs the solver again, so you can seek forward and backward and get the same pose. It is available from version `0.4.0`, and the main renderer does not need Rapier for playback.

## Bake once, seek anywhere

The example bakes a real Rapier recording in the page: a floor, a bouncing ball that gets a kick at tick 120, and a crate that slides across the floor. `planPhysicsScene` sizes the timeline first, `createPhysicsScene` bakes it, and `physics.bindParts` ties the two parts to their bodies. After that playback never runs the solver again. Drag the slider back and forth, or let it play, and a seek backward gives the same pose. The console prints the plan, the bake time, the contact events, the tick where each body came to rest and the lowest height of the ball between frames.

```js live poster=physics-recording
import { CrucibleRenderer, sphere, box } from 'crucible';
import { createPhysicsScene, planPhysicsScene } from 'crucible/addons/physics';

const radius = 0.4;
const definition = {
  gravity: [0, -9.81, 0],
  bodies: [
    { name: 'floor', type: 'fixed', translation: [0, -0.5, 0] },
    { name: 'ball', type: 'dynamic', translation: [-3, 4, 0] },
    { name: 'crate', type: 'dynamic', translation: [1.5, 0.35, 0], linearVelocity: [-1.2, 0, 0] },
  ],
  colliders: [
    { name: 'floor', body: 'floor', shape: 'cuboid', halfExtents: [8, 0.5, 4], friction: 0.6 },
    { name: 'ball', body: 'ball', shape: 'ball', radius, restitution: 0.62, mass: 1 },
    { name: 'crate', body: 'crate', shape: 'cuboid', halfExtents: [0.35, 0.35, 0.35], friction: 0.6, mass: 1 },
  ],
  events: [{ tick: 120, body: 'ball', impulse: [3, 3, 0] }],
};
const options = { frameCount: 361, timestep: 1 / 60, maxMemoryBytes: 32 * 1024 * 1024 };
const plan = planPhysicsScene(definition, options);
console.log('plan:', { timelineBytes: plan.timelineBytes, estimatedPeakBytes: plan.estimatedPeakBytes });

const bakeStart = performance.now();
const physics = await createPhysicsScene(definition, options);
const duration = (options.frameCount - 1) * options.timestep;
console.log(`baked ${options.frameCount} frames in ${(performance.now() - bakeStart).toFixed(1)} ms; contact events: ${physics.contactEvents.length}, bodies at rest from tick`, Object.fromEntries(physics.bodyNames.map((name, index) => [name, physics.restFrames[index]])));

// The matrix keeps its scale; the binding writes the recorded translation and rotation into it.
const ballPart = { name: 'Ball', geometry: sphere(32, 20), matrix: new Float32Array([radius, 0, 0, 0, 0, radius, 0, 0, 0, 0, radius, 0, 0, 0, 0, 1]), material: { color: [0.9, 0.45, 0.2], metallic: 0, roughness: 0.4 } };
const cratePart = { name: 'Crate', geometry: box(0.05, 3), matrix: new Float32Array([0.7, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 1]), material: { color: [0.55, 0.4, 0.25], metallic: 0, roughness: 0.7 } };
const floorPart = { name: 'Floor', geometry: box(0.05, 3), matrix: new Float32Array([16, 0, 0, 0, 0, 1, 0, 0, 0, 0, 8, 0, 0, 0, 0, 1]), material: { color: [0.4, 0.42, 0.45], metallic: 0, roughness: 0.9 } };
const parts = [floorPart, ballPart, cratePart];
const bindings = physics.bindParts([
  { body: 'floor', part: floorPart },
  { body: 'ball', part: ballPart },
  { body: 'crate', part: cratePart },
]);

// The lowest the ball gets between frames. An interpolated pose runs no collision test, so a rotated shape can dip below the floor; a ball stays above it.
const pose = new Float32Array(physics.bodyNames.length * 7);
const ballIndex = physics.bodyIndex('ball');
let lowest = Infinity;
for (let time = 0; time <= duration; time += options.timestep / 10) lowest = Math.min(lowest, physics.sample(time, pose)[ballIndex * 7 + 1] - radius);
console.log(`lowest ball underside while sampling at 10x the step: ${lowest.toFixed(4)} m`);

const canvas = document.querySelector('#scene');
const renderer = new CrucibleRenderer(canvas, parts);
function applyAnimation(time) {
  bindings.apply(time);
  renderer.updateParts(parts);
  renderer.render({ eye: [0, 3.5, 9], target: [0, 1, 0], fov: 42 });
}

const bar = document.createElement('div');
bar.style.cssText = 'position:fixed;left:8px;bottom:8px;display:flex;gap:10px;align-items:center;color:#dde;font:12px system-ui;background:#000a;padding:6px 8px;border-radius:6px';
const toggle = document.createElement('button');
toggle.textContent = 'Pause';
const slider = document.createElement('input');
slider.type = 'range';
slider.min = 0;
slider.max = duration;
slider.step = 0.01;
slider.value = 1.1;
bar.append(toggle, slider);
document.body.append(bar);
let playing = true;
let seconds = 1.1;
let last = performance.now();
toggle.addEventListener('click', () => { playing = !playing; toggle.textContent = playing ? 'Pause' : 'Play'; last = performance.now(); });
slider.addEventListener('input', () => { playing = false; toggle.textContent = 'Play'; seconds = Number(slider.value); applyAnimation(seconds); });
slider.addEventListener('change', () => {
  physics.sample(seconds, pose);
  console.log(`t=${seconds.toFixed(2)} s ball y=${pose[ballIndex * 7 + 1].toFixed(3)} crate x=${pose[physics.bodyIndex('crate') * 7].toFixed(3)}`);
});
function frame(now) {
  if (playing) {
    seconds = (seconds + (now - last) / 1000) % duration;
    slider.value = seconds;
    applyAnimation(seconds);
  }
  last = now;
  requestAnimationFrame(frame);
}
new ResizeObserver(() => renderer.resize()).observe(canvas);
requestAnimationFrame(frame);
// Seeking back reproduces an earlier pose exactly: sampling is a pure function of the time.
physics.sample(1.25, pose);
const firstPose = Array.from(pose);
physics.sample(5, pose);
physics.sample(1.25, pose);
console.log('backward seek reproduces the pose:', firstPose.every((value, index) => value === pose[index]));
addEventListener('pagehide', () => {
  renderer.dispose();
  physics.dispose();
});
```

The timeline holds one pose per body per frame, seven floats each, and `sample` blends the two nearest frames at an absolute time, so scrubbing costs the same as playing.

## Bake your own scene

1. Define named bodies, colliders, joints and tick events.
2. Call `planPhysicsScene` to validate the definition and allocation estimate.
3. Await `createPhysicsScene` to bake the bounded recording.
4. Bind visual parts through `physics.bindParts`.
5. Apply bindings at absolute time before uploading changed parts.
6. Call `physics.dispose()` when the recording is no longer needed.

The addon requires the optional peer dependency `@dimforge/rapier3d-compat@0.21.0` (`npm install @dimforge/rapier3d-compat@0.21.0`), and a package-aware dev server such as Vite to resolve it. It bakes body contacts, joints, limits and bounded motors into a timeline.

`physics.sample(time, out)` returns packed poses in `physics.bodyNames` order, seven Float32 values per body `[x, y, z, qx, qy, qz, qw]`, and `physics.bodyIndex(name)` gives a body's index. Supply a retained `out` of `bodyNames.length * 7` values to avoid allocation. The binding replaces a part's world translation and rotation while keeping its scale and matrix identity, so the physics body origin must match the visual part origin. Several parts can bind to one body when they share that origin.

## Options

| Option | Default | Maximum |
| --- | --- | --- |
| `frameCount` | `601`, including frame zero | `maxFrames` |
| `timestep` | `1 / 60` s, rounded to Float32 | 1 s |
| `solverIterations` | `8` | integers 1 to 128 |
| `maxBodies` | `256` | `4096` |
| `maxColliders` | `1024` | `8192` |
| `maxJoints` | `512` | `8192` |
| `maxEvents` | `10000` | `100000` |
| `maxFrames` | `3601` | `1000000` |
| `maxMemoryBytes` | `134217728` | `2147483647` |

Colliders are `ball` (`radius`), `cuboid` (`halfExtents`) and `capsule` (`radius`, `halfHeight` along local Y). Joints are `spherical`, `revolute` and `prismatic` (with a unit `axis`, and optional `limits` and `motor`) and `fixed`. A position motor takes `target`, positive `stiffness`, nonnegative `damping` and positive `maxForce`. A velocity motor takes `target`, positive `damping` and positive `maxForce`.

Tick events run before their tick's integration step. Frame zero records the initial pose, tick zero events affect frame one, and the last valid tick is `frameCount - 2`. An `impulse` event targets a dynamic body with world-space `impulse` and `torqueImpulse` vectors, and an optional world `point`. `duration` equals `(frameCount - 1) * timestep`. `planPhysicsScene` validates the whole definition without loading Rapier, and its frozen result holds the exact `timelineBytes` and an estimated `solverReserveBytes`.

## Limits

- Recorded poses can seek forward or backward. Translations interpolate linearly and quaternions along the shortest arc. Interpolation between frames can show small penetrations, and a smaller timestep reduces them.
- The bake can block the main thread after WASM initialization.
- Cloth, soft bodies and direct skeletal bindings are unsupported by the rigid-body bake. The contract covers mesh colliders, sensors and the cloth recipes in their own sections.
- Bindings validate every target before they update any matrix, and affine matrices with independent nonzero scales are supported. Shear and perspective fail.

The [physics contract](/physics.md) defines supported colliders, joint controls, timing and disposal.

## Common mistakes

- Not calling `physics.dispose()` when the recording is done.
- A visual part whose origin is not the body origin. Use a separate part or another body definition.
- A timeline longer than `maxFrames` or `maxMemoryBytes`. Plan first.
- Expecting the viewer to simulate. Playback only samples the recording.
- A tick past `frameCount - 2`, which is not a valid event tick.
