# Introduction

Crucible is a 3D engine for the browser. It draws with WebGL2 and runs in every current desktop and phone browser. You describe a scene as a list of parts, and the renderer draws a frame from a camera.

The program below is a complete Crucible scene. It runs on this page. Drag the picture to turn the camera. Change a number in the code, and the picture changes.

```js live poster=introduction-cube
import { CrucibleRenderer, box } from 'crucible';

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const cube = {
  name: 'Cube',
  geometry: box(),
  matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 1]),
  material: { color: [0.85, 0.45, 0.2], metallic: 0, roughness: 0.4 },
};
const renderer = new CrucibleRenderer(canvas, [cube]);
const orbit = { yaw: 0.6, pitch: 0.4, distance: 4.7 };

function draw() {
  const flat = Math.cos(orbit.pitch) * orbit.distance;
  const eye = [Math.sin(orbit.yaw) * flat, Math.sin(orbit.pitch) * orbit.distance + 0.5, Math.cos(orbit.yaw) * flat];
  renderer.render({ eye, target: [0, 0.5, 0] });
}

// Drag to orbit: each pointer move changes the angles and draws one frame.
canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  orbit.yaw -= event.movementX * 0.01;
  orbit.pitch = Math.min(1.4, Math.max(0.05, orbit.pitch + event.movementY * 0.01));
  draw();
});
new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
```

## What you can build

Each demo on this site is a Crucible scene. Open one to see what the engine does, then read its topic in these docs.

```cards
Object studio | /object.html | A robot model with orbit controls, lighting looks and an exploded view. | /previews/wall-e.webp
Procedural modeling | /modeling.html | A lantern made from lathe, extrude and tube geometry. | /previews/modeling.webp
Nature | /nature.html | Terrain, trees and grass with wind and a sun you can move. | /previews/grass.webp
Assets | /assets.html | GLB models loaded, lit and animated. | /previews/assets.webp
Showcase | /showcase.html | Large scenes: an airport, a data center and a port. | /previews/showcase-airport.webp
2D | /view2d.html | Flat posters drawn with an orthographic camera. | /previews/view2d.webp
```

## How a scene works

A Crucible scene has three pieces. You make them in this order.

![Parts go into CrucibleRenderer one time, and each render call draws a picture from a camera](/docs-media/scene-flow.svg)

1. **Parts.** Each part has a name, a geometry, a position matrix and a material.
2. **Renderer.** `new CrucibleRenderer(canvas, parts)` uploads the parts to the graphics card one time.
3. **Frames.** `renderer.render({ eye, target })` draws one picture from a camera at `eye` that looks at `target`.

To move something, change the part and call `renderer.updateParts(parts)`. Then draw the next frame. The renderer keeps the uploaded geometry, so a frame costs little.

## What Crucible is not

Crucible does not copy the three.js API. If you know three.js, [If you know three.js](#if-you-know-three-js) maps its common calls to Crucible, and the optional `three-compat` addon builds Crucible parts from the common three.js names. It supports a subset, so code that uses other three.js names needs changes. Crucible also has no mouse editor like Blender. You build scenes in code, or an AI agent builds them through the MCP server.

## How these docs are organized

- **Start here** takes you from an empty folder to an animated scene. Read these three pages in order.
- **Build a scene**, **Worlds** and **Animate and interact** explain one subject each, with the options and limits.
- **Reference and workflows** lists the renderer options, the exports, the memory rules and the work with AI agents.

You need to know some JavaScript and how to run a command in a terminal. You do not need to know WebGL or 3D math.

```cards
Install Crucible | #install | Make a project and add the package. Five minutes.
Your first scene | #first-scene | Draw, color, place and animate shapes step by step.
```
