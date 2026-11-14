# Fit a patch to a curved surface

Available from version `0.4.0`. The optional addon has its own decal clipper, which follows Three.js DecalGeometry, and imports no Three.js code.

```js
import { sphere } from '@codepawlhq/crucible';
import { createSurfacePatch } from '@codepawlhq/crucible/addons/surface';

const target = {
  name: 'Shell',
  geometry: sphere(64, 40),
  matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  material: { color: [0.03, 0.2, 0.3], metallic: 0.2, roughness: 0.4 },
};
const badge = {
  name: 'Badge',
  geometry: createSurfacePatch(target, {
    position: [0, 0, 0.9], size: [0.6, 0.4, 0.4], clearance: 0.001,
  }),
  matrix: target.matrix,
  material: { color: [1, 0.2, 0.02], metallic: 0, roughness: 0.5 },
};
// Pass [target, badge] to CrucibleRenderer.
// Mutate the retained target.matrix, then call renderer.updateParts([target, badge]).
```

The projector clips target triangles into a standalone patch that follows their curved shape. It generates new projector UVs and normalized interpolated normals. Original RGB colors, UVs, maps and materials are not copied. The patch uses its own material.

Sharing the retained matrix keeps both objects together through rigid translation, rotation, affine scale and shear. Replacing only the target matrix breaks that relationship. Reflection also follows the renderer's existing winding behavior.

## Projector and clearance

`createSurfacePatch(targetPart, options)` uses target-local coordinates for every option.

| Option | Default | Meaning |
| --- | --- | --- |
| `position` | `[0, 0, 0]` | Center of the clipping box. |
| `rotation` | `[0, 0, 0]` | XYZ Euler radians. Projector +Z faces outward from the target. |
| `size` | `[1, 1, 1]` | Positive width, height and depth of the clipping box. |
| `clearance` | `0.001` | Nonnegative local offset along interpolated surface normals. |
| `maxAngle` | `Math.PI / 2` | Maximum angle between geometric face normal and projector +Z. Must exceed zero. |
| `maxVertices` | `250000` | Conservative clipping reservation and output vertex cap. |
| `maxTriangles` | `250000` | Input triangle cap. |

Back-facing triangles are excluded. A deep projector can still include several outward-facing layers. A narrow depth and angle select the intended surface. Projectors crossing sharp corners can distort UVs.

Positive clearance moves the patch away from the target, preventing coplanar depth competition in this workflow. Zero clearance deliberately creates a coplanar patch and can produce z-fighting. Constant local clearance does not produce a constant world gap under nonuniform scale.

The addon checks the rounded displacement against each unoffset clipped Float32 triangle. Vanishing geometric gaps, reversed output winding and entirely collapsed output throw. This checks local patch construction, not collision against other scene objects. Three.js clipping rounds the original positions to Float32, so correspondence with authored triangles has finite precision.

## Resource bounds and animation

The input requires finite indexed Float32 positions, unit normals and Uint32 triangle indices. `maxTriangles` bounds input scans. Projector bounds and facing checks reduce candidates before clipping. Conservative allocation reservations can reject a patch with a smaller final output. A smaller projector or larger `maxVertices` cap allows more projections.

Clipping runs during scene construction. The patch is reused each frame, without repeating clipping or allocating new geometry. It follows rigid transforms through the shared matrix. The addon does not provide BVH queries or a total-memory guarantee.

Skin, morph, assembly and procedural target materials reject explicitly. Their visible surfaces differ from the static target geometry. Rebuild the patch after static sculpting, before uploading the new scene. Animated deformation needs a posed surface evaluator and attachment binding, which remain unfinished.

## Three different overlap problems

| Problem | Required response |
| --- | --- |
| Nearly coplanar surfaces flicker | Geometric clearance or scoped render depth bias. This addon supplies geometric clearance. |
| A rigid accessory intersects a curved shell | Adjust the contact transform or deform its footprint. A flat rigid panel cannot fit an arbitrary curved surface completely. |
| Two closed meshes penetrate or one contains the other | Mesh collision queries and resolution. This addon does not detect these cases. |

Antialiasing, material colors and shadow bias do not repair mesh penetration. This patch is a surface overlay, not a whole-object shrinkwrap modifier.

The source [shrinkwrap addon](shrinkwrap.md) moves existing mesh vertices while retaining topology and UVs.
Use [mesh queries](mesh-query.md) to check actual triangle contact or validated solid containment.
Neither tool automatically resolves collisions or binds to an animated skin.

The implementation follows the maintained [Three.js decal API](https://threejs.org/docs/pages/DecalGeometry.html). The distinction between render depth bias and geometry placement also appears in [Three.js material documentation](https://threejs.org/docs/pages/Material.html).
