# Parts and geometry

A scene is an array of parts. Each part has a unique `name`, a shared `geometry`, a column-major 16-value `Float32Array` `matrix`, and a `material`. The renderer reads that array once when it is created, so the shape of the array is the shape of your scene.

Geometry uses `Float32Array` positions and normals, and `Uint32Array` triangle indices. Normals must have unit length and triangles face outward. Optional `uvs` have two values per vertex. Optional `colors` are opaque linear RGB.

## Parts that share one geometry

Transforms must be finite and invertible. Use one geometry object for repeated parts, rather than creating identical meshes for every instance. Each geometry and texture descriptor identity pair becomes an instanced batch.

Drag the picture to orbit. The slider turns one part: the code changes its matrix in place and calls `updateParts`, which uploads the new matrix without building anything again.

```js live poster=parts-shared-geometry
import { CrucibleRenderer, box } from 'crucible';

// A column-major matrix: turn about Y by `angle`, scale by `size`, move to (x, y, z).
function placeAt(x, y, z, size, angle = 0) {
  const cosine = Math.cos(angle) * size;
  const sine = Math.sin(angle) * size;
  return new Float32Array([cosine, 0, -sine, 0, 0, size, 0, 0, sine, 0, cosine, 0, x, y, z, 1]);
}

function addSlider(label, minimum, maximum, value, onInput) {
  let panel = document.querySelector('#controls');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'controls';
    panel.style.cssText = 'position:fixed;left:12px;bottom:12px;display:grid;gap:6px;padding:8px 12px;border-radius:8px;background:#000b;color:#eee;font:12px system-ui';
    document.body.append(panel);
  }
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;gap:8px;align-items:center';
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min: minimum, max: maximum, step: 'any', value });
  input.addEventListener('input', () => onInput(Number(input.value)));
  row.append(label, input);
  panel.append(row);
}

// One geometry object, nine parts: the renderer draws them in a single batch.
const geometry = box(0.08, 4);
const parts = [];
for (let row = 0; row < 3; row++) {
  for (let column = 0; column < 3; column++) {
    parts.push({
      name: `Cube ${row}-${column}`,
      geometry,
      matrix: placeAt((column - 1) * 1.3, 0.5, (row - 1) * 1.3, 0.9),
      material: { color: [0.3, 0.35 + row * 0.1, 0.55 + column * 0.1], metallic: 0.2, roughness: 0.45 },
    });
  }
}

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const renderer = new CrucibleRenderer(canvas, parts, { samples: 4, pixelRatio: 1.25 });
const orbit = { yaw: 0.6, pitch: 0.5, distance: 7 };

function draw() {
  const flat = Math.cos(orbit.pitch) * orbit.distance;
  const eye = [Math.sin(orbit.yaw) * flat, Math.sin(orbit.pitch) * orbit.distance, Math.cos(orbit.yaw) * flat];
  renderer.render({ eye, target: [0, 0.4, 0], fov: 40 });
}

canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  orbit.yaw -= event.movementX * 0.01;
  orbit.pitch = Math.min(1.4, Math.max(0.05, orbit.pitch + event.movementY * 0.01));
  draw();
});

addSlider('Turn the middle cube', 0, 6.283, 0, angle => {
  parts[4].matrix.set(placeAt(0, 0.5, 0, 0.9, angle));
  renderer.updateParts(parts);
  draw();
});

new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);

console.log('parts:', parts.length);
console.log('triangles:', renderer.triangles);
console.log('instance batches:', renderer.batches.length);
console.log('estimated render memory (MiB):', (renderer.memoryPlan.estimatedBytes / 1048576).toFixed(1));
```

The log shows the effect of sharing: nine parts and one batch. If each part had its own `box()` call, there would be nine batches and nine copies of the geometry on the GPU.

`parts[4].matrix.set(...)` writes into the same `Float32Array`, and `updateParts(parts)` uploads the changed matrices and materials from retained buffers. It cannot add a new part, geometry or texture identity: for that, create a new renderer.

> **Tip:** Keep each geometry near its own origin and move it with the matrix. Float32 positions lose detail far from zero, and a shared geometry that sits at the origin can serve every instance.

## Primitives and their detail

`box(fillet, samples)`, `cylinder(segments)`, `sphere(segments, rings)` and `torus(tubeRadius, segments, sides)` are the core primitives. Every call returns `{ positions, normals, indices, uvs }` at unit size, and the part matrix sets the size. The slider below rebuilds the scene with more or fewer segments, so you can see what the numbers buy.

