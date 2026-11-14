# Sculpt with brush data

Available from version `0.4.0`. The optional addon does not add Three.js to the core renderer.

```js
import { sphere } from '@codepawlhq/crucible';
import { sculptGeometry } from '@codepawlhq/crucible/addons/sculpt';

const geometry = sculptGeometry(sphere(64, 40), [
  { type: 'inflate', center: [0, 0.7, 0.7], radius: 0.6, strength: 0.12 },
  { type: 'displace', center: [0, 0, 1], radius: 0.35, strength: -0.08, direction: [0, 0, 1] },
  { type: 'smooth', center: [0, 0, 1], radius: 0.5, strength: 0.15 },
]);
```

Assign the result to a part before creating `CrucibleRenderer`. It copies positions, normals, triangle indices, UVs and RGB colors. The source remains unchanged. Replaying the same strokes produces the same geometry. Each stroke reads positions produced by previous strokes.

## Brushes and units

All centers, radii and displacements use geometry-local units.

| Type | Behavior | Strength |
| --- | --- | --- |
| `inflate` | Move along the original mesh normals, averaged at exact coincident positions. | Signed distance; negative values deflate. |
| `displace` | Move along the supplied nonzero `direction`, normalized by the addon. | Signed distance. |
| `smooth` | Move toward the mean of connected triangle neighbors. One Jacobi step reads a fixed position snapshot. | Blend from 0 to 1. |

For normalized distance `t = distance / radius`, the radial influence is `1 - 10t³ + 15t⁴ - 6t⁵` inside the brush and zero outside. Its first and second derivatives vanish at the center and boundary, avoiding an abrupt ridge where the brush ends. Inflate uses the input normals throughout one call, so a long sequence does not repeatedly rebuild normals. Separate calls allow later inflation to follow newly sculpted normals.

Laplacian smoothing can shrink volume and soften boundaries. It does not preserve volume or guarantee collision-free topology.

## Seams and normals

Vertices with exactly equal input Float32 positions move together. This preserves duplicated UV seams. Nearly coincident positions are not welded, and separate shells at the same position are treated as one group. Cancelling normals at coincident positions throw rather than choosing an arbitrary direction.

Normals are rebuilt from area-weighted triangle cross products using double-precision accumulators before conversion to Float32. This avoids overflow or underflow of normal accumulation on small or large finite meshes. Vertices with identical original positions and normals share the recomputed direction. Different original normals retain authored hard-edge splits.

Unreferenced vertices retain their original normals. Cancelling normals at referenced vertices throw. UV coordinates, colors and topology are preserved, so stretching the surface also stretches an existing texture.

## Bounds and unsupported operations

`sculptGeometry(geometry, strokes, options)` accepts static indexed geometry with Float32 positions and unit normals, plus Uint32 triangle indices. Skin and morph channels are rejected. Empty or zero-strength stroke lists return an independent copy.

Defaults are `maxVertices: 250000`, `maxTriangles: 500000`, `maxStrokes: 256`, and `maxVertexVisits: 20000000`. Each limit is checked before copying geometry. `maxVertexVisits` bounds vertex count multiplied by stroke count. Smoothing also visits bounded triangle adjacency. These limits bound inputs and work, not total browser memory. Exact-position maps, neighbor sets and normal reconstruction require additional temporary memory.

Nonfinite data and newly collapsed triangles throw. Strong strokes can still fold or intersect surfaces. Sculpting does not detect those intersections, remesh, perform Boolean operations, update rig weights or provide a viewport brush editor.

Renderer geometry buffers remain static. Rebuilding this mesh every animation frame causes CPU work and new GPU uploads. Compatible relative targets can instead be constructed once and animated through [morph poses](./morph-targets.md).

The brush model follows the normal displacement and neighborhood smoothing described in the [Blender sculpting manual](https://docs.blender.org/manual/en/latest/sculpt_paint/sculpting/index.html). This API is a bounded code tool, not Blender feature parity.
