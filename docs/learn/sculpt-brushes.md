# Sculpt brushes

Version `0.4.0` provides `sculptGeometry` through `crucible/addons/sculpt`. It applies `inflate`, directional `displace` and `smooth` strokes to a copy of static indexed geometry. Stroke centers, radii and strengths use geometry-local units. The result preserves topology, UVs and colors, and rebuilds normals. The source geometry stays unchanged, and replaying the same strokes gives the same geometry.

The workflow has four steps:

1. Define bounded strokes on the undeformed mesh.
2. Call `sculptGeometry` before creating the renderer.
3. Inspect the resulting surface for folds or intersections.
4. Rebuild surface patches and query indices after changing geometry.

## One brush on a sphere

The scene below sculpts a unit sphere with one stroke centered on the front. Choose the brush, and change its strength and radius. Each change builds the geometry again, and the log reports the vertex count, the time and how far the farthest vertex moved. Drag the picture to turn the sphere and look at the bump from the side.

```js live poster=sculpt-one-brush
import { CrucibleRenderer, sphere } from 'crucible';
import { sculptGeometry } from 'crucible/addons/sculpt';

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const orbit = { yaw: 0.9, pitch: 0.25, distance: 4.2 };
const brush = { type: 'inflate', strength: 0.3, radius: 0.7 };
const original = sphere(64, 40);
let renderer = null;

function strokeFor() {
  // A smooth stroke takes a blend from 0 to 1, so a negative strength would throw.
  const strength = brush.type === 'smooth' ? Math.min(1, Math.max(0, brush.strength)) : brush.strength;
  const stroke = { type: brush.type, center: [0, 0, 1], radius: brush.radius, strength };
  if (brush.type === 'displace') stroke.direction = [0, 0, 1];
  return stroke;
}

function farthestMove(result) {
  let farthest = 0;
  for (let offset = 0; offset < result.positions.length; offset += 3) {
    const moved = Math.hypot(
      result.positions[offset] - original.positions[offset],
      result.positions[offset + 1] - original.positions[offset + 1],
      result.positions[offset + 2] - original.positions[offset + 2],
    );
    farthest = Math.max(farthest, moved);
  }
  return farthest;
}

function build() {
  const started = performance.now();
  const geometry = sculptGeometry(original, [strokeFor()]);
  const milliseconds = performance.now() - started;
  const part = {
    name: 'Clay',
    geometry,
    matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    material: { color: [0.8, 0.55, 0.4], metallic: 0, roughness: 0.55 },
  };
  renderer?.dispose();
  renderer = new CrucibleRenderer(canvas, [part], { ground: false, samples: 4, pixelRatio: 1.25 });
  renderer.resize();
  draw();
  console.log(`${brush.type}, strength ${brush.strength}, radius ${brush.radius}: ${geometry.positions.length / 3} vertices, ${milliseconds.toFixed(1)} ms, farthest move ${farthestMove(geometry).toFixed(3)}`);
}

function draw() {
  const flat = Math.cos(orbit.pitch) * orbit.distance;
  const eye = [Math.sin(orbit.yaw) * flat, Math.sin(orbit.pitch) * orbit.distance, Math.cos(orbit.yaw) * flat];
  renderer.render({ eye, target: [0, 0, 0.2], fov: 38 });
}

canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  orbit.yaw -= event.movementX * 0.01;
  orbit.pitch = Math.min(1.4, Math.max(-1.4, orbit.pitch + event.movementY * 0.01));
  draw();
});

const panel = document.createElement('div');
panel.style.cssText = 'position:fixed;left:12px;bottom:12px;display:grid;gap:6px;padding:8px 12px;border-radius:8px;background:#000b;color:#eee;font:12px system-ui';
function addRow(label, control) {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:space-between';
  row.append(label, control);
  panel.append(row);
}
const typeSelect = document.createElement('select');
for (const type of ['inflate', 'displace', 'smooth']) typeSelect.add(new Option(type, type));
typeSelect.addEventListener('change', () => {
  brush.type = typeSelect.value;
  build();
});
function slider(key, minimum, maximum, step) {
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min: minimum, max: maximum, step, value: brush[key] });
  input.addEventListener('change', () => {
    brush[key] = Number(input.value);
    build();
  });
  return input;
}
addRow('Brush', typeSelect);
addRow('Strength', slider('strength', -0.6, 0.6, 0.05));
addRow('Radius', slider('radius', 0.2, 1.5, 0.05));
document.body.append(panel);

new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
build();
```

`inflate` with a positive strength pushes the surface out along the original normals, and a negative strength dents it. `displace` moves the same vertices along one fixed direction, here `[0, 0, 1]`, so the bump has a flat push where `inflate` follows the sphere. `smooth` has little to even out on a sphere, so it changes this mesh only a little: it pays off on a surface that was already sculpted.

The brush falls off smoothly. For a normalized distance `t = distance / radius`, the influence is `1 - 10t³ + 15t⁴ - 6t⁵` inside the brush and zero outside. Its first and second derivatives vanish at the center and at the boundary, so no ridge forms where the brush ends.

## Strokes build on each other, and smoothing shrinks

Each stroke reads the positions that the previous strokes produced. This example raises a bump, then applies a `smooth` stroke over it. The slider sets the smooth strength, from 0 to 1. The log shows that smoothing also pulls the whole patch inward, because Laplacian smoothing does not preserve volume.

