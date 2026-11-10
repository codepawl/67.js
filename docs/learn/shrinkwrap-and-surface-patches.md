# Shrinkwrap and surface patches

Two static tools fit one mesh to another. `shrinkwrapGeometry` from `67js/addons/shrinkwrap` moves the vertices of a source mesh onto a target surface and keeps the source topology, UVs and colors. `createSurfacePatch` from `67js/addons/surface` clips the target's own triangles into a small overlay with its own UVs and material. Both are construction-time operations: they do not follow skin or morph deformation.

## Shrinkwrap a grid onto a sphere

`shrinkwrapGeometry(source, target, options)` returns new static geometry in target-local coordinates. `nearest` mode chooses the closest surface point. `project` mode casts along a target-local direction. The workflow has five steps:

1. Define `sourceToTarget` to map source-local positions into target-local coordinates.
2. Choose `nearest` or `project` mode and a bounded `maxDistance`.
3. Set `clearance` and an explicit `onMiss` policy.
4. Use the returned geometry with the target part's retained matrix.
5. Inspect `stats` and the resulting mesh before rendering.

The example wraps a flat grid onto a sphere. Pick the mode, change the clearance, and make the grid bigger than the sphere to see misses. The log prints `stats` for every build, and the error text if a build throws.

```js live poster=shrinkwrap-grid
import { Renderer67, sphere } from '67js';
import { shrinkwrapGeometry } from '67js/addons/shrinkwrap';

// A flat grid in the XY plane at height z, facing +Z.
function grid(halfSize, divisions, z) {
  const side = divisions + 1;
  const positions = new Float32Array(side * side * 3);
  const normals = new Float32Array(side * side * 3);
  const uvs = new Float32Array(side * side * 2);
  const indices = [];
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      const vertex = row * side + column;
      positions.set([(column / divisions * 2 - 1) * halfSize, (row / divisions * 2 - 1) * halfSize, z], vertex * 3);
      normals.set([0, 0, 1], vertex * 3);
      uvs.set([column / divisions, row / divisions], vertex * 2);
      if (row < divisions && column < divisions) {
        indices.push(vertex, vertex + 1, vertex + side, vertex + 1, vertex + side + 1, vertex + side);
      }
    }
  }
  return { positions, normals, uvs, indices: new Uint32Array(indices) };
}

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const target = { name: 'Ball', geometry: sphere(64, 40), matrix: identity(), material: { color: [0.25, 0.4, 0.6], metallic: 0, roughness: 0.5 } };
const settings = { mode: 'project', clearance: 0.02, halfSize: 0.6, height: 1.1 };

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const orbit = { yaw: 0.6, pitch: 0.35, distance: 4.5 };
let renderer = null;

function build() {
  const source = grid(settings.halfSize, 32, settings.height);
  const parts = [target];
  try {
    const started = performance.now();
    const { geometry, stats } = shrinkwrapGeometry(source, target.geometry, {
      mode: settings.mode,
      direction: settings.mode === 'project' ? [0, 0, -1] : undefined,
      clearance: settings.clearance,
      onMiss: 'keep',
    });
    parts.push({ name: 'Wrap', geometry, matrix: target.matrix, material: { color: [0.95, 0.7, 0.2], metallic: 0, roughness: 0.45 } });
    console.log(`${settings.mode}, clearance ${settings.clearance}, grid ${(settings.halfSize * 2).toFixed(1)} wide at height ${settings.height}: ${JSON.stringify(stats)}, ${(performance.now() - started).toFixed(0)} ms`);
  } catch (error) {
    console.log(`${settings.mode}: ${error.message}`);
  }
  renderer?.dispose();
  renderer = new Renderer67(canvas, parts, { ground: false, samples: 4, pixelRatio: 1.25 });
  renderer.resize();
  draw();
}

function draw() {
  const flat = Math.cos(orbit.pitch) * orbit.distance;
  const eye = [Math.sin(orbit.yaw) * flat, Math.sin(orbit.pitch) * orbit.distance, Math.cos(orbit.yaw) * flat];
  renderer.render({ eye, target: [0, 0, 0.4], fov: 38 });
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
const modeSelect = document.createElement('select');
for (const mode of ['project', 'nearest']) modeSelect.add(new Option(mode, mode));
modeSelect.addEventListener('change', () => {
  settings.mode = modeSelect.value;
  build();
});
function slider(key, minimum, maximum, step) {
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min: minimum, max: maximum, step, value: settings[key] });
  input.addEventListener('change', () => {
    settings[key] = Number(input.value);
    build();
  });
  return input;
}
addRow('Mode', modeSelect);
addRow('Clearance', slider('clearance', 0, 0.2, 0.01));
addRow('Grid half size', slider('halfSize', 0.4, 1.4, 0.05));
addRow('Grid height', slider('height', 1.05, 2.5, 0.05));
document.body.append(panel);

new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
build();
```

