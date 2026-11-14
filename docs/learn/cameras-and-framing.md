# Cameras and framing

The camera is not an object in the scene. Each call to `renderer.render(frame)` gets a frame object, and the frame sets where the camera is, where it looks and how wide it sees. To move the camera, draw the next frame with other values.

## Frame fields

| Field | Default | Meaning |
| --- | --- | --- |
| `eye` | required | The camera position. |
| `target` | `[0, 1.2, 0]` | The point that the camera looks at. |
| `up` | `[0, 1, 0]` | The direction that is up in the picture. |
| `fov` | about `32.7`, or `45` with `world: true` | The vertical field of view in degrees, more than 0 and less than 180. |
| `near` | `0.1` | The nearest distance that the camera draws. |
| `far` | `100`, or `600` with `world: true` | The farthest distance that the camera draws. |
| `projection` | `'perspective'` | Set `'orthographic'` for a view without perspective. |
| `orthographicHeight` | `4` | The height of an orthographic view in world units. |

The clipping planes must satisfy `0 < near < far`. Keep `far / near` small, because a large ratio makes far surfaces flicker. [Contact detection](#contact-detection) explains how to fix depth precision for very large scenes.

## Orbit with the mouse

Most viewers turn the camera around the subject. Drag in the picture below to orbit, and use the wheel to zoom. On a phone, drag with one finger.

```js live poster=cameras-orbit
import { CrucibleRenderer, box } from 'crucible';

function placeAt(x, y, z, width, height) {
  return new Float32Array([width, 0, 0, 0, 0, height, 0, 0, 0, 0, width, 0, x, y, z, 1]);
}

// One geometry for all towers: the renderer draws them in one batch.
const tower = box(0.04, 2);
const parts = [];
for (let row = -1; row <= 1; row++) {
  for (let column = -1; column <= 1; column++) {
    const height = 0.6 + ((row + 2) * (column + 3)) % 5 * 0.35;
    parts.push({
      name: `Tower ${row} ${column}`,
      geometry: tower,
      matrix: placeAt(column * 1.1, height / 2, row * 1.1, 0.8, height),
      material: { color: [0.32, 0.4 + row * 0.08, 0.55], metallic: 0, roughness: 0.6 },
    });
  }
}

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const renderer = new CrucibleRenderer(canvas, parts);
const orbit = { yaw: 0.7, pitch: 0.45, distance: 7 };

function draw() {
  const flat = Math.cos(orbit.pitch) * orbit.distance;
  const eye = [Math.sin(orbit.yaw) * flat, Math.sin(orbit.pitch) * orbit.distance + 0.6, Math.cos(orbit.yaw) * flat];
  renderer.render({ eye, target: [0, 0.6, 0], fov: 45 });
}

canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  orbit.yaw -= event.movementX * 0.01;
  orbit.pitch = Math.min(1.4, Math.max(0.05, orbit.pitch + event.movementY * 0.01));
  draw();
});
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  orbit.distance = Math.min(20, Math.max(3, orbit.distance * Math.exp(event.deltaY * 0.001)));
  draw();
}, { passive: false });

new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
```

The code keeps three numbers: the angle around the subject (`yaw`), the angle above the floor (`pitch`) and the distance. Each pointer move changes them and draws one frame. The scene does not change, so the page draws only after input.

Try `fov: 20` for a long lens with flat depth, or `fov: 80` for a wide lens with strong perspective. Move `distance` at the same time to keep the subject the same size.

> **Tip:** `touchAction = 'none'` stops the browser from scrolling the page when a finger drags on the canvas. Give the reader a keyboard control too, such as the arrow keys.

## Axis views and fitted framing

`cameraView(name, { target, height, distance })` returns a complete frame for the `'front'`, `'right'`, `'top'` or `'perspective'` view. The first three are orthographic, so parallel lines stay parallel. `fitOrthographicHeight(bounds, view, aspect, padding)` finds the `orthographicHeight` that shows the bounds without cropping. Bounds have `minimum` and `maximum` vectors.

```js live poster=cameras-front
import { CrucibleRenderer, box, sphere, cameraView, fitOrthographicHeight } from 'crucible';

const placeAt = (x, y, z, size) => new Float32Array([size, 0, 0, 0, 0, size, 0, 0, 0, 0, size, 0, x, y, z, 1]);
const parts = [
  { name: 'Base', geometry: box(), matrix: placeAt(0, 0.5, 0, 1), material: { color: [0.3, 0.42, 0.55], metallic: 0, roughness: 0.6 } },
  { name: 'Head', geometry: sphere(), matrix: placeAt(0, 1.45, 0, 0.45), material: { color: [0.9, 0.62, 0.2], metallic: 0, roughness: 0.4 } },
];
const bounds = { minimum: [-0.5, 0, -0.5], maximum: [0.5, 1.9, 0.5] };

const canvas = document.querySelector('#scene');
const renderer = new CrucibleRenderer(canvas, parts);

function draw() {
  const view = cameraView('front', { target: [0, 0.95, 0], distance: 6 });
  const aspect = canvas.clientWidth / canvas.clientHeight;
  view.orthographicHeight = fitOrthographicHeight(bounds, view, aspect, 1.2);
  renderer.render(view);
}

new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
```

The model fills the height of the picture with a margin of 20 percent. Change `'front'` to `'right'`, `'top'` or `'perspective'` to see the other views. A perspective view uses `fitPerspectiveDistance(bounds, view, aspect, padding)` instead, which returns the distance from the eye to the target.

Flat 2D uses XY geometry, the `unlit` material tag and a front orthographic camera. The `crucible/addons/canvas2d` addon supplies a poster scene that you can reuse.

## Camera moves

For a planned shot, `createCameraPath` samples the eye, the target, the field of view and the roll at a time. The frame that `path.sample(seconds)` returns goes straight to `renderer.render`.

```js live poster=cameras-path loop=4
import { CrucibleRenderer, box, sphere, createCameraPath, fovFromFocalLength } from 'crucible';

const placeAt = (x, y, z, size) => new Float32Array([size, 0, 0, 0, 0, size, 0, 0, 0, 0, size, 0, x, y, z, 1]);
const parts = [
  { name: 'Cube', geometry: box(), matrix: placeAt(0, 0.5, 0, 1), material: { color: [0.2, 0.55, 0.38], metallic: 0, roughness: 0.55 } },
  { name: 'Ball', geometry: sphere(), matrix: placeAt(1.4, 0.4, -0.6, 0.4), material: { color: [1, 0.72, 0.3], metallic: 1, roughness: 0.25 } },
];
const path = createCameraPath({
  duration: 4,
  loop: true,
  eye: {
    interpolation: 'SMOOTH',
    keyframes: [
      { time: 0, value: [-3, 1.2, 3.5] },
      { time: 2, value: [3, 2.4, 3.5] },
      { time: 4, value: [-3, 1.2, 3.5] },
    ],
  },
  target: [0.3, 0.5, 0],
  fov: fovFromFocalLength(40, { sensorHeight: 24 }),
});

const canvas = document.querySelector('#scene');
const renderer = new CrucibleRenderer(canvas, parts);
new ResizeObserver(() => renderer.resize()).observe(canvas);

function frame(milliseconds) {
  renderer.render(path.sample(milliseconds / 1000));
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

![The camera swings from left to right in front of a cube and a gold ball, then back](/docs-media/cameras-path.webm "A looping camera path with a 40 mm lens.")

`fovFromFocalLength(40, { sensorHeight: 24 })` turns a lens of 40 mm on a full-frame sensor into a field of view in degrees. The [camera path contract](https://github.com/codepawl/crucible/blob/main/docs/camera-path.md) lists the channels, the tangents, the tracking options and the limits.
