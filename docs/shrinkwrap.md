# Static mesh shrinkwrap

`shrinkwrapGeometry` moves source vertices onto a target triangle surface and returns new static geometry.
It supports nearest-surface queries and projection along one direction.
The output uses target-local coordinates.
Share the target part's matrix when rendering the output beside that target.

```js
import { shrinkwrapGeometry } from 'crucible/addons/shrinkwrap';

const { geometry, stats } = shrinkwrapGeometry(sourceGeometry, targetGeometry, {
  sourceToTarget: sourceToTargetMatrix,
  mode: 'project',
  direction: [0, 0, -1],
  maxDistance: 2,
  clearance: 0.003,
});

const wrappedPart = {
  geometry,
  matrix: targetPart.matrix,
  material: sourcePart.material,
};
```

## Coordinates and query modes

`sourceToTarget` maps source-local positions into target-local positions before querying.
It defaults to the identity matrix.
Supply 16 finite, Float32-representable components in column-major order.
The matrix must remain affine and nonsingular after Float32 rounding.
Nonuniform scaling and shear are supported when the resulting triangles remain drawable.

`mode: 'nearest'` finds the nearest point on the target's triangles.
`mode: 'project'` finds the first triangle hit along `direction`.
The direction uses target-local coordinates and must remain nonzero.
Projection tests both triangle sides and uses only the positive ray direction.
Each mode measures distance in target-local units.
Under nonuniform target scaling, this distance differs from world-space Euclidean distance.

The target uses its actual polygonal surface, not an analytic sphere or an interpolated smooth surface.
Nearest wrapping onto a coarse convex mesh can pull several source vertices onto the same edge or vertex.
This can collapse triangles even when both input meshes are valid.
Refine the target surface or use directional projection for a suitable footprint.
At a hard crease, a nearest point can belong to several triangles.
Equal-distance queries select the lowest original triangle index among the visited candidates.

## Options and work limits

| Option | Default | Contract |
| --- | --- | --- |
| `mode` | `'nearest'` | `'nearest'` or `'project'` |
| `sourceToTarget` | Identity | Nonsingular affine matrix |
| `direction` | None | Required only for project mode |
| `maxDistance` | Infinity | Nonnegative Float32-representable number or Infinity |
| `clearance` | 0 | Nonnegative finite Float32-representable number |
| `onMiss` | `'error'` | `'error'` or `'keep'` |
| `maxVertices` | 250000 | Integer from 1 through 1000000, applied to both meshes |
| `maxTriangles` | 250000 | Integer from 1 through 1000000, applied to both meshes |
| `maxQueries` | 250000 | Integer from 1 through 1000000 |
| `maxTriangleTests` | 20000000 | Total callback budget from 1 through 100000000 |
| `memoryBudgetMiB` | 64 | Target index allocation estimate, greater than 0 through 1024 |

The implementation builds one target BVH and reuses it for all source vertices.
Exactly coincident source positions form one query group, including UV seams and hard edges.
`maxQueries` bounds those groups.
Each query receives the remaining total triangle budget.
Triangle callbacks count on both hits and misses.
Budget exhaustion throws and releases the target index.

The source vertex and triangle limits also bound the output buffers.
The memory estimate does not cap the whole process or include every temporary JavaScript object.

## Output and misses

The return value is `{ geometry, stats }`.
The geometry contains new Float32 positions and normals, copied Uint32 indices, and copied optional Float32 UVs and RGB colors.
It preserves the original vertex count, triangle topology, and UV/color values.
The source and target buffers remain unchanged, including after an error.
No partially wrapped geometry is published.

`stats` contains `queriedVertices`, `matchedVertices`, `missedVertices`, and `triangleTests`.
The first three fields count unique exact-position groups, not duplicate seam vertices.
With `onMiss: 'error'`, any missing hit throws.
With `onMiss: 'keep'`, missing groups retain their transformed source positions.
Normals are rebuilt for the complete resulting mesh, including transitions between kept and matched vertices.

Normal reconstruction joins matching original position-and-normal groups.
This joins smooth UV seams while preserving authored hard-normal splits.
It uses Double-precision area sums before writing unit Float32 normals.
Unused vertices retain their transformed authored normals.