In `project` mode every grid vertex slides straight down the -Z axis until it hits the sphere, so the grid keeps its footprint like a cloth dropped from above. In `nearest` mode each vertex goes to the closest point on the surface, so the grid draws toward the center and its corners crowd together. Grow the grid until its corners pass the sphere's silhouette (half size above about 0.7) in project mode and the vertices outside it miss: `onMiss: 'keep'` leaves them at their transformed source position, and `stats.missedVertices` counts them. With the default `onMiss: 'error'` the same call would throw.

`clearance` offsets each matched vertex along the geometric normal of its target triangle, so the wrap floats just above the sphere instead of sharing its surface.

Raise the grid in `nearest` mode and the build fails: the log prints `Shrinkwrap collapses a triangle within Float32 precision`. From far away, all the nearest points crowd onto a small part of the sphere, and neighbouring vertices land on the same spot. `project` has no such problem, because it keeps the footprint. Bring the grid close to the sphere or use `project`.

The return value is `{ geometry, stats }`. `stats` has `queriedVertices`, `matchedVertices`, `missedVertices` and `triangleTests`. The first three count unique exact-position groups, so duplicate seam vertices count once.

### Shrinkwrap options

| Option | Default | Contract |
| --- | --- | --- |
| `mode` | `'nearest'` | `'nearest'` or `'project'` |
| `sourceToTarget` | Identity | Nonsingular affine matrix, 16 column-major components |
| `direction` | None | Required only for project mode, in target-local coordinates |
| `maxDistance` | Infinity | Nonnegative Float32-representable number or Infinity |
| `clearance` | 0 | Nonnegative finite Float32-representable number |
| `onMiss` | `'error'` | `'error'` or `'keep'` |
| `maxVertices` | 250000 | Integer from 1 through 1000000, applied to both meshes |
| `maxTriangles` | 250000 | Integer from 1 through 1000000, applied to both meshes |
| `maxQueries` | 250000 | Integer from 1 through 1000000 |
| `maxTriangleTests` | 20000000 | Total callback budget from 1 through 100000000 |
| `memoryBudgetMiB` | 64 | Target index allocation estimate, greater than 0 through 1024 |

Use the output with the target part's retained matrix. The [shrinkwrap contract](https://github.com/codepawl/67.js/blob/main/docs/shrinkwrap.md) defines local distances, work budgets and miss handling. Moving the shared matrix moves the wrapped geometry rigidly without rebuilding it, but changing the target's vertices needs another shrinkwrap. The mode distinction follows Blender's [Nearest Surface Point and Project methods](https://docs.blender.org/manual/en/latest/modeling/modifiers/deform/shrinkwrap.html).

`createMeshQueryIndex` also gives target-local `nearest(point, options)` and `project(ray)` helpers. Both return `{ hit, triangleTests }`, where `hit` is `null` or `{ point, distance, triangle, barycentric, normal }`.

### Animate the result once it is built

The wrapping runs before the renderer exists. When the source and the output share a coordinate frame and topology, their difference becomes a relative GPU morph target, so no BVH is rebuilt and no vertex is wrapped on each frame.

```js
import { createMorphPose } from '67js';
import { shrinkwrapGeometry } from '67js/addons/shrinkwrap';

const wrapped = shrinkwrapGeometry(source, target, { mode: 'project', direction: [0, 0, -1] }).geometry;
const animatedGeometry = {
  ...source,
  morphTargets: [{
    positions: Float32Array.from(source.positions, (value, index) => wrapped.positions[index] - value),
    normals: Float32Array.from(source.normals, (value, index) => wrapped.normals[index] - value),
  }],
};
const morph = createMorphPose(1);
// Assign animatedGeometry and morph to the part before constructing Renderer67.
// Update morph.weights[0] between zero and one before renderer.updateParts(parts).
```

Intermediate shapes need their own collision checks. Safe endpoints do not prove that an interpolated mesh avoids every obstacle.

## Surface patches

`createSurfacePatch(targetPart, options)` clips target triangles into a standalone patch that follows their curved shape. It generates new projector UVs and normalized interpolated normals, and it copies no colors, original UVs, maps or material. The patch uses its own material. Every option is in target-local coordinates.

The slider walks a badge around the equator of a sphere. For each position the projector is rotated so that its +Z axis faces outward from the sphere, and the patch is built again. The log prints its size.