```js live poster=parts-primitive-detail
import { CrucibleRenderer, box, cylinder, sphere, torus } from 'crucible';

function placeAt(x, y, z, size) {
  return new Float32Array([size, 0, 0, 0, 0, size, 0, 0, 0, 0, size, 0, x, y, z, 1]);
}

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const orbit = { yaw: 0.3, pitch: 0.35, distance: 7 };
let renderer = null;

function build(segments) {
  const shapes = [
    ['Box', box(0.08, Math.max(1, Math.round(segments / 8))), [-2.7, 0.5, 0], 1],
    ['Cylinder', cylinder(segments, 0.025, 2), [-1, 0.4, 0], 0.8],
    ['Sphere', sphere(segments, Math.max(2, Math.round(segments * 0.6))), [0.7, 0.5, 0], 0.5],
    ['Torus', torus(0.18, segments, Math.max(3, Math.round(segments / 3))), [2.3, 0.5, 0], 0.45],
  ];
  const parts = shapes.map(([name, geometry, [x, y, z], size], index) => ({
    name,
    geometry,
    matrix: placeAt(x, y, z, size),
    material: { color: [0.3 + index * 0.15, 0.5, 0.75 - index * 0.15], metallic: 0.1, roughness: 0.4 },
  }));
  renderer?.dispose();
  renderer = new CrucibleRenderer(canvas, parts, { samples: 4, pixelRatio: 1.25 });
  renderer.resize();
  draw();
  const counts = shapes.map(([name, geometry]) => `${name} ${geometry.indices.length / 3}`);
  console.log(`segments ${segments}, triangles: ${counts.join(', ')}`);
}

function draw() {
  const flat = Math.cos(orbit.pitch) * orbit.distance;
  const eye = [Math.sin(orbit.yaw) * flat, Math.sin(orbit.pitch) * orbit.distance, Math.cos(orbit.yaw) * flat];
  renderer.render({ eye, target: [0, 0.5, 0], fov: 38 });
}

canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  orbit.yaw -= event.movementX * 0.01;
  orbit.pitch = Math.min(1.4, Math.max(0.05, orbit.pitch + event.movementY * 0.01));
  draw();
});

const panel = document.createElement('label');
panel.style.cssText = 'position:fixed;left:12px;bottom:12px;display:flex;gap:8px;align-items:center;padding:8px 12px;border-radius:8px;background:#000b;color:#eee;font:12px system-ui';
const slider = document.createElement('input');
Object.assign(slider, { type: 'range', min: 3, max: 64, step: 1, value: 12 });
slider.addEventListener('change', () => build(Number(slider.value)));
panel.append('Segments', slider);
document.body.append(panel);

new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
build(12);
```

At 12 segments the sphere is visibly faceted, and at 48 it looks round. The cost is the triangle count, which grows with the product of segments and rings. Every constructor checks its vertex count before it samples, with a fixed limit of one million vertices.

| Constructor | Shape | Input bounds |
| --- | --- | --- |
| `box(bevel = 0.08, subdivisions = 6)` | Cube with each axis from -0.5 to 0.5. | Bevel from 0 to 0.5. Subdivisions from 1 to 128. |
| `sphere(segments = 64, rings = 40)` | Unit-radius sphere. | Segments from 3 to 2048. Rings from 2 to 2048. |
| `cylinder(segments = 80, bevel = 0.025, bevelSegments = 6)` | Y-axis cylinder with radius 1 and height 1. | Segments from 3 to 2048. Bevel from 0 to 0.5. Bevel segments from 1 to 128. |
| `torus(tubeRadius = 0.08, segments = 96, sides = 24, arc = 2π, start = 0)` | XY torus with major radius 1. Partial arcs have end caps. | Positive tube radius. Segments from 3 to 2048. Sides from 3 to 128. Arc within (0, 2π]. Start uses radians. |

Counts must be integers and numbers must stay finite in Float32. The [primitive contract](https://github.com/codepawl/crucible/blob/main/docs/primitives.md) covers closed seams and the geometry limits. Primitives do not perform Boolean operations, sculpting or collision resolution.

## Constructor options that matter for parts

Supply a real HTML canvas with nonzero CSS width and height.

```js
const renderer = new CrucibleRenderer(canvas, parts, {
  ground: false, hdr: true, samples: 4, pixelRatio: 1.25, memoryBudgetMiB: 256,
});
renderer.render({ eye: [3, 2, 4], target: [0, 0, 0] });
```

| Part field | Meaning |
| --- | --- |
| `name` | Unique text label. Error messages name the part with it. |
| `geometry` | Shared object with `positions`, `normals`, `indices` and optional `uvs` and `colors`. |
| `matrix` | Column-major `Float32Array(16)`, finite and invertible. The translation is the last four values. |
| `material` | `color`, `metallic` and `roughness` are required. `emission` and `tag` are optional, and `tag: 'surface'` is the standard material. |

The [renderer reference](#renderer-reference) lists every constructor option.

## Common mistakes

- **A row-major matrix.** The translation belongs in positions 12, 13 and 14. In row-major order it lands in the wrong place, and the part moves or shears.
- **One geometry per instance.** Identical meshes created in a loop produce one batch each. Create the geometry once and reuse the object.
- **Normals that are not unit length, or triangles that face inward.** Lighting looks wrong and the surface can vanish from one side.
- **A singular matrix.** A scale of 0 on any axis makes the transform non-invertible, and the renderer throws `Singular transform` with the part name.
- **Adding parts after construction.** `updateParts` only changes matrices and materials of parts that exist. A new geometry or texture needs a new renderer, and `dispose()` frees the old one.
- **A zero-size canvas.** Give the canvas a CSS width and height before you create the renderer.