```js live poster=sculpt-smooth-shrink
import { CrucibleRenderer, sphere } from 'crucible';
import { sculptGeometry } from 'crucible/addons/sculpt';

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const orbit = { yaw: 0.9, pitch: 0.2, distance: 4.2 };
const original = sphere(64, 40);
let renderer = null;

function meanRadius(geometry) {
  let total = 0;
  const count = geometry.positions.length / 3;
  for (let vertex = 0; vertex < count; vertex++) {
    total += Math.hypot(geometry.positions[vertex * 3], geometry.positions[vertex * 3 + 1], geometry.positions[vertex * 3 + 2]);
  }
  return total / count;
}

function build(smoothStrength) {
  const strokes = [
    { type: 'inflate', center: [0.3, 0.2, 0.95], radius: 0.5, strength: 0.25 },
    { type: 'displace', center: [-0.4, 0.3, 0.9], radius: 0.4, strength: -0.15, direction: [0, 0, 1] },
    { type: 'smooth', center: [0, 0.2, 0.95], radius: 0.9, strength: smoothStrength },
  ];
  const geometry = sculptGeometry(original, strokes);
  const beforeSmoothing = sculptGeometry(original, strokes.slice(0, 2));
  const part = {
    name: 'Clay',
    geometry,
    matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    material: { color: [0.8, 0.55, 0.4], metallic: 0, roughness: 0.55 },
  };
  renderer?.dispose();
  renderer = new CrucibleRenderer(canvas, [part], { ground: false, samples: 4, pixelRatio: 1.25 });
  renderer.resize();
  draw();
  console.log(`smooth strength ${smoothStrength.toFixed(2)}: mean radius ${meanRadius(beforeSmoothing).toFixed(4)} before the smooth stroke, ${meanRadius(geometry).toFixed(4)} after`);
}

function draw() {
  const flat = Math.cos(orbit.pitch) * orbit.distance;
  const eye = [Math.sin(orbit.yaw) * flat, Math.sin(orbit.pitch) * orbit.distance, Math.cos(orbit.yaw) * flat];
  renderer.render({ eye, target: [0, 0, 0.2], fov: 38 });
}

canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  orbit.yaw -= event.movementX * 0.01;
  orbit.pitch = Math.min(1.4, Math.max(-1.4, orbit.pitch + event.movementY * 0.01));
  draw();
});

const row = document.createElement('label');
row.style.cssText = 'position:fixed;left:12px;bottom:12px;display:flex;gap:8px;align-items:center;padding:8px 12px;border-radius:8px;background:#000b;color:#eee;font:12px system-ui';
const slider = document.createElement('input');
Object.assign(slider, { type: 'range', min: 0, max: 1, step: 0.05, value: 0.5 });
slider.addEventListener('change', () => build(Number(slider.value)));
row.append('Smooth strength', slider);
document.body.append(row);

new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
build(0.5);
```

At strength 0 the bump and the dent stay as sculpted. At 1 each vertex moves all the way to the mean of its connected neighbors, which rounds the features off and lowers the mean radius. The smooth stroke is one Jacobi step: it reads a fixed snapshot of positions, so the order of vertices does not matter.

## Seams and normals

Vertices with exactly equal input Float32 positions move together, which keeps duplicated UV seams closed. Nearly coincident positions are not welded, and separate shells at the same position are treated as one group. Cancelling normals at coincident positions throw rather than choosing a direction.

Normals are rebuilt from area-weighted triangle cross products. UV coordinates, colors and topology are preserved, so stretching the surface also stretches an existing texture.

## Options

| Stroke field | Meaning |
| --- | --- |
| `type` | `'inflate'`, `'displace'` or `'smooth'`. |
| `center` | Three components in geometry-local units. |
| `radius` | Brush radius, positive at Float32 precision. |
| `strength` | Signed distance for `inflate` and `displace`. For `smooth`, a blend from 0 to 1. |
| `direction` | `displace` only: a nonzero vector, normalized by the addon. |

| Limit | Default | Ceiling |
| --- | --- | --- |
| `maxVertices` | 250000 | 1000000 |
| `maxTriangles` | 500000 | 2000000 |
| `maxStrokes` | 256 | 4096 |
| `maxVertexVisits` | 20000000 | 100000000 |

`maxVertexVisits` bounds the vertex count multiplied by the stroke count. Each limit is checked before the geometry is copied. These limits bound inputs and work, not total browser memory. An empty or zero-strength stroke list returns an independent copy.

The [sculpt contract](https://github.com/codepawl/crucible/blob/main/docs/sculpt.md) defines brush strength, seam handling and work limits.

## Common mistakes

- **Sculpting every frame.** Renderer geometry buffers are static, so rebuilding the mesh each frame costs CPU time and new GPU uploads. Build once, or turn compatible deformations into [relative morph targets](https://github.com/codepawl/crucible/blob/main/docs/morph-targets.md) and animate their weights.
- **A negative or large `smooth` strength.** The blend must be within 0 and 1, otherwise the call throws.
- **A stroke too strong for the mesh.** Strong strokes can fold or intersect surfaces, and sculpting does not detect that. A triangle that collapses throws `Sculpt stroke collapsed a triangle at Float32 precision. Reduce strength.`
- **Expecting a volume-preserving smooth.** Smoothing can shrink volume and soften boundaries, as the second example shows.
- **Sculpting a skinned or morphed mesh.** Sculpting rejects skin and morph channels, and it does not remesh, update rig weights or provide a brush editor.
- **Forgetting dependent data.** Rebuild surface patches and query indices after the geometry changes.