```js live poster=surface-badge
import { Renderer67, sphere } from '67js';
import { createSurfacePatch } from '67js/addons/surface';

const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const target = { name: 'Shell', geometry: sphere(64, 40), matrix, material: { color: [0.03, 0.2, 0.3], metallic: 0.2, roughness: 0.4 } };
const canvas = document.querySelector('#scene');
const settings = { angle: 0.6, width: 0.6 };
let renderer = null;

function build() {
  // The surface point at this angle around Y, and the projector rotation that makes +Z face away from the sphere.
  const position = [Math.sin(settings.angle), 0, Math.cos(settings.angle)];
  const started = performance.now();
  const geometry = createSurfacePatch(target, {
    position,
    rotation: [0, settings.angle, 0],
    size: [settings.width, settings.width * 0.66, 0.4],
    clearance: 0.001,
  });
  const badge = { name: 'Badge', geometry, matrix: target.matrix, material: { color: [1, 0.2, 0.02], metallic: 0, roughness: 0.5 } };
  renderer?.dispose();
  renderer = new Renderer67(canvas, [target, badge], { ground: false, samples: 4, pixelRatio: 1.25 });
  renderer.resize();
  draw();
  console.log(`angle ${settings.angle.toFixed(2)}, width ${settings.width.toFixed(2)}: ${geometry.positions.length / 3} vertices, ${geometry.indices.length / 3} triangles, ${(performance.now() - started).toFixed(1)} ms`);
}

function draw() {
  renderer.render({ eye: [0, 1.2, 4.2], target: [0, 0, 0.3], fov: 38 });
}

const panel = document.createElement('div');
panel.style.cssText = 'position:fixed;left:12px;bottom:12px;display:grid;gap:6px;padding:8px 12px;border-radius:8px;background:#000b;color:#eee;font:12px system-ui';
function addSlider(label, key, minimum, maximum, step) {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:space-between';
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min: minimum, max: maximum, step, value: settings[key] });
  input.addEventListener('change', () => {
    settings[key] = Number(input.value);
    build();
  });
  row.append(label, input);
  panel.append(row);
}
addSlider('Angle around the sphere', 'angle', -1.2, 1.2, 0.05);
addSlider('Badge width', 'width', 0.2, 1.2, 0.05);
document.body.append(panel);

new ResizeObserver(() => {
  renderer.resize();
  draw();
}).observe(canvas);
build();
```

The patch sits `clearance` above the sphere along the interpolated surface normals, so it does not fight the sphere's own surface for depth. Sharing the retained `target.matrix` on the patch part keeps both objects together through rigid translation, rotation, affine scale and shear. Replacing only the target matrix breaks that relationship.

Back-facing triangles are excluded, but a deep projector can still catch several outward-facing layers. Keep the box depth (the third value of `size`) and `maxAngle` narrow enough to select the surface you mean. A projector that crosses a sharp corner can distort the UVs.

### Surface patch options

| Option | Default | Meaning |
| --- | --- | --- |
| `position` | `[0, 0, 0]` | Center of the clipping box. |
| `rotation` | `[0, 0, 0]` | XYZ Euler radians. Projector +Z faces outward from the target. |
| `size` | `[1, 1, 1]` | Positive width, height and depth of the clipping box. |
| `clearance` | `0.001` | Nonnegative local offset along interpolated surface normals. |
| `maxAngle` | `Math.PI / 2` | Maximum angle between geometric face normal and projector +Z. Must exceed zero. |
| `maxVertices` | `250000` | Conservative clipping reservation and output vertex cap. |
| `maxTriangles` | `250000` | Input triangle cap. |

Zero clearance deliberately creates a coplanar patch and can produce z-fighting. Constant local clearance does not give a constant world gap under nonuniform scale. The addon checks the rounded displacement against each clipped Float32 triangle, so vanishing gaps, reversed winding and a fully collapsed output throw. This checks local patch construction, not collision against other scene objects.

Clipping runs while you build the scene, and the patch is reused every frame without clipping again. Skin, morph, assembly and procedural target materials are rejected, because their visible surfaces differ from the static target geometry. Rebuild the patch after static sculpting. The [surface patch contract](https://github.com/codepawl/67.js/blob/main/docs/surface.md) defines projector orientation, depth and local clearance.

### Three different overlap problems

| Problem | Required response |
| --- | --- |
| Nearly coplanar surfaces flicker | Geometric clearance or scoped render depth bias. A patch supplies geometric clearance. |
| A rigid accessory intersects a curved shell | Adjust the contact transform or deform its footprint. A flat rigid panel cannot fit an arbitrary curved surface completely. |
| Two closed meshes penetrate or one contains the other | Mesh collision queries and resolution, see [contact detection](#contact-detection). |

Antialiasing, material colors and shadow bias do not repair mesh penetration. A patch is a surface overlay, not a whole-object shrinkwrap.

## Common mistakes

- **Nearest mode on a coarse convex target.** Several source vertices can land on the same edge or vertex and collapse triangles, and the call throws. Refine the target, or use `project` with a suitable footprint.
- **Passing `direction` in nearest mode.** `direction` applies only to project mode, and the call throws otherwise.
- **Leaving `onMiss` at its default.** One missing vertex throws with `'error'`. Pass `'keep'` and read `stats.missedVertices` when misses are expected.
- **Long source edges.** Clearance at matched vertices does not prove clearance across the connecting triangle, and a long edge can bridge a concave target or a sharp crease. Increase the source resolution and inspect the result.
- **Using the wrapped geometry with another matrix.** The output is in target-local coordinates. Give the part the target part's matrix.
- **Patch materials copied from the target.** The patch has no colors, maps or material of the target. Give it its own.
- **Expecting a patch to follow a deformed surface.** Patches and shrinkwrap are static. They do not follow skin or morph deformation, and a projection does not guarantee clearance across the complete accessory surface.
