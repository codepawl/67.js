# Procedural modeling

Version `0.4.0` provides `lathe`, `extrude` and `tube` through `crucible/addons/modeling`, and the addon also has `curve`. They generate static geometry from radius and height profiles, polygon contours and XYZ paths. Extrusion supports holes and bevels. Open tube ends remain uncapped.

The workflow has four steps:

1. Choose a profile, contour or path in local coordinates.
2. Generate the geometry once with the matching addon function.
3. Assign the result to a part before creating `CrucibleRenderer`.
4. Share the geometry among repeated parts.

Each result has Float32 positions, normalized normals and UV channel zero, plus Uint32 triangle indices. Inputs are copied. The generators run when you build the scene, not every frame.

## Lathe: spin a profile into a vessel

`lathe(profile, options)` revolves `[radius, height]` pairs around the Y axis. The first slider changes the belly radius of the profile and the second changes the number of segments around the axis. Both rebuild the vase, and the log shows what each build costs. Drag to orbit.

```js live poster=modeling-lathe
import { CrucibleRenderer } from 'crucible';
import { lathe } from 'crucible/addons/modeling';

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const orbit = { yaw: 0.5, pitch: 0.3, distance: 6 };
const state = { belly: 0.85, segments: 24 };
let renderer = null;

function build() {
  const profile = [[0, 0], [0.5, 0], [state.belly, 0.7], [0.55, 1.5], [0.4, 2], [0.5, 2.15], [0, 2.15]];
  const started = performance.now();
  const geometry = lathe(profile, { segments: state.segments });
  const milliseconds = performance.now() - started;
  const part = {
    name: 'Vase',
    geometry,
    matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    material: { color: [0.75, 0.35, 0.22], metallic: 0, roughness: 0.4 },
  };
  renderer?.dispose();
  renderer = new CrucibleRenderer(canvas, [part], { samples: 4, pixelRatio: 1.25 });
  renderer.resize();
  draw();
  console.log(`belly ${state.belly.toFixed(2)}, segments ${state.segments}: ${geometry.positions.length / 3} vertices, ${geometry.indices.length / 3} triangles, ${milliseconds.toFixed(2)} ms`);
}

function draw() {
  const flat = Math.cos(orbit.pitch) * orbit.distance;
  const eye = [Math.sin(orbit.yaw) * flat, Math.sin(orbit.pitch) * orbit.distance + 1, Math.cos(orbit.yaw) * flat];
  renderer.render({ eye, target: [0, 1, 0], fov: 38 });
}

canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  orbit.yaw -= event.movementX * 0.01;
  orbit.pitch = Math.min(1.4, Math.max(0.05, orbit.pitch + event.movementY * 0.01));
  draw();
});

const panel = document.createElement('div');
panel.style.cssText = 'position:fixed;left:12px;bottom:12px;display:grid;gap:6px;padding:8px 12px;border-radius:8px;background:#000b;color:#eee;font:12px system-ui';
function addSlider(label, key, minimum, maximum, step) {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:space-between';
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min: minimum, max: maximum, step, value: state[key] });
  input.addEventListener('change', () => {
    state[key] = Number(input.value);
    build();
  });
  row.append(label, input);
  panel.append(row);
}
addSlider('Belly radius', 'belly', 0.5, 1.3, 0.05);
addSlider('Segments', 'segments', 3, 96, 1);
document.body.append(panel);

new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
build();
```

The profile lists points from the bottom to the top: a radius of zero closes the base on the axis, the belly radius is the widest point, and the last two points make the lip and close the top. A profile whose ends meet the axis gives a closed shape. A partial `sweep` or an open profile end stays open.

With 3 segments the vase becomes a triangular prism, which shows what the number controls. At 96 segments the vertex count is thirty times higher for a shape that looks the same as 48.

## Extrude, tube and curve

`extrude` pushes a flat outline along +Z. `tube` sweeps a circle along a path through XYZ points. `curve` does the same along cubic Bezier spans and can thin toward its end. The slider changes the bevel of the panel, so the geometry is rebuilt and the log prints the sizes.

