# Animation curves and mixing

A track decides how a value moves between two keyframes. A mixer decides how several clips share the same parts. Both are deterministic: you give an absolute time and get the same pose every time.

## Compare the curves

Four balls travel the same distance in two seconds. From the back: `LINEAR`, `STEP`, `SMOOTH` and `CUBICSPLINE` with tangents that overshoot, then `LINEAR` with an `easeOutBack` easing. Drag the slider to scrub.

```js live poster=animation-curves
import { CrucibleRenderer, sphere, createAnimationClip, createAnimationPlayer, sampleAnimationClip } from 'crucible';


const modes = [
  { name: 'LINEAR', interpolation: 'LINEAR' },
  { name: 'STEP', interpolation: 'STEP' },
  { name: 'SMOOTH', interpolation: 'SMOOTH' },
  { name: 'CUBICSPLINE', interpolation: 'CUBICSPLINE' },
  { name: 'LINEAR + easeOutBack', interpolation: 'LINEAR', easing: 'easeOutBack' },
];

const ball = sphere(40, 24);
const parts = modes.map((mode, index) => ({
  name: mode.name,
  geometry: ball,
  matrix: new Float32Array([0.28, 0, 0, 0, 0, 0.28, 0, 0, 0, 0, 0.28, 0, -2, 0.3, index * 0.8 - 1.6, 1]),
  material: { color: [0.25 + index * 0.15, 0.55, 0.9 - index * 0.12], metallic: 0, roughness: 0.45 },
}));

const tracks = modes.map((mode, index) => {
  const z = index * 0.8 - 1.6;
  const keyframes = mode.interpolation === 'CUBICSPLINE'
    ? [
      { time: 0, value: [-2, 0.3, z], inTangent: [0, 0, 0], outTangent: [5, 0, 0] },
      { time: 2, value: [2, 0.3, z], inTangent: [5, 0, 0], outTangent: [0, 0, 0] },
    ]
    : [
      { time: 0, value: [-2, 0.3, z], ...(mode.easing ? { easing: mode.easing } : {}) },
      { time: 2, value: [2, 0.3, z] },
    ];
  return { target: mode.name, property: 'translation', interpolation: mode.interpolation, keyframes };
});
const clip = createAnimationClip({ duration: 2, loop: true, tracks });

const canvas = document.querySelector('#scene');
const renderer = new CrucibleRenderer(canvas, parts);
const player = createAnimationPlayer(clip, parts);
function draw(seconds) {
  player.apply(seconds);
  renderer.updateParts(parts);
  renderer.render({ eye: [0, 5, 5.5], target: [0, 0, 0], fov: 40 });
}

const bar = document.createElement('div');
bar.style.cssText = 'position:fixed;left:8px;bottom:8px;display:flex;gap:8px;align-items:center;color:#dde;font:12px system-ui;background:#000a;padding:6px 8px;border-radius:6px';
const slider = document.createElement('input');
slider.type = 'range';
slider.min = 0;
slider.max = 2;
slider.step = 0.01;
slider.value = 0;
bar.append('time', slider);
document.body.append(bar);

function report(seconds) {
  const x = sampleAnimationClip(clip, seconds).map(sample => `${sample.target} ${sample.value[0].toFixed(2)}`);
  console.log(`t=${seconds.toFixed(2)}:`, x);
}
let playing = true;
let seconds = 0;
let last = performance.now();
slider.addEventListener('input', () => { playing = false; seconds = Number(slider.value); draw(seconds); });
slider.addEventListener('change', () => report(seconds));
report(0.5);
report(1);
report(1.5);
function frame(now) {
  if (playing) {
    seconds = (seconds + (now - last) / 1000) % 2;
    slider.value = seconds;
    draw(seconds);
  }
  last = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
addEventListener('pagehide', () => renderer.dispose());
```

`STEP` jumps at the next keyframe, `SMOOTH` is smoothstep, and the spline overshoots because its tangents (units per second) are larger than the straight slope of 2 units per second. The eased ball runs past its end and returns.

### Interpolation and easing

`CUBICSPLINE` tracks need `inTangent` and `outTangent` on every keyframe, with at least two keyframes. Tangents are component changes per second, and quaternion tangents are component derivatives. Overshoot clamps emission to zero or more, metallic to `[0, 1]`, roughness to `[1e-8, 1]` and scale to `1e-8` or more. Translation keeps its overshoot.

