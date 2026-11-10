# Contact detection

Version `0.4.0` provides static BVH queries through `67js/addons/mesh-query`. `createMeshQueryIndex` copies positions and indices. `createMeshPairQuery` tests two indices under explicit affine matrices. The `surfaces` mode finds triangle contact. The `closed-solids` mode also tests containment between two validated solid indices.

The workflow has five steps:

1. Build one index per static geometry with explicit count and memory budgets.
2. For containment, create both indices with `solid: true`.
3. Create a pair query with the required mode.
4. Evaluate the query with both current world matrices.
5. Dispose the indices when their geometry is no longer needed.

Rebuild indices after geometry edits. Queries reject skin and morph channels. Contact results do not measure penetration depth or resolve collisions.

## Two solids: apart, touching, inside

The small sphere moves along X through the big one. Every move evaluates the pair query with both current matrices, and the sphere turns red while the surfaces touch. The log prints one line each time the answer changes.

```js live poster=contact-solids
import { Renderer67, sphere } from '67js';
import { createMeshQueryIndex, createMeshPairQuery } from '67js/addons/mesh-query';

function placeAt(x, size) {
  return new Float32Array([size, 0, 0, 0, 0, size, 0, 0, 0, 0, size, 0, x, 0, 0, 1]);
}

const geometry = sphere(32, 20);
const big = { name: 'Big', geometry, matrix: placeAt(0, 1), material: { color: [0.3, 0.5, 0.8], metallic: 0, roughness: 0.5 } };
const small = { name: 'Small', geometry, matrix: placeAt(-3, 0.45), material: { color: [0.95, 0.75, 0.2], metallic: 0, roughness: 0.4 } };

// Both indices are solids, so the pair query can tell "inside" from "apart".
const started = performance.now();
const bigIndex = createMeshQueryIndex(geometry, { solid: true });
const smallIndex = createMeshQueryIndex(geometry, { solid: true });
console.log(`two solid indices: ${(performance.now() - started).toFixed(0)} ms, ${bigIndex.info.vertexCount} vertices and ${bigIndex.info.triangleCount} triangles each, ${(bigIndex.info.estimatedBytes / 1024).toFixed(0)} KiB`);
const query = createMeshPairQuery(bigIndex, smallIndex, { mode: 'closed-solids' });

const canvas = document.querySelector('#scene');
const renderer = new Renderer67(canvas, [big, small], { ground: false, samples: 4, pixelRatio: 1.25 });
let lastKind = '';

function update(x) {
  small.matrix.set(placeAt(x, 0.45));
  const result = query.evaluate(big.matrix, small.matrix);
  small.material.color = result.kind === 'surface-intersection' ? [0.9, 0.2, 0.2] : result.kind === 'contained' ? [0.2, 0.75, 0.4] : [0.95, 0.75, 0.2];
  renderer.updateParts([big, small]);
  renderer.render({ eye: [0, 1.5, 6], target: [0, 0, 0], fov: 40 });
  if (result.kind !== lastKind) {
    lastKind = result.kind;
    console.log(`x ${x.toFixed(2)}: ${result.kind} / ${result.solidRelation}, triangles ${JSON.stringify(result.triangles)}, ${result.triangleTests} triangle tests, ${result.rayAttempts} rays`);
  }
}

const row = document.createElement('label');
row.style.cssText = 'position:fixed;left:12px;bottom:12px;display:flex;gap:8px;align-items:center;padding:8px 12px;border-radius:8px;background:#000b;color:#eee;font:12px system-ui';
const slider = document.createElement('input');
Object.assign(slider, { type: 'range', min: -3, max: 3, step: 0.02, value: -3 });
slider.addEventListener('input', () => update(Number(slider.value)));
row.append('Move the small sphere', slider);
document.body.append(row);

new ResizeObserver(() => {
  renderer.resize();
  update(Number(slider.value));
}).observe(canvas);
update(-3);
addEventListener('pagehide', () => {
  bigIndex.dispose();
  smallIndex.dispose();
});
```

The slider sweeps the small sphere through four states: `separate` / `outside` while the two are apart, `surface-intersection` / `boundaries-intersect` while the shells cross, `contained` / `b-in-a` when the small one sits fully inside the big one, and back again. Notice that while the small sphere is inside, the surfaces are disjoint. A `surfaces` query would report `surface-disjoint` there, because it does not test containment.

`triangles` holds the first contacting pair of original triangle numbers, or `null`. The order of traversal decides which pair comes first, so the result never lists every contact. `triangleTests` counts the triangle callbacks, including containment rays, and `rayAttempts` counts the ray directions that containment tried.

## Rays against a static mesh

An index also supports `raycast(matrix, ray)` for a triangle number, hit point and barycentric coordinates. The two sliders move the origin of a ray that points down the -Z axis at a torus. The gold marker sits on the hit point, and the log prints the hit or `null` for a miss.

