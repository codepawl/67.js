# Primitive shape and resource bounds

Available from version `0.4.0`.

```js
import { box, sphere, cylinder, torus } from '@codepawlhq/crucible';

const shell = box(0.15, 7);
const eye = sphere(64, 40);
const wheel = cylinder(80, 0.025, 6);
const rim = torus(0.045, 96, 24);
```

All generators return local Float32 positions and unit normals with Uint32 triangle indices. Use part matrices to position and scale instances.

| Constructor | Shape | Input bounds |
| --- | --- | --- |
| `box(bevel = 0.08, subdivisions = 6)` | Cube with each axis from -0.5 to 0.5. | Bevel from 0 to 0.5. Subdivisions from 1 to 128. |
| `sphere(segments = 64, rings = 40)` | Unit-radius sphere. | Segments from 3 to 2048. Rings from 2 to 2048. |
| `cylinder(segments = 80, bevel = 0.025, bevelSegments = 6)` | Y-axis cylinder with radius 1 and height 1. | Segments from 3 to 2048. Bevel from 0 to 0.5. Bevel segments from 1 to 128. |
| `torus(tubeRadius = 0.08, segments = 96, sides = 24, arc = 2π, start = 0)` | XY torus with major radius 1. Partial arcs have end caps. | Positive tube radius. Segments from 3 to 2048. Sides from 3 to 128. Arc within (0, 2π]. Start uses radians. |

Counts must be integers. Numeric parameters must remain finite in Float32. Positive tube radius and arc cannot underflow to zero. Positive bevel values also reject Float32 underflow.

Each constructor checks its vertex reservation before sampling, with a fixed limit of one million vertices. This prevents uncontrolled loops and allocations from malformed detail counts. Temporary JavaScript arrays, indices and renderer allocations require additional memory. The limit does not guarantee a total browser memory ceiling.

## Closed seams

Full turns sample their final position at the same angle as the first position. Sphere poles have exactly zero radial coordinates. This removes tiny trigonometric gaps at duplicated seam vertices while retaining separate UV coordinates.

Exact Float32 position welding finds paired, oppositely oriented edges on the tested sphere, torus, cylinder and rounded-box fixtures. The legacy rounded-coordinate topology check remains covered separately.

The seam fix changes 884 position or normal components in the WALL·E fixture by at most `2.56e-16`. Triangle indices and instance matrices remain unchanged. Native GPU images at 960 × 540 and 540 × 960 have identical pixels before and after the change.

`scripts/smoke-primitive-seams.mjs` rebuilds its baseline from Git commit `61a0102` and requires that commit in local history. Its images and measurements go to `artifacts/`.

## Geometry limits

High sampling density cannot recover details smaller than local Float32 precision. Keep geometry near its origin and apply world placement through matrices.

Primitive construction does not perform Boolean operations, sculpting, collision resolution or general manifold certification. Large torus tube radii can create self-intersections. Thin partial arcs or extreme proportions need validation before use as solids.