A keyframe on a `LINEAR` or `SMOOTH` track can carry `easing`. The value is `linear`, `cubic-bezier(x1, y1, x2, y2)` or `ease<In|Out|InOut><Family>`, where Family is Sine, Quad, Cubic, Quart, Quint, Expo, Circ, Back, Bounce or Elastic. `easeOutBack(3)` takes an overshoot and `easeOutElastic(1.5, 0.4)` an amplitude and period. An unknown name throws a `RangeError` that lists the valid forms. The [curve contract](https://github.com/codepawl/crucible/blob/main/docs/animation-curves.md) defines interpolation, overshoot constraints and retained player buffers.

## Mix clips with fades

`createAnimationMixer(parts)` captures the base pose of the named parts. Each clip becomes an action with `clipAction(clip)`. Press the buttons to schedule a crossfade between a slow wobble and a fast spin. The mixer is applied at absolute time, so the fade is the same when you seek.

```js live poster=animation-mixer
import { CrucibleRenderer, box, createAnimationClip, createAnimationMixer } from 'crucible';


const rotation = angle => [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
const part = { name: 'Blade', geometry: box(0.05, 4), matrix: new Float32Array([1.6, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 0.4, 0, 0, 0.6, 0, 1]), material: { color: [0.9, 0.5, 0.25], metallic: 0, roughness: 0.5 } };
const parts = [part];

const wobble = createAnimationClip({ duration: 2, loop: true, tracks: [
  { target: 'Blade', property: 'rotation', interpolation: 'SMOOTH', keyframes: [
    { time: 0, value: rotation(-0.4) }, { time: 1, value: rotation(0.4) }, { time: 2, value: rotation(-0.4) },
  ] },
] });
const spin = createAnimationClip({ duration: 1, loop: true, tracks: [
  { target: 'Blade', property: 'rotation', keyframes: [
    { time: 0, value: rotation(0) }, { time: 0.5, value: rotation(Math.PI) }, { time: 1, value: rotation(Math.PI * 1.999) },
  ] },
] });

const canvas = document.querySelector('#scene');
const renderer = new CrucibleRenderer(canvas, parts);
const mixer = createAnimationMixer(parts);
const wobbleAction = mixer.clipAction(wobble).play({ at: 0 });
const spinAction = mixer.clipAction(spin);
console.log('same clip, same action:', mixer.clipAction(wobble) === wobbleAction);

let clock = 0;
let last = performance.now();
let blendedTo = 'wobble';

// Controls must be authored in nondecreasing time order, so each crossfade starts at the current clock.
function crossFadeTo(name) {
  if (name === blendedTo) return;
  const [from, to] = name === 'spin' ? [wobbleAction, spinAction] : [spinAction, wobbleAction];
  mixer.crossFade(from, to, { at: clock, duration: 0.8 });
  blendedTo = name;
  console.log(`crossFade to ${name} at ${clock.toFixed(2)} s`);
}

const bar = document.createElement('div');
bar.style.cssText = 'position:fixed;left:8px;bottom:8px;display:flex;gap:8px;align-items:center;color:#dde;font:12px system-ui;background:#000a;padding:6px 8px;border-radius:6px';
for (const name of ['wobble', 'spin']) {
  const button = document.createElement('button');
  button.textContent = name;
  button.addEventListener('click', () => crossFadeTo(name));
  bar.append(button);
}
document.body.append(bar);

let reportAt = 0;
function frame(now) {
  clock += (now - last) / 1000;
  last = now;
  mixer.apply(clock);
  renderer.updateParts(parts);
  renderer.render({ eye: [0, 2.2, 4.5], target: [0, 0.6, 0], fov: 40 });
  if (clock > reportAt) {
    reportAt = clock + 1;
    const weights = [wobbleAction, spinAction].map(action => action.getState(clock).weight.toFixed(2));
    console.log(`t=${clock.toFixed(1)} weights wobble/spin`, weights.join(' / '));
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
addEventListener('pagehide', () => renderer.dispose());
```

The [mixer contract](https://github.com/codepawl/crucible/blob/main/docs/animation-mixer.md) defines blending, ownership and control ordering.

1. Create clips and bind their actions through `mixer.clipAction(clip)`.
2. Author `play`, `fadeTo` or `crossFade` controls in nondecreasing time order.
3. Call `mixer.apply(time)` for the desired absolute time.
4. Upload the changed parts with `renderer.updateParts(parts)`.

Playback can seek backward independently of control authoring order. The mixer owns its registered properties and captures their base values during binding.

## Options

| Call | Options | Meaning |
| --- | --- | --- |
| `action.play(...)` | `at`, `offset = 0`, `timeScale = 1`, `weight = 1` | Starts or restarts the action. A negative `timeScale` reverses it and zero holds a pose. |
| `action.stop(at)` | time | Stops contributing from that time on. |
| `action.fadeTo(weight, ...)` | `at`, `duration` | Fades from the weight at `at` to the target. |
| `mixer.crossFade(from, to, ...)` | `at`, `duration` | Fades the source to 0 and the destination to 1; starts a stopped destination at local time 0. |
| `action.getState(time)` | none | Returns `phase` (`scheduled`, `playing`, `fading`, `stopped`), `playing`, `weight` and `localTime`. |

Weights are finite numbers in `[0, 1]`. When the total weight is below one, the base pose fills the rest. Above one, the clips are normalized by their total. Rotations blend by shortest-arc spherical interpolation in registration order, so three or more rotations can differ if you register the actions in another order.

## Common mistakes

- Authoring controls out of time order on the same action. They must not decrease.
- Using `crossFade` and expecting the rest of the scene to freeze. A clip blends only the properties it has tracks for.
- A weight above 1 or a zero fade duration. Both throw.
- Mixing in a second place that writes the same matrices. The mixer owns the properties it registered.