```js live poster=contact-raycast
import { Renderer67, torus, sphere } from '67js';
import { createMeshQueryIndex } from '67js/addons/mesh-query';

const ringMatrix = new Float32Array([1.2, 0, 0, 0, 0, 1.2, 0, 0, 0, 0, 1.2, 0, 0, 0, 0, 1]);
const ring = { name: 'Ring', geometry: torus(0.3, 64, 24), matrix: ringMatrix, material: { color: [0.3, 0.5, 0.8], metallic: 0.1, roughness: 0.4 } };
const marker = {
  name: 'Hit',
  geometry: sphere(16, 10),
  matrix: new Float32Array([0.08, 0, 0, 0, 0, 0.08, 0, 0, 0, 0, 0.08, 0, 0, -50, 0, 1]),
  material: { color: [1, 0.75, 0.2], metallic: 0, roughness: 0.3, emission: 2 },
};

const index = createMeshQueryIndex(ring.geometry);
const canvas = document.querySelector('#scene');
const renderer = new Renderer67(canvas, [ring, marker], { ground: false, samples: 4, pixelRatio: 1.25 });
const origin = { x: 1.2, y: 0 };

function update() {
  const hit = index.raycast(ringMatrix, { origin: [origin.x, origin.y, 6], direction: [0, 0, -1], maxDistance: 20 });
  const position = hit ? hit.point : [0, -50, 0];
  marker.matrix[12] = position[0];
  marker.matrix[13] = position[1];
  marker.matrix[14] = position[2];
  renderer.updateParts([ring, marker]);
  renderer.render({ eye: [0, 0.5, 6], target: [0, 0, 0], fov: 40 });
  if (hit) {
    console.log(`origin (${origin.x.toFixed(2)}, ${origin.y.toFixed(2)}): triangle ${hit.triangle}, distance ${hit.distance.toFixed(3)}, point ${hit.point.map(value => value.toFixed(2)).join(', ')}, barycentric ${hit.barycentric.map(value => value.toFixed(2)).join(', ')}`);
  } else {
    console.log(`origin (${origin.x.toFixed(2)}, ${origin.y.toFixed(2)}): null (miss)`);
  }
}

const panel = document.createElement('div');
panel.style.cssText = 'position:fixed;left:12px;bottom:12px;display:grid;gap:6px;padding:8px 12px;border-radius:8px;background:#000b;color:#eee;font:12px system-ui';
for (const axis of ['x', 'y']) {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:space-between';
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min: -2, max: 2, step: 0.02, value: origin[axis] });
  input.addEventListener('input', () => {
    origin[axis] = Number(input.value);
    update();
  });
  row.append(`Ray ${axis}`, input);
  panel.append(row);
}
document.body.append(panel);

new ResizeObserver(() => {
  renderer.resize();
  update();
}).observe(canvas);
update();
```