## Clearance and numerical limits

Clearance offsets each matched vertex along the actual geometric normal of its matched target triangle.
The normal follows the target triangle's index winding.
It does not use interpolated shading normals.
Positive clearance must produce a positive outward face gap after Float32 rounding.
The implementation rejects an offset that collapses or moves only tangent to that face.

The result must retain drawable triangles with a conservative Float32 altitude margin.
The implementation rejects triangles that flip or fold relative to the transformed source.
It also rejects triangles that face away from the aggregate normals of their matched target triangles.
A source reflection can reverse its winding and trigger this check.
Large surface changes can rotate triangles beyond this supported orientation range.

Clearance at separate matched vertices does not prove clearance for the entire connecting triangle.
Long source edges can cross a concave target or bridge a sharp crease.
The operation does not detect every self-intersection or target penetration.
Increase source resolution and inspect the resulting mesh before using it for a close surface overlay.
Use a clipped surface patch when the geometry must follow the target's existing triangles exactly.

The target index normalizes positions for Double-precision queries.
Its triangles must exceed a normalized minimum altitude of `1e-8`.
Each query origin must remain within `1e6` normalized units.
Output positions must remain finite in Float32, and world precision can still collapse a mesh under its eventual render matrix.
The operation does not validate that later matrix or guarantee a constant world-space clearance.

## Static scope and design

Both meshes require indexed Float32 XYZ positions and Uint32 triangles.
The source also requires finite unit Float32 normals.
Optional UV and RGB channels must match its vertex count and contain finite Float32 values.
The operation rejects skin and morph channels.
The caller must also exclude surfaces changed by shader displacement or procedural deformation.

Moving the shared target matrix moves the wrapped geometry rigidly without rebuilding it.
Changing the target's vertex positions requires another shrinkwrap operation.

Two designs were considered: a retained mutable modifier with an implicit target cache, and a static operation returning geometry plus diagnostics.
The static operation makes publication atomic and gives the caller control over rebuilds and resource ownership.
It also keeps animation seeks independent of previous query calls.

The mode distinction follows Blender's documented [Nearest Surface Point and Project shrinkwrap methods](https://docs.blender.org/manual/en/latest/modeling/modifiers/deform/shrinkwrap.html).
This module does not implement Blender's vertex groups, subdivision, snapping modes, culling controls, or animated modifier stack.

## Target-local query helpers

`createMeshQueryIndex` also exposes `nearest(point, options)` and `project(ray)`.
Both return `{ hit, triangleTests }`, so misses preserve work diagnostics.
`hit` is `null` or `{ point, distance, triangle, barycentric, normal }`.
Positions, distances, directions, and geometric normals use the original target-local frame.
`triangle` identifies an original target triangle.
`barycentric` follows that triangle's three original index entries.

Nearest options accept `maxDistance` and `maxTriangleTests`.
Projection accepts `origin`, `direction`, `maxDistance`, and `maxTriangleTests`.

Each helper defaults to 2000000 triangle callbacks.
Their callback budgets accept integers from 1 through 100000000.
An exhausted query throws after its BVH traversal unwinds, so the index remains usable.
The existing world-space `raycast(matrix, ray)` API retains its hit-or-null return contract.

## Animate the result once it is built

Construct shrinkwrap before creating the renderer.
When the source and output share a local coordinate frame and topology, their difference can become a relative GPU morph target.
This avoids rebuilding the BVH and wrapping every vertex on each animation frame.

```js
import { createMorphPose } from 'crucible';

const wrapped = shrinkwrapGeometry(source, target, { mode: 'project', direction: [0, 0, -1] }).geometry;
const animatedGeometry = {
  ...source,
  morphTargets: [{
    positions: Float32Array.from(source.positions, (value, index) => wrapped.positions[index] - value),
    normals: Float32Array.from(source.normals, (value, index) => wrapped.normals[index] - value),
  }],
};
const morph = createMorphPose(1);
// Assign animatedGeometry and morph to the part before constructing CrucibleRenderer.
// Update morph.weights[0] between zero and one before renderer.updateParts(parts).
```

Intermediate shapes need their own collision checks.
Safe endpoints do not prove that an interpolated mesh avoids every obstacle.

Available from version `0.4.0`.