```js live poster=modeling-shapes
import { CrucibleRenderer } from 'crucible';
import { extrude, tube, curve } from 'crucible/addons/modeling';

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const orbit = { yaw: 0.35, pitch: 0.3, distance: 8 };
let renderer = null;

function placeAt(x, y, z, size) {
  return new Float32Array([size, 0, 0, 0, 0, size, 0, 0, 0, 0, size, 0, x, y, z, 1]);
}

function build(bevel) {
  const panel = extrude([[-1, -1], [1, -1], [1, 1], [-1, 1]], {
    holes: [[[-0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0.5, -0.5]]],
    depth: 0.3,
    bevel,
  });
  const cable = tube([[0, 0, 0], [0.8, 1.2, 0.5], [1.6, 0.2, -0.4], [2.2, 1.4, 0]], { radius: 0.07 });
  const horn = curve([[0, 0, 0], [0.5, 0.9, 0], [1.2, 1.2, 0.3]], { radius: 0.3, taper: [1, 0.05] });
  const parts = [
    { name: 'Panel', geometry: panel, matrix: placeAt(-2.6, 1, 0, 1), material: { color: [0.3, 0.45, 0.7], metallic: 0.1, roughness: 0.4 } },
    { name: 'Cable', geometry: cable, matrix: placeAt(-0.5, 0, 0, 1), material: { color: [0.85, 0.7, 0.2], metallic: 0, roughness: 0.4 } },
    { name: 'Horn', geometry: horn, matrix: placeAt(2.2, 0, 0, 1), material: { color: [0.8, 0.3, 0.3], metallic: 0, roughness: 0.45 } },
  ];
  renderer?.dispose();
  renderer = new CrucibleRenderer(canvas, parts, { samples: 4, pixelRatio: 1.25 });
  renderer.resize();
  draw();
  const counts = parts.map(part => `${part.name} ${part.geometry.indices.length / 3}`);
  console.log(`bevel ${bevel.toFixed(2)}, triangles: ${counts.join(', ')}`);
}

function draw() {
  const flat = Math.cos(orbit.pitch) * orbit.distance;
  const eye = [Math.sin(orbit.yaw) * flat, Math.sin(orbit.pitch) * orbit.distance + 0.8, Math.cos(orbit.yaw) * flat];
  renderer.render({ eye, target: [0.2, 0.8, 0], fov: 38 });
}

canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  orbit.yaw -= event.movementX * 0.01;
  orbit.pitch = Math.min(1.4, Math.max(0.05, orbit.pitch + event.movementY * 0.01));
  draw();
});

const row = document.createElement('label');
row.style.cssText = 'position:fixed;left:12px;bottom:12px;display:flex;gap:8px;align-items:center;padding:8px 12px;border-radius:8px;background:#000b;color:#eee;font:12px system-ui';
const slider = document.createElement('input');
Object.assign(slider, { type: 'range', min: 0, max: 0.2, step: 0.01, value: 0.05 });
slider.addEventListener('change', () => build(Number(slider.value)));
row.append('Panel bevel', slider);
document.body.append(row);

new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
build(0.05);
```

The panel has a square hole, and its bevel adds rounded edges on both caps, from `-bevelThickness` to `depth + bevelThickness` along Z. Push the slider to its end and see how the corners round. A bevel that is large compared with the hole can make surfaces cross, so reduce it to fit the local clearance.

The horn uses `taper: [1, 0.05]`, which spreads two radius factors along the length of the curve: full radius at the start and a twentieth at the tip. Open curves get flat caps, so the surface is closed and works with Boolean tools.

## Options

| Function | Options and defaults | Limits |
| --- | --- | --- |
| `lathe(profile, options)` | `segments = 64`, `startAngle = 0`, `sweep = 2π`, `maxVertices = 250000` | Radii are nonnegative, with at least one positive. Segments from 3 to 2048. Angles in radians. |
| `extrude(contour, options)` | `holes = []`, `depth = 1`, `steps = 1`, `bevel = 0`, `bevelThickness = bevel`, `bevelSegments = 3`, `maxVertices` | Steps from 1 to 256. Bevel segments from 1 to 32. At most 128 holes. Holes stay strictly inside the contour and cannot overlap, touch or nest. |
| `tube(path, options)` | `radius = 0.1`, `segments = 64`, `radialSegments = 12`, `closed = false`, `maxVertices` | Open paths need two points, closed paths three. Segments from 3 to 2048. Radial segments from 3 to 128. |
| `curve(points, options)` | `closed = false`, `radius = 0.05`, `taper`, `profile`, `resolution = 12`, `radialSegments = 8`, `maxVertices` | 2 to 1024 points (3 when closed). `resolution` 1 to 64. `taper` has 2 to 64 non-negative factors. `profile` has 3 to 256 `[x, y]` points. |

Every generator accepts at most 4096 input points, and `maxVertices` ranges from 3 to 1000000. It bounds geometry size, not total browser memory. The [modeling contract](/modeling.md) defines input bounds, winding, bevel limits and resource estimates, and also covers the `text` generator and `registerFont`.

A `curve` point is `[x, y, z]` with automatic smooth handles, or `{ position, handleIn, handleOut }` with absolute handle positions. A lone handle is mirrored.

## Common mistakes

- **Expecting a solid Boolean.** These generators do not perform solid Boolean operations or provide a mesh editor. Build the pieces and place them with part matrices.
- **A hole that touches the contour.** `extrude` throws `Every hole must lie strictly inside the contour.` Move the hole inward or make it smaller.
- **Consecutive duplicate points.** A path or profile with two identical neighbors throws. Remove the repeat.
- **Looking for caps on an open tube.** `tube` leaves its ends open. Use `curve`, which adds flat caps, when the shape must be closed.
- **A folded lathe profile.** A profile that doubles back can intersect itself.
- **Generating inside the render loop.** Build once, then share the geometry. The renderer does not take new geometry after construction.

See also the [scene graph](https://github.com/codepawl/crucible/blob/main/docs/scene-graph.md), which supports hierarchy and pivots without changing mesh topology, and the [modeling demo](https://crucible.codepawl.com/modeling.html), which combines these tools in a lantern scene.
