# Deterministic animation

An animation clip in Crucible is data: tracks of keyframes that name a part and a property. A player turns a time in seconds into part transforms. It keeps no state between calls, so the same time always gives the same picture, and you can seek forward, backward or to a fixed time for an export.

## Play, pause and scrub

The cube moves along a smooth path and turns, and the sphere pulses and glows. Press Pause and drag the slider: the scene follows the time you set, in either direction. The console shows what `sampleAnimationClip` returns and proves that a seek back reproduces an earlier frame.

```js live poster=deterministic-animation
import { CrucibleRenderer, box, sphere, createAnimationClip, sampleAnimationClip, createAnimationPlayer } from 'crucible';


function placeAt(x, y, z, size) {
  return new Float32Array([size, 0, 0, 0, 0, size, 0, 0, 0, 0, size, 0, x, y, z, 1]);
}

const parts = [
  { name: 'Cube', geometry: box(0.06, 4), matrix: placeAt(-1.2, 0.5, 0, 0.9), material: { color: [0.9, 0.45, 0.2], metallic: 0, roughness: 0.5 } },
  { name: 'Ball', geometry: sphere(48, 32), matrix: placeAt(1.2, 0.5, 0, 0.5), material: { color: [0.3, 0.6, 0.95], metallic: 0, roughness: 0.4, emission: 0 } },
];

const quarterTurn = angle => [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
const clip = createAnimationClip({
  duration: 4,
  loop: true,
  tracks: [
    { target: 'Cube', property: 'translation', interpolation: 'SMOOTH', keyframes: [
      { time: 0, value: [-1.2, 0.5, 0] }, { time: 2, value: [-1.2, 1.6, 0.6] }, { time: 4, value: [-1.2, 0.5, 0] },
    ] },
    { target: 'Cube', property: 'rotation', interpolation: 'LINEAR', keyframes: [
      { time: 0, value: quarterTurn(0) }, { time: 2, value: quarterTurn(Math.PI) }, { time: 4, value: quarterTurn(Math.PI * 1.999) },
    ] },
    { target: 'Ball', property: 'scale', interpolation: 'SMOOTH', keyframes: [
      { time: 0, value: [0.5, 0.5, 0.5] }, { time: 2, value: [0.9, 0.9, 0.9] }, { time: 4, value: [0.5, 0.5, 0.5] },
    ] },
    { target: 'Ball', property: 'emission', interpolation: 'LINEAR', keyframes: [
      { time: 0, value: 0 }, { time: 2, value: 1.5 }, { time: 4, value: 0 },
    ] },
  ],
});

console.log('samples at 1 s:', sampleAnimationClip(clip, 1).map(sample => `${sample.target}.${sample.property}`));
console.log('Cube translation at 1 s:', sampleAnimationClip(clip, 1)[0].value);

const canvas = document.querySelector('#scene');
const renderer = new CrucibleRenderer(canvas, parts);
const player = createAnimationPlayer(clip, parts);

function draw(seconds) {
  player.apply(seconds);
  renderer.updateParts(parts);
  renderer.render({ eye: [0, 2.2, 6], target: [0, 0.8, 0], fov: 40, time: seconds });
}

// Seek forward, then back: absolute time gives the same matrix both ways.
draw(1.5);
const first = Array.from(parts[0].matrix);
draw(3.2);
draw(1.5);
console.log('seek back reproduces the frame:', first.every((value, index) => value === parts[0].matrix[index]));

const bar = document.createElement('div');
bar.style.cssText = 'position:fixed;left:8px;bottom:8px;display:flex;gap:8px;align-items:center;color:#dde;font:12px system-ui;background:#000a;padding:6px 8px;border-radius:6px';
const toggle = document.createElement('button');
const slider = document.createElement('input');
slider.type = 'range';
slider.min = 0;
slider.max = clip.duration;
slider.step = 0.01;
slider.value = 0;
bar.append(toggle, slider);
document.body.append(bar);

let playing = true;
let seconds = 0;
let last = performance.now();
toggle.textContent = 'Pause';
toggle.addEventListener('click', () => {
  playing = !playing;
  toggle.textContent = playing ? 'Pause' : 'Play';
  last = performance.now();
});
slider.addEventListener('input', () => {
  playing = false;
  toggle.textContent = 'Play';
  seconds = Number(slider.value);
  draw(seconds);
});
slider.addEventListener('change', () => console.log(`t = ${seconds.toFixed(2)} s, Ball scale`, sampleAnimationClip(clip, seconds)[2].value));

function frame(now) {
  if (playing) {
    seconds = (seconds + (now - last) / 1000) % clip.duration;
    slider.value = seconds;
    draw(seconds);
  }
  last = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
addEventListener('pagehide', () => renderer.dispose());
```

The loop keeps a time, calls `player.apply(seconds)` and uploads the changed matrices with `renderer.updateParts(parts)`. The slider calls the same `draw` with another time. Nothing in `draw` reads the previous frame.

## Tracks

A track names one part (`target`) and one `property`. Each target property can have one track. The keyframes are absolute values, not offsets.

| Option | Values | Meaning |
| --- | --- | --- |
| `target` | A unique part name | The part that the track drives. |
| `property` | `translation`, `rotation`, `scale`, `metallic`, `roughness`, `emission` | Rotation is a quaternion in XYZW order. Scale cannot be negative; zero is allowed and hides the node. |
| `interpolation` | `LINEAR` (default), `STEP`, `SMOOTH`, `CUBICSPLINE` | How values blend between keyframes. |
| `keyframes` | `{ time, value }` | Times are in seconds, from 0 to the clip `duration`. |
| keyframe `easing` | `easeOutBack`, `easeInOutCubic`, `cubic-bezier(...)` and the other names | Shapes the segment that starts at that keyframe. |
| clip `loop` | `true` or `false` | A looping clip wraps the time; otherwise the time clamps to the ends. |

Metallic and roughness stay within their material range (roughness above 0), and emission cannot be negative. [Animation curves and mixing](#animation-curves-and-mixing) covers the interpolation modes and easing in detail.

## Sampling without parts

`sampleAnimationClip(clip, time)` returns an array of `{ target, property, value }` and does not touch any part. Use it to read a value, to test a clip or to feed another system. `createAnimationPlayer(clip, parts)` does the binding once and then each `apply(time)` writes the matrices.

## Playback and export

Preserve the original part graph and apply absolute time, so seeking backwards reproduces the scene. Use `requestAnimationFrame` for playback and pause when the page is hidden. For an export, use a fixed sample time per frame instead of the wall clock, as the [images and films](#images-and-films) commands do.

## Common mistakes

- Two parts with the same name: the tracks cannot tell them apart, and the renderer refuses duplicate part objects.
- Adding `dt` to the part matrix each frame. Apply an absolute time instead, or a pause and a seek will drift.
- A rotation that is not a quaternion. Pass four numbers in XYZW order.
- A scale of 0 or a negative scale. Keep scale above zero.
- Easing on a `STEP` or `CUBICSPLINE` track. It throws a `RangeError`.
- A keyframe time past `duration`. The clip refuses it.
