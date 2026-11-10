# Your first scene

In this tutorial, you build the scene below: three shapes on a floor, with a turning cube. Each step adds one idea and shows the result. Every example runs on this page, so you can change the code before you copy it.

![A green cube turns between a gold ball and a red ring on a dark floor](/docs-media/first-scene-animate.webm "The finished scene.")

You learn how to:

- give a scene a canvas to draw on
- describe a part with a geometry, a matrix and a material
- change the color and the surface of a material
- place and size shapes
- animate a part and draw frames in a loop

Start with the project from [Install](#install). It has Vite and the `67js` package.

## 1. Add a canvas

67js draws into an HTML `<canvas>` element. Replace the contents of `index.html` with this page:

```html file=index.html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My first 67js scene</title>
    <style>
      html, body { margin: 0; height: 100%; background: #101014; }
      #scene { display: block; width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <canvas id="scene"></canvas>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
```

The canvas fills the window. The renderer reads the size of the canvas on the page, so the canvas must have a width and a height in CSS.

Start the development server:

```sh
npm run dev
```

It prints a local address:

```text
  VITE v8.3.6  ready in 329 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
```

Open the `Local` address. The page is dark and empty, because `main.js` does not draw yet.

## 2. Draw a cube

Replace the contents of `src/main.js` with this code. You can delete `src/counter.js` and `src/style.css`, because this tutorial does not use them.

```js live poster=first-scene-cube
import { Renderer67, box } from '67js';

const canvas = document.querySelector('#scene');
const cube = {
  name: 'Cube',
  geometry: box(),
  matrix: new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0.5, 0, 1,
  ]),
  material: { color: [0.2, 0.55, 0.38], metallic: 0, roughness: 0.55 },
};
const renderer = new Renderer67(canvas, [cube]);

function draw() {
  renderer.render({ eye: [2.5, 1.8, 3.5], target: [0, 0.5, 0] });
}

new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
```

The browser shows a green cube on a dark floor. The code has four parts:

- **The part.** `cube` is a part. Each part has a unique `name`, a `geometry`, a `matrix` and a `material`.
- **The geometry.** `box()` makes a cube with rounded edges. Each side is 1 unit long, and its center is at the origin.
- **The matrix.** The 16 numbers place the part in the world. The last row moves the cube up by 0.5, so it stands on the floor. The [next step](#first-scene/place-more-shapes) shows a shorter way to write it.
- **The renderer.** `new Renderer67(canvas, parts)` uploads the parts. `renderer.render()` draws one picture from a camera at `eye` that looks at `target`.

`ResizeObserver` calls `resize()` and draws again when the canvas changes size. It also runs one time at the start, so it draws the first frame.

> **Tip:** The renderer adds a floor by default. For a scene with its own ground, pass `{ ground: false }` as the third argument of `Renderer67`.

## 3. Change the material

A material sets how light hits the surface. Change the material of the cube to gold:

```js live poster=first-scene-material
import { Renderer67, box } from '67js';

const canvas = document.querySelector('#scene');
const cube = {
  name: 'Cube',
  geometry: box(0.2),
  matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 1]),
  material: { color: [1, 0.72, 0.3], metallic: 1, roughness: 0.25 },
};
const renderer = new Renderer67(canvas, [cube]);

function draw() {
  renderer.render({ eye: [2.5, 1.8, 3.5], target: [0, 0.5, 0] });
}

new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
```

The cube is now shiny gold with rounder edges. `box(0.2)` sets the edge radius. The default is `0.08`.

| Field | Values | Effect |
| --- | --- | --- |
| `color` | three numbers from 0 to 1 | Red, green and blue in linear light. `[1, 1, 1]` is white. |
| `metallic` | 0 to 1 | 0 is paint or plastic. 1 is metal, which reflects its own color. |
| `roughness` | 0 to 1 | 0 is a mirror. 1 is chalk. |
| `emission` | 0 or more | Light that the surface gives off. Optional, the default is 0. |

Try `roughness: 0.6` for brushed metal, or `metallic: 0` with `roughness: 0.9` for clay. [Materials and color](#materials-and-color) lists the textures and the special tags.

## 4. Place more shapes

Writing 16 numbers for every part is slow. A small function can make the matrix from a position and a size:

```js live poster=first-scene-shapes
import { Renderer67, box, sphere, torus } from '67js';

// Column-major 4x4 matrix: scale by `size`, then move to x, y, z.
function placeAt(x, y, z, size = 1) {
  return new Float32Array([
    size, 0, 0, 0,
    0, size, 0, 0,
    0, 0, size, 0,
    x, y, z, 1,
  ]);
}

const canvas = document.querySelector('#scene');
const parts = [
  {
    name: 'Cube',
    geometry: box(),
    matrix: placeAt(0, 0.5, 0),
    material: { color: [0.2, 0.55, 0.38], metallic: 0, roughness: 0.55 },
  },
  {
    name: 'Ball',
    geometry: sphere(),
    matrix: placeAt(-1.5, 0.45, 0.3, 0.45),
    material: { color: [1, 0.72, 0.3], metallic: 1, roughness: 0.25 },
  },
  {
    name: 'Ring',
    geometry: torus(0.25),
    matrix: placeAt(1.5, 0.55, 0.3, 0.45),
    material: { color: [0.75, 0.18, 0.28], metallic: 0, roughness: 0.4 },
  },
];
const renderer = new Renderer67(canvas, parts);

function draw() {
  renderer.render({ eye: [0, 2, 5], target: [0, 0.4, 0] });
}

new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
```

The scene has a ball on the left, the cube in the middle and a ring on the right. The camera moved to the front, so all three are in view.

Each shape has a known size at scale 1. Use the `size` argument to make it smaller or larger.

| Function | Shape at scale 1 |
| --- | --- |
| `box(edge)` | A cube with sides of 1 |
| `sphere(segments, rings)` | A ball with a radius of 1 |
| `torus(tube)` | A ring with a radius of 1 in the XY plane, and a tube radius of `tube` |
| `cylinder(segments)` | A radius of 1 and a height of 1 |

The Y axis points up. One unit is one meter for the lights and the fog. [Parts and geometry](#parts-and-geometry) explains matrices and shared geometry.

## 5. Animate the cube

To animate a part, change its matrix, upload the change, and draw again in each frame. This version turns the cube about the Y axis:

```js live poster=first-scene-animate loop=1.9635
import { Renderer67, box, sphere, torus } from '67js';

// Scale by `size`, turn by `angle` radians about the Y axis, then move to x, y, z.
function placeAt(x, y, z, size = 1, angle = 0) {
  const cos = Math.cos(angle) * size;
  const sin = Math.sin(angle) * size;
  return new Float32Array([
    cos, 0, -sin, 0,
    0, size, 0, 0,
    sin, 0, cos, 0,
    x, y, z, 1,
  ]);
}

const canvas = document.querySelector('#scene');
const cube = {
  name: 'Cube',
  geometry: box(),
  matrix: placeAt(0, 0.5, 0),
  material: { color: [0.2, 0.55, 0.38], metallic: 0, roughness: 0.55 },
};
const parts = [
  cube,
  {
    name: 'Ball',
    geometry: sphere(),
    matrix: placeAt(-1.5, 0.45, 0.3, 0.45),
    material: { color: [1, 0.72, 0.3], metallic: 1, roughness: 0.25 },
  },
  {
    name: 'Ring',
    geometry: torus(0.25),
    matrix: placeAt(1.5, 0.55, 0.3, 0.45),
    material: { color: [0.75, 0.18, 0.28], metallic: 0, roughness: 0.4 },
  },
];
const renderer = new Renderer67(canvas, parts);

function frame(milliseconds) {
  const seconds = milliseconds / 1000;
  cube.matrix = placeAt(0, 0.5, 0, 1, seconds * 0.8);
  renderer.updateParts(parts);
  renderer.render({ eye: [0, 2, 5], target: [0, 0.4, 0] });
  requestAnimationFrame(frame);
}

new ResizeObserver(() => renderer.resize()).observe(canvas);
requestAnimationFrame(frame);
```

The cube turns at 0.8 radians per second. The loop works like this:

1. `requestAnimationFrame` calls `frame` before the browser paints, about 60 times each second.
2. `frame` sets a new matrix on the cube from the time.
3. `renderer.updateParts(parts)` uploads the changed matrices. It does not upload the geometry again.
4. `renderer.render()` draws the frame.

The angle comes from the time, not from a counter. So a slow computer shows the same position at the same second, and an export can ask for any time. [Deterministic animation](#deterministic-animation) does the same with keyframes.

> **Warning:** `updateParts` changes matrices and materials only. To add or remove parts, make a new renderer and call `dispose()` on the old one.

## 6. Clean up

A renderer holds memory on the graphics card. When your page or component goes away, stop the loop and release the renderer:

```js
let frameRequest = requestAnimationFrame(frame);
const observer = new ResizeObserver(() => renderer.resize());
observer.observe(canvas);

window.addEventListener('pagehide', () => {
  cancelAnimationFrame(frameRequest);
  observer.disconnect();
  renderer.dispose();
}, { once: true });
```

Store the request from each `requestAnimationFrame` call in `frameRequest`, so `cancelAnimationFrame` stops the latest one. In React, Vue or Svelte, put this code in the cleanup function of the component.

## What you built

You made a scene with three parts, gave them materials, placed them with matrices and animated one of them. Most 67js programs follow the same pattern.

```cards
Parts and geometry | #parts-and-geometry | Matrices, shared geometry and your own meshes.
Cameras and framing | #cameras-and-framing | Field of view, axis views and orthographic cameras.
Effects and lighting | #effects-and-lighting | Exposure, bloom, sky, sun and fog.
Import and export models | #import-and-export-models | Load GLB files and save your scene.
```