A ray at `y = 0` and `x = 1.2` passes through the middle of the ring's tube, so it hits. Move `x` to 0 and it passes through the hole: the result is `null`. The hit's `triangle` is an original index-buffer triangle number, which is exactly what [attachments](#retained-surface-attachments) take as a binding. The `barycentric` coordinates follow the triangle's three index entries.

A ray uses world-space `origin` and `direction`. `maxDistance` defaults to infinity and must be nonnegative.

## Z-fighting is a different problem

Contact queries find triangle contact. They do not explain why two parts flicker. Z-fighting has its own check: `renderer.diagnostics` and `scene_inspect` report `coplanar-overlap` for two parts that draw the same plane (within 1 mm, same facing, at least 1 cm2 shared). The example below puts a slab and a patch on the same top plane. Tick the box to mark the patch as a decal and watch the warning leave.

```js live poster=contact-coplanar
import { Renderer67, box } from '67js';
import { installCoplanarDiagnostics } from '67js/addons/coplanar-overlap';

function slab(x, y, z, width, height, depth) {
  return new Float32Array([width, 0, 0, 0, 0, height, 0, 0, 0, 0, depth, 0, x, y, z, 1]);
}

const canvas = document.querySelector('#scene');
const geometry = box(0, 1);
let renderer = null;

function build(useDecal) {
  const parts = [
    { name: 'Slab', geometry, matrix: slab(0, 0, 0, 4, 0.2, 4), material: { color: [0.3, 0.45, 0.7], metallic: 0, roughness: 0.5 } },
    { name: 'Patch', geometry, matrix: slab(0.6, 0.05, 0.4, 1.8, 0.1, 1.6), material: { color: [0.9, 0.55, 0.2], metallic: 0, roughness: 0.5 }, decal: useDecal },
  ];
  renderer?.dispose();
  renderer = new Renderer67(canvas, parts, { ground: false, samples: 4, pixelRatio: 1.25 });
  installCoplanarDiagnostics(renderer);
  renderer.resize();
  renderer.render({ eye: [3, 5.5, 5.5], target: [0, 0, 0], fov: 40 });
  console.log(`decal: ${useDecal}, diagnostics: ${renderer.diagnostics.length ? renderer.diagnostics.map(problem => problem.message).join(' | ') : 'none'}`);
}

const row = document.createElement('label');
row.style.cssText = 'position:fixed;left:12px;bottom:12px;display:flex;gap:8px;align-items:center;padding:8px 12px;border-radius:8px;background:#000b;color:#eee;font:12px system-ui';
const checkbox = document.createElement('input');
checkbox.type = 'checkbox';
checkbox.addEventListener('change', () => build(checkbox.checked));
row.append(checkbox, 'decal: true on the patch');
document.body.append(row);

new ResizeObserver(() => {
  renderer.resize();
  renderer.render({ eye: [3, 5.5, 5.5], target: [0, 0, 0], fov: 40 });
}).observe(canvas);
build(false);
```

Both parts draw the plane `y = 0.1`, so the patch flickers against the slab. The diagnostic names the smaller part and suggests the fix. `decal: true` puts the part on layer 1 (`depthLayer` 0 to 4 orders stacked decals) and draws it with a scoped polygon offset in the colour pass and the render passes, so it never moves geometry. In an agent scene recipe, `environment.resolveCoplanar: 'offset'` biases the smaller part of every flagged pair in the same way.

Use a real offset along the normal when the gap should be visible in exports or the path tracer.

The coplanar code is not in the core bundle. Call `installCoplanarDiagnostics(renderer)` from `67js/addons/coplanar-overlap` to add the warning to `renderer.diagnostics` (checked once per layout). `scene_inspect` shows it once `loadAllAgentSceneModules()` (or a recipe with `resolveCoplanar`) has loaded the code.

### Depth precision far from the camera

Far from the camera, depth precision is the other cause. The renderer draws every colour pass with reversed-Z, a 32-bit float depth buffer and camera-relative vertices by default wherever `EXT_clip_control` exists, at any far / near ratio; pass `reversedDepth: false` to opt out. Without the extension it uses a 24-bit buffer and moves the near plane out to the visible bounds when the camera left near unset. It still has a float32 limit, because vertex positions are float32.

On the RTX 3060 a 0.1 mm gap at 500 m still draws the far surface on 6.9% of pixels, and a 1 mm gap at 500 m on 1.4%. At 50 m both stay under 1%. Keep surfaces that must not flicker at least 1 mm apart when they sit hundreds of metres from the camera, or mark the top one `decal: true`.

## Options

| Index option | Default | Accepted range |
| --- | --- | --- |
| `maxVertices` | 250000 | Integer from 1 through 1000000 |
| `maxTriangles` | 250000 | Integer from 1 through 1000000 |
| `memoryBudgetMiB` | 64 | Number greater than 0 through 1024 |
| `solid` | false | Boolean |
| `maxValidationPairs` | 2000000 | Integer from 1 through 100000000 |

`createMeshPairQuery(indexA, indexB, options)` takes `mode` (`'surfaces'` by default, or `'closed-solids'`) and `maxTriangleTests` (default 2000000, integers from 1 through 100000000). Exhausting a budget throws instead of returning a disjoint result, and the index stays usable.

| `kind` | `solidRelation` | Meaning |
| --- | --- | --- |
| `surface-intersection` | `not-tested` | Surface mode found touching, crossing or coplanar triangles |
| `surface-disjoint` | `not-tested` | Surface mode found no boundary contact |
| `surface-intersection` | `boundaries-intersect` | Closed-solid mode found boundary contact |
| `contained` | `a-in-b` | Solid A lies inside solid B without boundary contact |
| `contained` | `b-in-a` | Solid B lies inside solid A without boundary contact |
| `separate` | `outside` | Closed-solid mode found neither contact nor containment |

`index.info` has frozen `vertexCount`, `triangleCount` and `estimatedBytes`. `index.memoryPlan` adds `reservedBytes`, `memoryBudgetMiB` and `validationPairs`. `dispose()` can be called twice, but later queries throw.

A solid index needs closed geometry: every welded edge has two oppositely directed faces, the boundary is connected, and the surface does not cross itself. Separate shells and cavities are rejected. Query matrices are column-major, finite, affine and nonsingular, and reflections, nonuniform scales and shear are supported. The [mesh query contract](https://github.com/codepawl/67.js/blob/main/docs/mesh-query.md) describes results, solid validation, numerical limits and budget errors.

## Common mistakes

- **Using `surfaces` mode to find "inside".** Two surfaces can stay disjoint while one solid contains the other. Use `closed-solids` with `solid: true` on both indices.
- **Reading contact as penetration.** Contact results do not measure penetration depth or resolve collisions, and two closed solids can touch at a face without overlapping interiors.
- **A stale index.** The index holds a copy of the geometry. Build another one after any geometry edit. A shader that displaces the surface also changes what is visible without changing the triangles.
- **Querying skinned or morphed geometry.** Indices reject skin and morph channels, and they cannot raycast a visibly skinned or morphed surface.
- **Fixing flicker with a bigger index budget.** Z-fighting depends on the camera, projection and depth precision, not on mesh contact. Use `decal: true`, a real offset, or reversed depth.
